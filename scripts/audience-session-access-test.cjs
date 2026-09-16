#!/usr/bin/env node
/* Audience → session access test.
 *
 * The bug: a card addressed by AUDIENCE (an agent's `ask`/`notify` to a named teammate) was routed to
 * that member by `canViewMessageRow`, but the SESSION behind it was authorised by `canViewRow`, which
 * knew only run_as / spawned_by / own-automation. So a member could see the card and not the run —
 * clicking it opened a BLANK session. Owners/admins never saw it, which is why it went unnoticed.
 *
 * What this pins down:
 *   - the addressed member can READ the run (list row, chain, transcript gate) — the actual fix;
 *   - and still cannot ACT on it: attach, type, fork, stop stay on the narrow rule (canOperateSession);
 *   - CARD visibility is unchanged — being addressed on one card does not reveal the session's others;
 *   - an unrelated member gains nothing, and owner/admin behaviour is untouched;
 *   - a role-derived audience (approvers/admins) grants a plain member nothing;
 *   - the feed agrees with the session rule (list rows + the needsYou counters);
 *   - a card pointing at a session row that no longer exists grants nothing.
 * Isolated home; pure over the DB (no tmux, no claude). */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-audience-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));

const mkMember = (email, role) => {
  const { member } = aos.team.invite({ email, role });
  aos.db.prepare("UPDATE members SET status='active' WHERE id=?").run(member.id);
  return aos.team.getMember(member.id);
};
const owner = mkMember('owner@testco.dev', 'owner');
const kriti = mkMember('kriti@testco.dev', 'member');   // the addressed member
const dan = mkMember('dan@testco.dev', 'member');       // no relationship to the run

// The triage automation: created by the owner, runs as the COMPANY identity (run_as NULL) — exactly the
// shape in the report, where all three of the old branches are false for the addressed member.
aos.db.prepare(
  "INSERT INTO automations (id,agent_id,name,type,task,enabled,created_by,created_at) VALUES ('au1','support','Inbound ticket triage','cron','triage',1,?,?)",
).run(owner.id, Date.now());

const T0 = Date.now() - 3_600_000;
let n = 0;
const mkRun = (o = {}) => {
  const id = 'ts_' + (++n);
  const cols = {
    id, agent: 'support', title: 'Triage', task: 'triage the desk', tmux: 'aos-' + id, status: 'running',
    spawned_by: 'automation:au1', run_as: null, claude_session_id: 'cs_' + id, archived_at: null,
    created_at: T0 + n * 60_000, updated_at: T0 + n * 60_000, ...o,
  };
  aos.db.prepare(`INSERT INTO term_sessions
      (id,agent,title,task,tmux,status,spawned_by,run_as,claude_session_id,archived_at,created_at,updated_at)
      VALUES (@id,@agent,@title,@task,@tmux,@status,@spawned_by,@run_as,@claude_session_id,@archived_at,@created_at,@updated_at)`).run(cols);
  return id;
};
let m = 0;
const mkCard = (sessionId, o = {}) => {
  const id = 'msg_' + (++m);
  aos.db.prepare(
    `INSERT INTO messages (id,type,session_id,agent,title,body,status,audience_kind,audience_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, o.type ?? 'question', sessionId, 'support', o.title ?? 'Approve this draft?', o.body ?? '…',
        o.status ?? 'open', o.audienceKind ?? 'member', o.audienceId ?? kriti.id, T0 + m * 1000);
  return id;
};

// ── the reported case ───────────────────────────────────────────────────────────
const triage = mkRun();
mkCard(triage);

// The COUNTERS first, before anything walks the session list: `listSessions` reaps a running row whose
// tmux pane isn't alive, and a crashed row would make the `running` count untestable for the wrong reason.
aos.db.prepare(
  "INSERT INTO questions (id,run_id,tenant,agent,prompt,status,created_at) VALUES ('q1',?,?,'support','Approve?','pending',?)",
).run(triage, aos.tenant, T0);
console.log('\nthe feed counters agree with the session rule');
const kCounts = aos.feed.counts({ id: kriti.id, isAdmin: false }, T0);
const dCounts = aos.feed.counts({ id: dan.id, isAdmin: false }, T0);
assert(kCounts.needsYou === 1, 'the pending question on that run lands in her needsYou count', `got ${kCounts.needsYou}`);
assert(kCounts.running === 1, 'and the live run shows in her running count', `got ${kCounts.running}`);
assert(dCounts.needsYou === 0 && dCounts.running === 0, "an unrelated member's counters are untouched", JSON.stringify(dCounts));

console.log('\naudience → session READ access');
assert(tm.canViewSession(triage, kriti), 'the addressed member can read the session');
assert(tm.listSessions(kriti).some((s) => s.id === triage), 'and the run appears in her sessions list');
assert(tm.sessionChain(triage, kriti) !== null, 'and its chain resolves for her');
assert(tm.listMessages(kriti).some((c) => c.sessionId === triage), 'her card is still in her inbox');

console.log('\nread-only — no control of the run');
assert(!tm.canOperateSession(triage, kriti), 'she cannot attach / type / fork / stop it');
assert(tm.canOperateSession(triage, owner), 'the owner still can');

console.log('\nno widening for anyone else');
assert(!tm.canViewSession(triage, dan), 'an unrelated member still cannot read it');
assert(!tm.listSessions(dan).some((s) => s.id === triage), 'and it is absent from his list');
assert(tm.sessionChain(triage, dan) === null, 'and his chain walk refuses the seed');
assert(tm.canViewSession(triage, owner) && tm.listSessions(owner).some((s) => s.id === triage), 'owner/admin unchanged');

console.log('\ncard visibility is unchanged');
const otherCard = mkCard(triage, { audienceId: dan.id, title: "Dan's card" });
assert(!tm.listMessages(kriti, 'all').some((c) => c.id === otherCard), "the session's OTHER card stays private to its own audience");
assert(tm.listMessages(dan, 'all').some((c) => c.id === otherCard), "…and Dan does see the card addressed to him");
assert(tm.canViewSession(triage, dan), 'being addressed grants Dan the read too (same rule, not a special case)');

console.log('\nrole-derived audiences grant a member nothing');
const escalated = mkRun();
mkCard(escalated, { type: 'approval', audienceKind: 'approvers', audienceId: 'owner' });
mkCard(escalated, { type: 'update', audienceKind: 'admins', audienceId: null });
assert(!tm.canViewSession(escalated, kriti), 'an approvers/admins card does not reach a plain member');
assert(!tm.listMessages(kriti, 'all').some((c) => c.sessionId === escalated), 'nor do those cards');

console.log('\na card whose session is gone grants nothing');
const ghost = mkRun();
mkCard(ghost);
aos.db.prepare('DELETE FROM term_sessions WHERE id = ?').run(ghost);
assert(!tm.canViewSession(ghost, kriti), 'a stale session_id is not a grant');

console.log('\nthe feed list agrees with the session rule');
const feed = (member) => aos.feed.list({ viewer: { id: member.id, isAdmin: member.role !== 'member' }, limit: 100 }).items;
assert(feed(kriti).some((i) => i.runId === triage && i.kind.startsWith('session.')), "the run's own feed line reaches her");
// `question.*`, not `question.pending`: the liveness reap above ended the run and cancelled its open
// question. What matters here is that the DECISION line resolves for her at all — the counters block
// (which runs before the reaper) is what pins the pending state.
assert(feed(kriti).some((i) => i.runId === triage && i.kind.startsWith('question.')), 'as does its decision line');
assert(!feed(kriti).some((i) => i.runId === escalated), 'a run she is not addressed on stays out of her feed');

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
