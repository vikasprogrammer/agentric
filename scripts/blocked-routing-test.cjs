#!/usr/bin/env node
/* A delegate blocked on a HUMAN wakes the owner, not the caller agent (`Task.blockedOn` routing).
 *
 * The completion poke fires on `blocked` as well as `done`, which is right when the caller can DO something
 * — re-scope the work, route around the blocker, chase whoever owes it. It is waste when the blocker is a
 * person: the owner is already carded ("Task blocked — needs you") and the caller agent can only restate
 * that it is stuck. Measured twice on northwind 2026-08-17, both on a resumed transcript costing ~$8-10 a
 * turn:
 *   tsk_f81b27d7 "Blocked on human approval for the merge only" → woke prod-monitor, which answered
 *                "Leaving this blocked. @engineer stopped in the right place — I am not merging it and
 *                 neither should any agent" and ended.
 *   tsk_5aa0fd20 "no deletions without founder sign-off"        → woke agent-author the same way.
 *
 * So the delegate now DECLARES what it waits on and the routing follows that declaration — never a guess at
 * the wording of its note, which would misroute exactly when the phrasing is unusual.
 *
 * Pins: human → no caller wake (and an audit saying why); agent/external → wake as before; an UNSTATED
 * blocker keeps the old behaviour (this only narrows on an explicit declaration); the flag is cleared when
 * the task leaves blocked, so a stale "waiting on the founder" can't misroute a later done-poke; and the
 * owner's inbox card is unaffected in every case.
 *
 * Isolated home; the session backend is stubbed, so no tmux and no real `claude` are involved.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-blocked-routing-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 250) : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));
const { wireTaskNotices } = require(path.join(ROOT, 'dist/tenant-registry.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const livePanes = new Set();
tm.backend.aliveNames = () => new Set(livePanes);
tm.backend.injectText = () => true;
tm.backend.spawn = (_s, o) => { livePanes.add(o.tmuxName); };
tm.backend.kill = (_s, tmux) => { livePanes.delete(tmux); };
tm.backend.capturePane = () => '';
tm.backend.hasClient = () => false;

aos.agents.set('caller', { id: 'caller', name: 'Caller', runtime: 'claude-code', dir: HOME });
aos.agents.set('delegate', { id: 'delegate', name: 'Delegate', runtime: 'claude-code', dir: HOME });
aos.team.bootstrapOwner('alice@testco.dev', 'Alice');
const alice = aos.team.getMemberByEmail('alice@testco.dev');

// Capture the resume lane instead of launching it.
let n = 0;
const spawned = [];
tm.createSession = (agent, title, task, spawnedBy, headless, slack, discord, runAs, resumeClaudeId) => {
  const id = 'ses_br_' + (++n);
  spawned.push({ id, agent, spawnedBy, task });
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,run_as,spawned_by,claude_session_id,created_at,updated_at)
    VALUES (?,?,?,?,?,'running',1,0,?,?,?,?,?)`)
    .run(id, agent, title || 't', task || 'x', 'aos-' + id, runAs ?? null, spawnedBy ?? null, resumeClaudeId ?? ('cuid_' + id), Date.now(), Date.now());
  return { id, tmux: 'aos-' + id };
};

const autos = new Automations(aos, tm);
// The production wiring: the store notifier fans out to the inbox card AND the caller poke.
wireTaskNotices(aos, tm, autos, { dmUser: async () => false, userIdForEmail: async () => null }, { dmUser: async () => false }, 'http://localhost:0');

/** A hand-off from `caller` to `delegate`, with the poke armed exactly as task_create does. */
const handOff = (title) => {
  const t = aos.tasks.create({
    tenant: aos.tenant, title, assignee: 'agent:delegate', owner: alice.id,
    createdBy: 'agent:caller', callerAgent: 'agent:caller', callerClaudeId: 'cs-caller', pokeOnDone: true,
  });
  return t.id;
};
const pokes = () => spawned.filter((s) => (s.spawnedBy || '').startsWith('poke:')).length;
const skipAudit = () => aos.db.prepare("SELECT data FROM audit_events WHERE type = 'agent.poke.skipped'").all().map((r) => JSON.parse(r.data));
const ownerCards = (taskId) => aos.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND audience_id = ?").get(`task:${taskId}`, alice.id).n;

console.log('\n\x1b[1m1) blocked on a HUMAN — the owner is told, the caller agent is not woken\x1b[0m');
{
  const id = handOff('Merge PR #495 — needs founder sign-off');
  const before = pokes();
  aos.tasks.update(id, { status: 'blocked', blockedOn: 'human', note: 'Blocked on human approval for the merge only.', by: 'agent:delegate' });
  assert(pokes() === before, 'no resumed run for the caller — it could only restate the block', spawned.slice(before));
  assert(ownerCards(id) > 0, 'the owner still gets the inbox card that actually needs a person', ownerCards(id));
  const sk = skipAudit();
  assert(sk.some((d) => d.source === id && d.reason === 'blocked-on-human'), 'and the skip is on the record, not silent', sk);
  assert(aos.tasks.get(id).blockedOn === 'human', 'the declaration is stored on the task', aos.tasks.get(id));
}

console.log('\n\x1b[1m2) blocked on another AGENT / something EXTERNAL — wake the caller, as before\x1b[0m');
{
  for (const kind of ['agent', 'external']) {
    const id = handOff(`Waiting on ${kind}`);
    const before = pokes();
    aos.tasks.update(id, { status: 'blocked', blockedOn: kind, note: `waiting on ${kind}`, by: 'agent:delegate' });
    assert(pokes() === before + 1, `blockedOn:"${kind}" still wakes the caller — it can re-scope or chase`, spawned[spawned.length - 1]);
  }
}

console.log('\n\x1b[1m3) an UNSTATED blocker keeps the old behaviour — this only narrows on a declaration\x1b[0m');
{
  const id = handOff('Blocked, reason not declared');
  const before = pokes();
  aos.tasks.update(id, { status: 'blocked', note: 'stuck', by: 'agent:delegate' });
  assert(pokes() === before + 1, 'no declaration → the caller is woken exactly as it was before this change');
  assert(aos.tasks.get(id).blockedOn === undefined, 'and nothing was invented from the note text', aos.tasks.get(id));
}

console.log('\n\x1b[1m4) the flag cannot outlive the wait\x1b[0m');
{
  const id = handOff('Blocked, then unblocked, then finished');
  aos.tasks.update(id, { status: 'blocked', blockedOn: 'human', by: 'agent:delegate' });
  aos.tasks.update(id, { status: 'doing', by: 'agent:delegate' });
  assert(aos.tasks.get(id).blockedOn === undefined, 'leaving blocked clears it', aos.tasks.get(id));
  const before = pokes();
  aos.tasks.update(id, { status: 'done', note: 'shipped', by: 'agent:delegate' });
  assert(pokes() === before + 1, 'so the DONE poke is delivered — a stale flag can never mute a real result');
}

console.log('\n\x1b[1m5) the caller closing its own hand-off still never self-wakes\x1b[0m');
{
  const id = handOff('Caller parks its own task');
  const before = pokes();
  aos.tasks.update(id, { status: 'blocked', blockedOn: 'agent', by: 'agent:caller' });
  assert(pokes() === before, 'the actor is the caller — no wake for news it authored itself');
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail === 0 ? 0 : 1);
