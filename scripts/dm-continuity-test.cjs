#!/usr/bin/env node
/* DM continuity test — a reply to a DM the OS sent someone ABOUT a run goes back INTO that run
 * (session_dms → TerminalManager.sessionForDm → Automations.continueSessionDm), and every guard that
 * must keep it from claiming a DM it has no business claiming: the staleness window, archived and
 * unresumable rows, an unmapped sender, a viewer who can't see the run, and an explicit /agent redirect.
 * Isolated home; deliver/revive stubbed so no real tmux or claude is needed. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-dm-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const autos = new Automations(aos, tm);

// The two ends of the continuation, stubbed: `live` decides whether a session answers to send-keys,
// `resumable` whether it can be revived. The real ones need tmux + a claude transcript.
let live = new Set(), resumable = new Set();
const delivered = [], revived = [];
tm.deliverToResident = (id, text) => live.has(id) ? (delivered.push({ id, text }), true) : false;
tm.reviveResident = (id, text, runAs) => resumable.has(id) ? (revived.push({ id, text, runAs }), true) : false;

const HOUR = 3600_000;
const mkMember = (email, role) => {
  const { member } = aos.team.invite({ email, role });
  aos.db.prepare("UPDATE members SET status='active' WHERE id=?").run(member.id);
  return aos.team.getMember(member.id);
};
const owner = mkMember('owner@testco.dev', 'owner');
const alice = mkMember('alice@testco.dev', 'member');   // plain member: sees only her own runs
const bob = mkMember('bob@testco.dev', 'member');
aos.team.setIdentity(alice.id, 'slack', 'U_ALICE');
aos.team.setIdentity(bob.id, 'slack', 'U_BOB');
aos.team.setIdentity(owner.id, 'discord', 'D_OWNER');

let n = 0;
const mkSession = (o = {}) => {
  const id = 'ts_' + (++n);
  const cols = {
    id, agent: 'engineer', title: 't', task: 'x', tmux: 'aos-' + id, status: 'running',
    spawned_by: alice.id, run_as: alice.id, claude_session_id: 'cs_' + id, archived_at: null,
    created_at: Date.now(), updated_at: Date.now(), ...o,
  };
  aos.db.prepare('INSERT INTO term_sessions (id,agent,title,task,tmux,status,spawned_by,run_as,claude_session_id,archived_at,created_at,updated_at) VALUES (@id,@agent,@title,@task,@tmux,@status,@spawned_by,@run_as,@claude_session_id,@archived_at,@created_at,@updated_at)').run(cols);
  return id;
};
// Backdate a binding so the staleness window can be exercised without waiting a day.
const ageBinding = (sessionId, ms) =>
  aos.db.prepare('UPDATE session_dms SET created_at = ? WHERE session_id = ?').run(Date.now() - ms, sessionId);

console.log('\n\x1b[1m1) bindSessionDm → sessionForDm\x1b[0m');
const s1 = mkSession();
tm.bindSessionDm(s1, 'slack', 'U_ALICE', alice.id);
const found = tm.sessionForDm('slack', 'U_ALICE');
assert(found && found.sessionId === s1, 'the run we DM\'d her about is what her DM resolves to');
assert(found && found.agent === 'engineer' && found.claudeSessionId === 'cs_' + s1, 'carries agent + pinned claude id (needed to --resume)');
assert(tm.sessionForDm('slack', 'U_BOB') === undefined, 'a DM from someone we never pinged claims nothing');
assert(tm.sessionForDm('discord', 'U_ALICE') === undefined, 'the binding is per-provider (slack id ≠ discord id)');
assert(tm.sessionForDm('slack', '') === undefined, 'empty sender id → nothing');

console.log('\n\x1b[1m2) newest binding wins\x1b[0m');
const s2 = mkSession();
tm.bindSessionDm(s2, 'slack', 'U_ALICE', alice.id);
ageBinding(s1, 2 * HOUR);
assert(tm.sessionForDm('slack', 'U_ALICE').sessionId === s2, 'two runs pinged her → the most recent one');
// Re-pinging about the older run re-arms it: each new notice makes that run the live conversation again.
tm.bindSessionDm(s1, 'slack', 'U_ALICE', alice.id);
assert(tm.sessionForDm('slack', 'U_ALICE').sessionId === s1, 're-binding the older run makes it current again');

console.log('\n\x1b[1m3) the staleness window (24h)\x1b[0m');
ageBinding(s1, 23 * HOUR); ageBinding(s2, 30 * HOUR);
assert(tm.sessionForDm('slack', 'U_ALICE').sessionId === s1, '23h old → still the live conversation');
ageBinding(s1, 25 * HOUR);
assert(tm.sessionForDm('slack', 'U_ALICE') === undefined, 'every binding stale → an out-of-the-blue DM belongs to the router');

console.log('\n\x1b[1m4) rows that must not be continued\x1b[0m');
const archived = mkSession({ archived_at: Date.now() });
tm.bindSessionDm(archived, 'slack', 'U_BOB', bob.id);
assert(tm.sessionForDm('slack', 'U_BOB') === undefined, 'archived run → filed away, not a live conversation');
const unresumable = mkSession({ claude_session_id: null });
tm.bindSessionDm(unresumable, 'slack', 'U_BOB', bob.id);
assert(tm.sessionForDm('slack', 'U_BOB') === undefined, 'no pinned claude id → unresumable, let the router spawn fresh');

console.log('\n\x1b[1m5) visibility is re-checked on the way back in\x1b[0m');
const hers = mkSession({ spawned_by: alice.id, run_as: alice.id });
tm.bindSessionDm(hers, 'slack', 'U_BOB', bob.id);   // bob was DM'd about a run that is NOT his
assert(tm.sessionForDm('slack', 'U_BOB') === undefined, 'a member who cannot view the run does not get to steer it');
const ownersView = mkSession({ spawned_by: alice.id, run_as: alice.id });
tm.bindSessionDm(ownersView, 'discord', 'D_OWNER', owner.id);
assert(tm.sessionForDm('discord', 'D_OWNER').sessionId === ownersView, 'an owner sees every run, so their reply lands');
const unlinked = mkSession();
tm.bindSessionDm(unlinked, 'slack', 'U_GHOST', 'm_gone');
assert(tm.sessionForDm('slack', 'U_GHOST') === undefined, 'sender no longer maps to a member (left the team) → nothing');

console.log('\n\x1b[1m6) continueSessionDm — delivered / revived / none\x1b[0m');
const warm = mkSession();
tm.bindSessionDm(warm, 'slack', 'U_ALICE', alice.id);
live.add(warm);
let r = autos.continueSessionDm('slack', 'U_ALICE', { actorLabel: 'Alice', text: 'go with the page-load claim', channel: 'D123' }, alice.id);
assert(r.status === 'delivered' && r.sessionId === warm, 'live run → typed straight into it');
assert(r.agent === 'engineer', 'reports the agent, so the socket can ack by name');
assert(delivered.length === 1 && delivered[0].text === 'go with the page-load claim', 'the human\'s words reach the agent verbatim');

const cold = mkSession();
tm.bindSessionDm(cold, 'slack', 'U_ALICE', alice.id);
resumable.add(cold);
r = autos.continueSessionDm('slack', 'U_ALICE', { actorLabel: 'Alice', text: 'retry it', channel: 'D123' }, alice.id);
assert(r.status === 'revived' && r.sessionId === cold, 'ended run → revived on the SAME transcript');
assert(revived.length === 1 && revived[0].runAs === alice.id, 'the replying human is the accountable identity for the turn');

const dead = mkSession();
tm.bindSessionDm(dead, 'slack', 'U_ALICE', alice.id);
r = autos.continueSessionDm('slack', 'U_ALICE', { actorLabel: 'Alice', text: 'hello?', channel: 'D123' }, alice.id);
assert(r.status === 'none', 'neither live nor revivable → falls through to the router');

console.log('\n\x1b[1m7) an explicit /agent redirect is not a continuation\x1b[0m');
// The redirect only fires for a REAL agent (`os.agents` is the roster Map) — a stray "/foo" is just text.
aos.agents.set('consolidator', { id: 'consolidator', name: 'Consolidator', dir: HOME, runtime: 'claude-code' });
const bound = mkSession();
tm.bindSessionDm(bound, 'slack', 'U_ALICE', alice.id);
live.add(bound);
const before = delivered.length;
r = autos.continueSessionDm('slack', 'U_ALICE', { actorLabel: 'Alice', text: '/consolidator run a pass', channel: 'D123' }, alice.id);
assert(r.status === 'none', 'naming a DIFFERENT agent starts something else — the router gets it');
assert(delivered.length === before, '…and nothing was typed into the bound run');
r = autos.continueSessionDm('slack', 'U_ALICE', { actorLabel: 'Alice', text: '   ', channel: 'D123' }, alice.id);
assert(r.status === 'none', 'an empty message is not a turn');

console.log('\n\x1b[1m8) bindReplyChannel — adopt a DM, never steal a thread\x1b[0m');
const chanOf = (id) => aos.db.prepare('SELECT channel c, thread_ts t FROM slack_threads WHERE session_id=?').get(id);
const adopted = mkSession();
tm.bindReplyChannel(adopted, 'slack', 'D_DM');
assert(chanOf(adopted) && chanOf(adopted).c === 'D_DM', 'a run with no chat egress starts replying into the DM');
const threaded = mkSession();
aos.db.prepare('INSERT INTO slack_threads (session_id, channel, thread_ts, created_at) VALUES (?,?,?,?)').run(threaded, 'C_TEAM', '171.5', Date.now());
tm.bindReplyChannel(threaded, 'slack', 'D_DM');
assert(chanOf(threaded).c === 'C_TEAM' && chanOf(threaded).t === '171.5', 'a run already answering in a thread keeps answering THERE');
const dChanOf = (id) => aos.db.prepare('SELECT channel c FROM discord_threads WHERE session_id=?').get(id);
const dAdopted = mkSession();
tm.bindReplyChannel(dAdopted, 'discord', 'D_DISCORD_DM');
assert(dChanOf(dAdopted) && dChanOf(dAdopted).c === 'D_DISCORD_DM', 'same on discord');
// The continuation itself must bind, so a revive is launched WITH its slack_reply tool exposed.
const willBind = mkSession();
tm.bindSessionDm(willBind, 'slack', 'U_ALICE', alice.id);
resumable.add(willBind);
autos.continueSessionDm('slack', 'U_ALICE', { actorLabel: 'Alice', text: 'carry on', channel: 'D_NEW' }, alice.id);
assert(chanOf(willBind) && chanOf(willBind).c === 'D_NEW', 'continuing in a DM points the run\'s replies at that DM');

console.log('\n\x1b[1m9) the continuation is audited\x1b[0m');
const audited = aos.db.prepare("SELECT data FROM audit_events WHERE type='chat.continued' AND run_id=?").all(warm);
assert(audited.length === 1, 'one chat.continued event for the delivered turn');
assert(audited.length === 1 && JSON.parse(audited[0].data).via === 'dm', 'tagged via:dm, so DM turns are separable from thread turns');

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}DM CONTINUITY: ${pass}/${pass + fail} passed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
