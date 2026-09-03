#!/usr/bin/env node
/**
 * Composio identity + expiry test — "whose account is this, really?" and what happens when one lapses.
 *
 * Two live problems this pins:
 *  1. A company Composio connection is still SOME INDIVIDUAL's login underneath. On expresstech the
 *     company Google Sheets account resolved to a specific teammate's personal Google account, so an
 *     agent acting "as the company" created a spreadsheet in that person's Drive. Nothing recorded or
 *     displayed it — the console showed `googlesheets_seba-artal`.
 *  2. An expired connection is silent. Company ClickUp on that tenant had three expired accounts and
 *     zero live ones for two weeks; agents simply found the app missing and worked around it.
 *
 * Runs the BUILT dist/, like governance-conformance.
 *
 *   npm run build && node scripts/composio-identity-test.cjs
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
// Isolate BEFORE anything loads the kernel: a bare loadAgentOS() resolves the home to ./data — the
// LIVE default-tenant DB. AOS_NO_TTYD stops the registry spawning a browser terminal we would leak.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-composio-id-home-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;
process.on('exit', () => fs.rmSync(HOME, { recursive: true, force: true }));
const {
  accountLabel, activeToolkits, parseIdentityResults, supersededExpired, ComposioIdentityStore,
} = require(path.resolve(__dirname, '..', 'dist/connectors/composio-identity'));
const { openDb } = require(path.resolve(__dirname, '..', 'dist/state/db'));

let pass = 0;
const failures = [];
const check = (name, cond) => { if (cond) pass++; else failures.push(name); };

const conn = (userId, toolkit, status, createdAt, id) => ({
  id: id || `ca_${userId}_${toolkit}_${status}`, toolkit, status, createdAt, userId, name: `${toolkit}_word-id`,
});

// ── 1. accountLabel: read the identity a provider actually returns ───────────────────────────────
check('Google current_user_info → the email', accountLabel({ sub: '1', email: 'zubair@expresstech.io', hd: 'expresstech.io' }) === 'zubair@expresstech.io');
check('a GitHub-shaped payload → the login', accountLabel({ login: 'octocat', id: 5 }) === 'octocat');
check('Stripe → the account email before the business name', accountLabel({ id: 'acct_1', email: 'ops@x.io', business_profile: { name: 'ExpressTech' } }) === 'ops@x.io');
check('…and the business name when there is no email', accountLabel({ id: 'acct_1', business_profile: { name: 'ExpressTech Systems' } }) === 'ExpressTech Systems');
check('an unrecognised payload yields no label rather than a guess', accountLabel({ scopes: ['a'], expires_in: 3599 }) === '');
check('a non-object yields no label', accountLabel(null) === '' && accountLabel('zubair@expresstech.io') === '');

// ── 2. the probe list: NEVER a toolkit without a live account ────────────────────────────────────
// Probing one makes Composio INITIATE a connection instead of reporting its absence, which would
// litter the account with half-finished OAuth links. This is the guard that stops that.
const shelf = [
  conn('service:t', 'googlesheets', 'ACTIVE', '2026-08-05T00:00:00Z'),
  conn('service:t', 'clickup', 'EXPIRED', '2026-08-19T00:00:00Z'),
  conn('service:t', 'clickup', 'EXPIRED', '2026-07-22T00:00:00Z', 'ca_older_clickup'),
  conn('service:t', 'stripe', 'ACTIVE', '2026-09-03T00:00:00Z'),
];
const probe = activeToolkits(shelf);
check('only toolkits with a live account are probed', probe.sort().join(',') === 'googlesheets,stripe');
check('a toolkit that is ONLY expired is never probed (probing it would create a connection)', !probe.includes('clickup'));
check('duplicate toolkits collapse to one probe', activeToolkits([...shelf, conn('service:t', 'stripe', 'ACTIVE', '2026-09-01T00:00:00Z', 'ca_x')]).length === 2);

// ── 3. parsing the MANAGE_CONNECTIONS payload (the shape the live endpoint returns) ──────────────
const payload = JSON.stringify({
  data: {
    results: {
      googlesheets: {
        status: 'active', connected_account_id: 'ca_szZX1oPG4CSn',
        current_user_info: { sub: '1123', email: 'zubair@expresstech.io', hd: 'expresstech.io' },
      },
      // A toolkit with nothing connected comes back 'initiated' with an OAuth link and NO account id.
      gmail: { status: 'initiated', redirect_url: 'https://connect.composio.dev/link/lk_x' },
    },
  },
});
const parsed = parseIdentityResults(payload);
check('the company Sheets connection resolves to the individual behind it', parsed.length === 1 && parsed[0].account === 'zubair@expresstech.io');
check('…keyed by the connected-account id', parsed[0].connectionId === 'ca_szZX1oPG4CSn');
check('an "initiated" toolkit is skipped — there is no account to label', !parsed.some((p) => p.toolkit === 'gmail'));
check('garbage in → nothing out, never a throw', parseIdentityResults('not json').length === 0 && parseIdentityResults('{}').length === 0);

// ── 4. the store ─────────────────────────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-composio-id-'));
const db = openDb(path.join(dir, 'test.db'));
const store = new ComposioIdentityStore(db);
store.upsert([
  { id: 'ca_1', userId: 'service:t', toolkit: 'googlesheets', account: 'zubair@expresstech.io', status: 'ACTIVE' },
  { id: 'ca_2', userId: 'service:t', toolkit: 'clickup', status: 'EXPIRED' },
  { id: 'ca_3', userId: 'vikas@expresstech.io', toolkit: 'gmail', account: 'vikas@expresstech.io', status: 'ACTIVE' },
]);
check('an entity reads back its own connections only', store.forEntity('service:t').length === 2);
check('the resolved account is stored', store.forEntity('service:t').find((i) => i.toolkit === 'googlesheets').account === 'zubair@expresstech.io');
// A failed probe must never blank a label we already had — that is the difference between "unknown"
// and "wrong", and the whole point of the cache is that the prompt can trust it.
store.upsert([{ id: 'ca_1', userId: 'service:t', toolkit: 'googlesheets', account: '', status: 'EXPIRED' }]);
const after = store.forEntity('service:t').find((i) => i.id === 'ca_1');
check('a status-only update keeps the account label', after.account === 'zubair@expresstech.io');
check('…and does update the status', after.status === 'EXPIRED');

check('expired connections are reported for notification', store.unnotifiedExpired('service:t', 1000).length === 2);
store.markNotified(['ca_1', 'ca_2']);
check('…once, not on every launch', store.unnotifiedExpired('service:t', 7 * 24 * 3600 * 1000).length === 0);
check('…but again after the quiet period', store.unnotifiedExpired('service:t', -1).length === 2);

check('byConnection joins several entities in one read', (() => {
  const m = store.byConnection(['service:t', 'vikas@expresstech.io']);
  return m.size === 3 && m.get('ca_3').account === 'vikas@expresstech.io';
})());

store.pruneEntity('service:t', new Set(['ca_1']));
check('a connection deleted on Composio stops appearing in the cache', store.forEntity('service:t').length === 1);
check('…and other entities are untouched', store.forEntity('vikas@expresstech.io').length === 1);
db.close?.();
fs.rmSync(dir, { recursive: true, force: true });

// ── 5. what may be deleted: SUPERSEDED only ──────────────────────────────────────────────────────
const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-03T00:00:00Z');
const accounts = [
  conn('service:t', 'clickup', 'EXPIRED', '2026-07-22T00:00:00Z', 'ca_ck_old'),   // no live clickup
  conn('service:t', 'clickup', 'EXPIRED', '2026-08-19T00:00:00Z', 'ca_ck_new'),   // no live clickup
  conn('service:t', 'googlesheets', 'EXPIRED', '2026-06-01T00:00:00Z', 'ca_gs_old'),
  conn('service:t', 'googlesheets', 'ACTIVE', '2026-08-05T00:00:00Z', 'ca_gs_live'),
  conn('vikas@x.io', 'gmail', 'ACTIVE', '2026-07-15T00:00:00Z', 'ca_gm'),
];
const doomed = supersededExpired(accounts, 7 * DAY, now).map((a) => a.id);
check('a superseded expired connection is prunable', doomed.includes('ca_gs_old'));
check('an expired connection with NO live replacement is KEPT — it is the record that an app is missing',
  !doomed.includes('ca_ck_old') && !doomed.includes('ca_ck_new'));
check('a live connection is never prunable', !doomed.includes('ca_gs_live') && !doomed.includes('ca_gm'));
check('supersession is per (entity, toolkit), not per toolkit', (() => {
  // vikas's expired Sheets is NOT covered by the COMPANY's live Sheets.
  const mixed = [...accounts, conn('vikas@x.io', 'googlesheets', 'EXPIRED', '2026-06-01T00:00:00Z', 'ca_v_gs')];
  return !supersededExpired(mixed, 7 * DAY, now).some((a) => a.id === 'ca_v_gs');
})());
check('a just-superseded row is held back so a bad reconnect stays visible',
  !supersededExpired(accounts, 3650 * DAY, now).some((a) => a.id === 'ca_gs_old'));
check('an unparseable created_at does not silently disable the sweep',
  supersededExpired([conn('service:t', 'googlesheets', 'EXPIRED', '', 'ca_nodate'), accounts[3]], 7 * DAY, now)
    .some((a) => a.id === 'ca_nodate'));

// ── 6. the prompt: an agent must be told whose account each namespace holds ──────────────────────
// Without this the agent sees two lookalike MCP servers, `composio` and `composio-company`, and the
// Tool Router picks tools by relevance — so the choice of IDENTITY is made by ranking, not intent.
const { loadAgentOS } = require(path.resolve(__dirname, '..', 'dist/kernel.js'));
const { TerminalManager } = require(path.resolve(__dirname, '..', 'dist/terminal.js'));
const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
aos.settings.setComposioApiKey('test-key', 'owner@testco');
aos.team.bootstrapOwner('owner@testco.example', 'Owner');
const owner = aos.team.listMembers()[0];
aos.composioIdentities.upsert([
  { id: 'ca_c1', userId: `service:${aos.tenant}`, toolkit: 'googlesheets', account: 'zubair@expresstech.io', status: 'ACTIVE' },
  { id: 'ca_c2', userId: `service:${aos.tenant}`, toolkit: 'clickup', account: 'ops@expresstech.io', status: 'EXPIRED' },
  { id: 'ca_p1', userId: owner.email, toolkit: 'gmail', account: owner.email, status: 'ACTIVE' },
]);
const prompt = tm.buildCompanyMd('some-agent', owner.id, false, '');
check('the prompt names both namespaces', /`composio`/.test(prompt) && /`composio-company`/.test(prompt));
check('the COMPANY sheet names the individual actually behind it', /googlesheets — zubair@expresstech\.io/.test(prompt));
check('the personal namespace names the run-as member', new RegExp(`gmail — ${owner.email.replace('.', '\\.')}`).test(prompt));
check('an EXPIRED connection is not advertised as available', !/clickup/.test(prompt));
check('the agent is told to stop and ask when the acting account is wrong', /stop\s+and `ask`/.test(prompt));
// No key ⇒ no section at all, rather than an empty heading in every prompt on every tenant that has
// never wired Composio.
aos.settings.setComposioApiKey('', 'owner@testco');
check('a workspace with no Composio key gets no section', !/whose account you are about to act as/i.test(tm.buildCompanyMd('some-agent', owner.id, false, '')));

const total = pass + failures.length;
if (failures.length) {
  console.error(`\nCOMPOSIO IDENTITY: ${pass}/${total} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`COMPOSIO IDENTITY: ${pass}/${total} passed ✓`);
