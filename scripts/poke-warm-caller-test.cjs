#!/usr/bin/env node
/* A poke-back reaches the caller that is STILL RUNNING (Automations.pokeCaller + TerminalManager.reachable).
 *
 * When a delegate closes a `poke_on_done` hand-off, the OS wakes the caller: into its live pane if it has
 * one, else by `--resume`ing its transcript in a new session. Choosing between those two used to be
 * `status = 'running'` — and `status` is not liveness. An agent that calls `report` is stamped `done` while
 * its claude keeps running, which is the NORMAL shape for a caller: it hands off work, reports, and carries
 * on for minutes while the delegate finishes. Every one of those took the resume lane, starting a SECOND
 * claude on a transcript the first still held — the outcome `chatSend` calls "the one worse than a slow
 * turn". Live on northwind 2026-08-10: `ses_f4535e8f` reported 16:13, worked until 16:34, and its 16:31
 * poke spawned `ses_441cec` which died 28s later; the caller never saw it and re-derived the result by hand.
 *
 * Pins: reported-but-warm delivers in place; a dead pane still resumes; a human `stop` is never overridden;
 * delivery puts the row back to `running`+busy; a failed inject kills the pane BEFORE resuming; and the
 * newest row wins for a transcript that spans several sessions.
 *
 * Isolated home; the session backend is stubbed, so no tmux and no real `claude` are involved.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-poke-warm-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));

// ── stub backend: we control which panes are "alive" and record every keystroke delivery ────────
const livePanes = new Set();
const injected = [];
let injectWorks = true;
tm.backend.aliveNames = () => new Set(livePanes);
tm.backend.injectText = (_s, tmux, text) => { injected.push({ tmux, text }); return injectWorks && livePanes.has(tmux); };
tm.backend.spawn = (_s, o) => { livePanes.add(o.tmuxName); };
tm.backend.kill = (_s, tmux) => { livePanes.delete(tmux); };
tm.backend.capturePane = () => '';
tm.backend.hasClient = () => false;

aos.agents.set('caller', { id: 'caller', name: 'Caller', runtime: 'claude-code', dir: HOME });
aos.team.bootstrapOwner('alice@testco.dev', 'Alice');
const alice = aos.team.getMemberByEmail('alice@testco.dev');

// Capture the resume lane rather than launching it — we only care THAT it was taken, and with what.
let n = 0, clock = Date.now() - 3_600_000;
const spawned = [];
tm.createSession = (agent, title, task, spawnedBy, headless, slack, discord, runAs, resumeClaudeId) => {
  const id = 'ses_poke_' + (++n);
  spawned.push({ id, agent, spawnedBy, resumeClaudeId: resumeClaudeId ?? null, task });
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,run_as,spawned_by,claude_session_id,created_at,updated_at)
    VALUES (?,?,?,?,?,'running',1,0,?,?,?,?,?)`)
    .run(id, agent, title || 't', task || 'x', 'aos-' + id, runAs ?? null, spawnedBy ?? null, resumeClaudeId ?? ('cuid_' + id), (clock += 1000), clock);
  return { id, tmux: 'aos-' + id };
};

/** A caller session row on transcript `cs`, in whatever status + pane state the case needs. */
const mkCaller = (cs, opts = {}) => {
  const id = 'ses_c_' + (++n);
  const { pane, ...over } = opts;
  const cols = {
    id, agent: 'caller', title: 'daily sweep', task: 'sweep', tmux: 'aos-' + id,
    status: 'running', headless: 0, resident: 0, claude_session_id: cs, secret: 'sec',
    spawned_by: alice.id, run_as: alice.id, busy_since: null, last_activity: null,
    created_at: (clock += 1000), updated_at: clock, ...over,
  };
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,claude_session_id,secret,spawned_by,run_as,busy_since,last_activity,created_at,updated_at)
    VALUES (@id,@agent,@title,@task,@tmux,@status,@headless,@resident,@claude_session_id,@secret,@spawned_by,@run_as,@busy_since,@last_activity,@created_at,@updated_at)`).run(cols);
  if (pane !== false) livePanes.add(cols.tmux);
  return id;
};
const autos = new Automations(aos, tm);
const poke = (cs, source) => autos.pokeCaller({ callerAgent: 'agent:caller', callerClaudeId: cs, runAs: alice.id, message: `✅ Really done: ${source}`, source });
const sentTo = (id) => injected.filter((i) => i.tmux === 'aos-' + id);
/** Retire every live pane of the caller agent. Cases about the RESUME lane need the agent fully idle:
 *  a live session under ANY transcript is now a delivery target (case 10), not something to resume past. */
const idleAgent = () => { for (const r of aos.db.prepare("SELECT tmux FROM term_sessions WHERE agent = 'caller'").all()) livePanes.delete(r.tmux); };
const row = (id) => aos.db.prepare('SELECT status, busy_since FROM term_sessions WHERE id = ?').get(id);
const pokeAudit = (id) => aos.db.prepare("SELECT data FROM audit_events WHERE run_id = ? AND type = 'agent.poked'").all(id).map((r) => JSON.parse(r.data));

console.log('\n\x1b[1m1) the caller REPORTED but its claude is still running — deliver in place\x1b[0m');
{
  const cs = 'cs-reported';
  const c = mkCaller(cs, { status: 'done' });          // exactly what `report` leaves behind
  const before = spawned.length;
  const r = poke(cs, 'tsk_1');
  assert(r.ok && r.sessionId === c, 'poke resolved to the existing session', r);
  assert(sentTo(c).some((i) => i.text.includes('tsk_1')), 'the message was typed into its live pane');
  assert(spawned.length === before, 'NO second claude spawned on the transcript', spawned.slice(before));
  assert(pokeAudit(c).some((d) => d.via === 'inject'), 'audited via:inject', pokeAudit(c));
}

console.log('\n\x1b[1m2) delivering puts the row back in step with reality\x1b[0m');
{
  const cs = 'cs-restore';
  const c = mkCaller(cs, { status: 'done' });
  poke(cs, 'tsk_2');
  const after = row(c);
  assert(after.status === 'running', "status back to 'running' — it is working again", after);
  assert(after.busy_since > 0, 'busy_since stamped, so the console spins on `working`', after);
}

console.log('\n\x1b[1m3) the pane really is gone — resume, as before\x1b[0m');
{
  idleAgent();
  const cs = 'cs-dead';
  const c = mkCaller(cs, { status: 'done', pane: false });
  const r = poke(cs, 'tsk_3');
  const s = spawned[spawned.length - 1];
  assert(r.ok && r.sessionId === s.id, 'a new session carries the poke', r);
  assert(s.resumeClaudeId === cs, 'and it RESUMES the caller transcript (not a cold start)', s);
  assert(s.spawnedBy === 'poke:tsk_3', 'stamped with poke provenance', s);
  assert(sentTo(c).length === 0, 'nothing was typed at the dead pane');
  assert(pokeAudit(s.id).some((d) => d.via === 'resume'), 'audited via:resume', pokeAudit(s.id));
}

console.log('\n\x1b[1m4) a human STOPPED the run — a leftover pane is not a destination\x1b[0m');
{
  idleAgent();
  const cs = 'cs-stopped';
  const c = mkCaller(cs, { status: 'stopped' });        // pane still listed, deliberately ended
  const before = spawned.length;
  const r = poke(cs, 'tsk_4');
  assert(sentTo(c).length === 0, 'nothing typed into a stopped run');
  assert(spawned.length === before + 1, 'the poke took the resume lane instead', r);
  assert(tm.reachable(c) === false, 'reachable() refuses stopped/crashed rows');
}

console.log('\n\x1b[1m5) the inject fails on a live pane — kill it BEFORE resuming\x1b[0m');
{
  idleAgent();
  const cs = 'cs-wedged';
  const c = mkCaller(cs, { status: 'done' });
  injectWorks = false;
  const before = spawned.length;
  const r = poke(cs, 'tsk_5');
  injectWorks = true;
  assert(spawned.length === before + 1, 'fell through to a resume — the poke is never dropped', r);
  assert(!livePanes.has('aos-' + c), 'the wedged pane was killed first (never two claudes on one transcript)');
  assert(tm.reachable(c) === false, 'and the old run is no longer a delivery target', row(c));
}

console.log('\n\x1b[1m6) a transcript spanning several rows — the NEWEST one owns the pane\x1b[0m');
{
  const cs = 'cs-chain';
  const old = mkCaller(cs, { status: 'done', pane: false });   // an earlier run on the same transcript
  const cur = mkCaller(cs, { status: 'done' });                // the live one, created later
  const r = poke(cs, 'tsk_6');
  assert(r.sessionId === cur, 'delivered to the current run', r);
  assert(sentTo(old).length === 0, 'the retired row was never written to');
}

// The SECOND axis of liveness: the transcript is cold but the AGENT is not. All of an agent's sessions
// share one workspace folder, so resuming here means two claudes in the same directory. northwind
// 2026-08-16: `check-resolve-tickets` was running since 12:36 under one transcript when a poke resumed
// its 2-day-old caller transcript into a second pane.
console.log('\n\x1b[1m7) the caller transcript is cold but the AGENT is live elsewhere — deliver there, never resume\x1b[0m');
{
  idleAgent();
  const cold = mkCaller('cs-cold', { status: 'done', pane: false });   // the caller's own conversation, exited
  const warm = mkCaller('cs-other', { status: 'running' });            // same agent, different transcript, working
  const before = spawned.length;
  const r = poke('cs-cold', 'tsk_7');
  assert(r.ok && r.sessionId === warm, 'the poke went to the agent\'s live session', r);
  assert(spawned.length === before, 'NO second claude in the agent workspace', spawned.slice(before));
  assert(sentTo(warm).some((i) => i.text.includes('tsk_7')), 'and it carries the task, so no transcript context is needed');
  assert(sentTo(cold).length === 0, 'nothing typed at the retired transcript');
  assert(pokeAudit(warm).some((d) => d.via === 'inject-sibling' && d.transcript === 'cs-cold'), 'audited via:inject-sibling with the transcript it stood in for', pokeAudit(warm));
  // A wedged sibling must NOT be killed — it is doing someone else's work; fall through instead.
  injectWorks = false;
  const r2 = poke('cs-cold', 'tsk_7b');
  injectWorks = true;
  assert(spawned.length === before + 1, 'a failed sibling inject still resumes — the poke is never dropped', r2);
  assert(livePanes.has('aos-' + warm), 'and the sibling pane survives (it is not the poke\'s to end)');
  idleAgent();
}

console.log('\n\x1b[1m8) reachable() is the ONE liveness predicate — the pane, vetoed only by a deliberate end\x1b[0m');
{
  assert(typeof tm.isAlive !== 'function', 'the status-folding `isAlive` is gone — no wrong choice to make');
  const c = mkCaller('cs-contrast', { status: 'done' });
  assert(tm.reachable(c) === true, 'a reported run is live — there is a REPL to type into');
  for (const s of ['stopped', 'crashed']) {
    aos.db.prepare('UPDATE term_sessions SET status = ? WHERE id = ?').run(s, c);
    assert(tm.reachable(c) === false, `${s} vetoes a surviving pane (a leftover, not a destination)`);
  }
  aos.db.prepare("UPDATE term_sessions SET status = 'done' WHERE id = ?").run(c);
  livePanes.delete('aos-' + c);
  assert(tm.reachable(c) === false, 'and false once the pane goes away');
}

// The other two sites that read `status` as liveness. Both fail in the SAME direction as the poke — they
// call a live agent free — but cost differently: one stacks a rival worker, one silently skips a delivery.
console.log('\n\x1b[1m9) the dispatch pile-up guard counts a reported-but-warm worker as busy\x1b[0m');
{
  const t = aos.tasks.create({ tenant: aos.tenant, title: 'ship it', assignee: 'agent:caller', owner: alice.id, createdBy: alice.id });
  const worker = mkCaller('cs-worker', { status: 'done', spawned_by: `task:${t.id}` });  // reported, still up
  aos.tasks.markDispatched(t.id, worker);
  const guarded = autos.dispatchTask(t.id, { guard: true, by: 'test' });
  assert(guarded.ok === false && /already working/.test(guarded.reason || ''), 'guarded dispatch refuses — no rival worker', guarded.reason);
  livePanes.delete('aos-' + worker);
  const after = autos.dispatchTask(t.id, { guard: true, by: 'test' });
  assert(!/already working/.test(after.reason || ''), 'and stops refusing once the pane is actually gone', after.reason);
}

console.log('\n\x1b[1m10) a freshly installed skill reaches a reported-but-warm session\x1b[0m');
{
  const reached = [];
  tm.materializeSkills = (sessionId) => { reached.push(sessionId); };
  // Its own agent, so the sweep's row set is exactly this one session.
  aos.agents.set('skiller', { id: 'skiller', name: 'Skiller', runtime: 'claude-code', dir: HOME });
  const s = mkCaller('cs-skills', { status: 'done', headless: 0, agent: 'skiller' });  // interactive, reported, pane alive
  tm.refreshAgentSkills('skiller');
  assert(reached.includes(s), 'the live REPL is refreshed — not told to wait for its next run', reached);
  reached.length = 0;
  livePanes.delete('aos-' + s);
  tm.refreshAgentSkills('skiller');
  assert(reached.length === 0, 'a dead pane is still skipped');
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail === 0 ? 0 : 1);
