#!/usr/bin/env node
/*
 * Email identity guard — a company MAILBOX is not automatically the wrong sender.
 *
 * `emailIdentityDenial` exists to stop ONE thing: an agent acting as one person sending mail the world
 * reads as coming from ANOTHER named person (the incident behind `composio-identity.ts` — a "company"
 * Google connection that was really one teammate's personal account).
 *
 * Its first version enforced that by NAMESPACE: any member-scoped run touching `composio-company` email
 * was denied. That conflates a SHELF with a MAILBOX. A shared role mailbox (`sales@`, `support@`)
 * connected at the company level is a legitimate identity members are meant to send from, and the guard
 * refused it unconditionally — internal mail between teammates included, owner-run sessions included,
 * while its message claimed a precondition ("the run-as member has no Gmail connected") it never
 * checked. It was dormant until v0.420.0 started classifying Composio actions as `email.send`, then
 * broke every company-account send in a live tenant at once.
 *
 * This pins the behaviour that replaced it: deny on EVIDENCE (the company email account IS another
 * member's mailbox), fall through otherwise and let the `email.send` policy — which already asks a
 * human for every external recipient — do the governing.
 *
 * Usage:  npm run build && node scripts/email-identity-guard-test.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-emailid-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { fail++; console.log(`  \x1b[31m✗ ${n}\x1b[0m${d ? `\n      ${d}` : ''}`); };
const assert = (c, n, d) => (c ? ok(n) : bad(n, d));

async function main() {
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
  const { serviceUserId } = require(path.join(ROOT, 'dist/connectors/composio.js'));

  const registry = new TenantRegistry(ROOT, 0);
  registry.bootAll();
  const osx = registry.get('testco').os;
  const tm = new TerminalManager(osx, 'http://127.0.0.1:1', path.join(HOME, 'tmux.sock'));
  const db = osx.db;

  const mk = (email, role) => osx.team.acceptToken(osx.team.invite({ email, role }).token).member;
  const rohan = mk('rohan@testco.example', 'owner');
  const neha = mk('neha@testco.example', 'admin');

  // Two sessions: one acting as a member, one company/automation (no run_as).
  const mkSession = (id, runAs) => db.prepare(
    'INSERT INTO term_sessions (id, agent, title, task, tmux, status, spawned_by, run_as, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'outreach', id, '', id, 'running', runAs, runAs, 's', Date.now(), Date.now());
  mkSession('sess_member', rohan.id);
  mkSession('sess_company', null);

  // The gate calls this AFTER the Composio envelope is unwrapped, so `tool` is the real action slug,
  // still carrying its server prefix. The toolkit is read off that slug.
  const COMPANY = 'mcp__composio-company__GMAIL_SEND_EMAIL';
  const PERSONAL = 'mcp__composio__GMAIL_SEND_EMAIL';
  const deny = (sess, tool) => tm.emailIdentityDenial(sess, { tool });
  const entity = serviceUserId('testco');
  const upsert = (id, toolkit, account, status = 'ACTIVE') =>
    osx.composioIdentities.upsert([{ id, userId: entity, toolkit, account, status }]);
  const setCompanyGmail = (account, status = 'ACTIVE') => upsert('ca_co_gmail', 'gmail', account, status);

  // ─── 1) The regression: a shared role mailbox must not be denied ───────────
  console.log('\n\x1b[1m1) A company role mailbox is a legitimate sender\x1b[0m');
  setCompanyGmail('');   // unresolved — the live state when this broke
  assert(deny('sess_member', COMPANY) === null, 'unresolved company account → no denial (we do not know, so we do not convict)');
  // Pin the empty-label guard for real: a sibling row that DOES convict proves the loop is running and
  // reaching the blank one, so deleting `if (!account …)` cannot pass this by accident.
  upsert('ca_co_gmail2', 'gmail', 'neha@testco.example');
  assert(typeof deny('sess_member', COMPANY) === 'string', '…and a resolved sibling on the same toolkit still convicts (the loop really runs)');
  osx.composioIdentities.upsert([{ id: 'ca_co_gmail2', userId: entity, toolkit: 'gmail', account: 'neha@testco.example', status: 'INACTIVE' }]);
  setCompanyGmail('sales@testco.example');
  assert(deny('sess_member', COMPANY) === null, 'company account is a role mailbox nobody owns → no denial');
  assert(deny('sess_company', COMPANY) === null, 'automation run (no run_as) → no denial');
  assert(deny('sess_member', PERSONAL) === null, "the member's own namespace → never in scope");

  // ─── 2) The harm it exists for is still caught ─────────────────────────────
  console.log('\n\x1b[1m2) A teammate\x27s own mailbox on the company shelf still denies\x1b[0m');
  setCompanyGmail('neha@testco.example');
  const d = deny('sess_member', COMPANY);
  assert(typeof d === 'string' && d.includes('neha@testco.example'), 'denied, and the reason names the account that would appear as sender', String(d));
  assert(typeof d === 'string' && d.includes(rohan.email), 'the reason also names who the run actually acts as', String(d));
  assert(deny('sess_company', COMPANY) === null, 'a company/automation run is still allowed — it IS the company identity');

  // The run-as member's OWN mailbox on the company shelf is not misattribution.
  setCompanyGmail('rohan@testco.example');
  assert(deny('sess_member', COMPANY) === null, "company account == the run-as member's own mailbox → no denial");

  // Only an ACTIVE connection can convict.
  setCompanyGmail('neha@testco.example', 'EXPIRED');
  assert(deny('sess_member', COMPANY) === null, 'an EXPIRED connection cannot convict (it is not what would send)');

  // A non-email toolkit on the company shelf is irrelevant to who sends mail.
  upsert('ca_co_sheets', 'googlesheets', 'neha@testco.example');
  assert(deny('sess_member', COMPANY) === null, "a teammate's Sheets connection does not block email");

  // ─── 3) It convicts on the account that would ACTUALLY send ────────────────
  console.log('\n\x1b[1m3) The right connection, not just any email connection\x1b[0m');
  setCompanyGmail('sales@testco.example');                       // role mailbox on gmail
  upsert('ca_co_outlook', 'outlook', 'neha@testco.example');     // a member's mailbox on ANOTHER toolkit
  assert(deny('sess_member', COMPANY) === null, 'a GMAIL send is not blocked by a teammate on OUTLOOK');
  assert(typeof deny('sess_member', 'mcp__composio-company__OUTLOOK_SEND_EMAIL') === 'string', '…and the OUTLOOK send through the same shelf IS blocked');
  // Longest-prefix match: `microsoft_outlook_…` must not resolve to a `microsoft` toolkit.
  upsert('ca_co_ms', 'microsoft', 'neha@testco.example');
  upsert('ca_co_msout', 'microsoft_outlook', 'support@testco.example');
  assert(deny('sess_member', 'mcp__composio-company__MICROSOFT_OUTLOOK_SEND_EMAIL') === null, 'the longest matching toolkit wins (microsoft_outlook, not microsoft)');
  for (const id of ['ca_co_outlook', 'ca_co_ms', 'ca_co_msout']) osx.composioIdentities.upsert([{ id, userId: entity, toolkit: 'x', account: '', status: 'INACTIVE' }]);
  // A toolkit we cannot resolve from the action slug means we cannot say what would send.
  assert(deny('sess_member', 'mcp__composio-company__SOMETHING_SEND_EMAIL') === null, 'an unresolvable toolkit → no conviction on a guess');

  // ─── 4) A CLAIMED connection is already walled off, so it must not convict ──
  console.log('\n\x1b[1m4) A claim is the fix, not a reason to deny\x1b[0m');
  setCompanyGmail('neha@testco.example');
  assert(typeof deny('sess_member', COMPANY) === 'string', "precondition: neha's mailbox on the company gmail denies");
  osx.composioClaims.claim({ id: 'ca_co_gmail', toolkit: 'gmail', userId: entity, memberId: neha.id, account: 'neha@testco.example', claimedBy: 'owner@testco.example' });
  assert(deny('sess_member', COMPANY) === null, "claimed for neha → unreachable from rohan's run, so no denial");
  osx.composioClaims.release('ca_co_gmail');

  // ─── 5) An `invited` alias row is not a person ─────────────────────────────
  console.log('\n\x1b[1m5) A shared alias added to the console is not a teammate\x1b[0m');
  osx.team.invite({ email: 'sales@testco.example', role: 'member' });   // invited, never accepted
  setCompanyGmail('sales@testco.example');
  assert(deny('sess_member', COMPANY) === null, 'a role mailbox that also has an INVITED member row → still no denial');

  console.log(`\n${fail === 0 ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m  ${pass} passed, ${fail} failed`);
  registry.stopAll?.();
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
