#!/usr/bin/env node
/*
 * Run-as identity conformance test — `term_sessions.run_as` holds a MEMBER id, never provenance.
 *
 * `spawned_by` is PROVENANCE (a bare member id OR a prefixed system trigger: `automation:` / `task:` /
 * `chat:` / `poke:` / `ask:` / `goal:`); `run_as` is IDENTITY (the accountable human). The old
 * createSession fallback took ANY non-`automation:` provenance as the identity, so a chat-routed or
 * ownerless-task run stored `run_as = 'chat:triage'` / `'task:<id>'` — a value no consumer can match.
 * Measured on the live globex tenant (2026-08-04): 23 such rows. The cost is silent: that run loses the
 * member's GitHub token (its PRs land as the App bot), Composio/connector identity, member-scoped secret
 * resolution, and inbox ownership — with no error anywhere.
 *
 * Covers, fully isolated (scratch AGENT_OS_HOME — see the CLAUDE.md warning about polluting ./data):
 *   1. resolveActingMember: every provenance prefix falls back to NO identity; a bare member id (or an
 *      email) resolves to the canonical member id; an explicit runAs wins over provenance.
 *   2. The consequence at launch: a prefixed-provenance run gets the company-bot GH_TOKEN untouched
 *      rather than a garbage principal — and the same run with a real run-as member gets THEIR token.
 *   3. The one-time migration NULLs colon-bearing run_as rows already on disk, and leaves member ids.
 *
 * Usage:  npm run build && node scripts/run-as-identity-test.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-runas-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY; // keep the vault master key inside the scratch home

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { fail++; console.log(`  \x1b[31m✗ ${n}\x1b[0m${d ? `\n      ${d}` : ''}`); };
const assert = (c, n, d) => (c ? ok(n) : bad(n, d));

async function main() {
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
  const { GithubIdentity } = require(path.join(ROOT, 'dist/edge/github-identity.js'));

  const registry = new TenantRegistry(ROOT, 0);
  registry.bootAll();
  const osx = registry.get('testco').os;
  const tm = new TerminalManager(osx, 'http://127.0.0.1:1', path.join(HOME, 'tmux.sock'));

  const inv = osx.team.invite({ email: 'owner@test', role: 'owner' });
  const memberId = osx.team.acceptToken(inv.token).member.id;

  // ─── 1) resolveActingMember ────────────────────────────────────────────────
  console.log('\n\x1b[1m1) resolveActingMember (provenance never becomes identity)\x1b[0m');
  const R = (runAs, spawnedBy) => tm.resolveActingMember(runAs, spawnedBy);

  // Every prefixed provenance kind — the blocklist this replaces only excluded `automation:`.
  for (const prov of ['automation:a1', 'task:tsk_abc', 'chat:triage', 'poke:tsk_x', 'ask:coder', 'goal:g1']) {
    assert(R(undefined, prov) === undefined, `provenance "${prov}" → no run-as identity`);
  }
  assert(R(undefined, memberId) === memberId, 'bare member-id provenance → that member (console spawn)');
  assert(R(undefined, 'm_deleted_or_typo') === undefined, 'a member id that no longer exists → no identity');
  assert(R(undefined, undefined) === undefined, 'no provenance at all → no identity');

  // Explicit runAs wins, and is canonicalised.
  assert(R(memberId, 'task:tsk_abc') === memberId, 'explicit runAs wins over prefixed provenance');
  assert(R('owner@test', 'chat:triage') === memberId, 'an email runAs is canonicalised to the member id');
  assert(R('  ' + memberId + '  ', undefined) === memberId, 'runAs is trimmed before resolving');
  assert(R('nobody@nowhere', memberId) === memberId, 'an unresolvable runAs falls back to a real provenance member');
  assert(R('nobody@nowhere', 'chat:triage') === undefined, 'neither resolvable → no identity (company run)');

  // ─── 2) What that costs at launch ──────────────────────────────────────────
  console.log('\n\x1b[1m2) Launch consequence (GH_TOKEN authorship)\x1b[0m');
  const gid = new GithubIdentity(osx);
  gid.save(memberId, { token: 'gho_member', login: 'octocat', connectedAt: Date.now() });

  const envChat = { GH_TOKEN: 'ghs_BOT' };
  tm.injectMemberGithub(envChat, 'triage', R(undefined, 'chat:triage'), 'sessChat');
  assert(envChat.GH_TOKEN === 'ghs_BOT', 'chat-provenance run keeps the company-bot token (no garbage principal)');

  const envMember = { GH_TOKEN: 'ghs_BOT' };
  tm.injectMemberGithub(envMember, 'triage', R(memberId, 'chat:triage'), 'sessMember');
  assert(envMember.GH_TOKEN === 'gho_member', 'same run WITH a resolved run-as member is authored as the human');

  // The pre-fix value would have been the provenance string itself — assert it resolves to nothing.
  const envBug = { GH_TOKEN: 'ghs_BOT' };
  tm.injectMemberGithub(envBug, 'triage', 'chat:triage', 'sessBug');
  assert(envBug.GH_TOKEN === 'ghs_BOT', 'a raw provenance string as run-as matches no member (the silent old cost)');
  gid.clear(memberId);

  // ─── 3) Migration cleans rows already on disk ──────────────────────────────
  console.log('\n\x1b[1m3) Migration (existing polluted rows)\x1b[0m');
  const db = osx.db;
  const row = (id, spawnedBy, runAs) => db.prepare(
    'INSERT INTO term_sessions (id, agent, title, task, tmux, status, spawned_by, run_as, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(id, 'triage', 't', 't', 'x-' + id, 'done', spawnedBy, runAs, Date.now(), Date.now());
  row('s_chat', 'chat:triage', 'chat:triage');
  row('s_task', 'task:tsk_1', 'task:tsk_1');
  row('s_ok', memberId, memberId);
  row('s_null', 'automation:a1', null);

  const { openDb } = require(path.join(ROOT, 'dist/state/db.js'));
  openDb(path.join(HOME, 'agent-os.db')); // re-runs migrate() over the same file

  const runAsOf = (id) => db.prepare('SELECT run_as FROM term_sessions WHERE id = ?').get(id).run_as;
  assert(runAsOf('s_chat') === null, 'migration NULLs a `chat:` run_as');
  assert(runAsOf('s_task') === null, 'migration NULLs a `task:` run_as');
  assert(runAsOf('s_ok') === memberId, 'migration LEAVES a real member id alone');
  assert(runAsOf('s_null') === null, 'an already-NULL run_as stays NULL');
  assert(db.prepare('SELECT spawned_by FROM term_sessions WHERE id = ?').get('s_chat').spawned_by === 'chat:triage',
    'provenance (spawned_by) is untouched — only the identity column is cleaned');

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
