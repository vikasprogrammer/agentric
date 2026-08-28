#!/usr/bin/env node
/* The stranded-task sweep does not wake a caller about a run a HUMAN stopped (edge/task-reconcile.ts).
 *
 * `sweepStrandedTasks` exists because a delegate whose run ends without `task_update` leaves its caller
 * waiting forever (14% of hand-offs before v0.307.0). But "the run ended" covers two very different
 * things, and only one of them is a stranding:
 *
 *   · the run died, crashed, or was reaped mid-work → nobody is coming; wake the caller.
 *   · a PERSON hit stop → somebody IS coming; they just decided the opposite. Waking the caller hands the
 *     agent back the work its owner took away, and the caller is cold by then, so the wake-up is a fresh
 *     resumed session. northwind 2026-08-20: an engineer run was stopped from the console at 09:28 and
 *     this sweep spawned a caller session at 09:38 which re-opened the work as a PR — the stop button
 *     produced one more agent, which is the opposite of what a stop button is for.
 *
 * Pins: a reaped/crashed run still wakes the caller; a console stop is MARKED but never woken (so it can
 * never fire on a later tick either); a self-stop via the agent's own `stop` tool still wakes, because
 * that is the agent's call and it may have left work behind; and the suppression is audited.
 *
 * Isolated home; no TerminalManager and no tmux — the sweep takes a plain poke hook, which we record.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-stranded-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { sweepStrandedTasks } = require(path.join(ROOT, 'dist/edge/task-reconcile.js'));

const aos = loadAgentOS();
aos.agents.set('caller', { id: 'caller', name: 'Caller', runtime: 'claude-code', dir: HOME });
aos.agents.set('engineer', { id: 'engineer', name: 'Engineer', runtime: 'claude-code', dir: HOME });
aos.team.bootstrapOwner('alice@testco.dev', 'Alice');
const alice = aos.team.getMemberByEmail('alice@testco.dev');

const HOUR = 3_600_000;
const poked = [];
const poker = { pokeCaller: (input) => { poked.push(input); return { ok: true }; } };

let n = 0;
/** A hand-off whose delegate run has ENDED without closing the task, settled well past the sweep's grace. */
function handOff(endedBy) {
  const id = 'ses_hs_' + (++n);
  const ended = Date.now() - HOUR;
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,outcome,run_as,spawned_by,claude_session_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,0,?,?,?,?,?,?)`)
    .run(id, 'engineer', 'work', 'work', 'aos-' + id, endedBy === 'reaped' ? 'done' : 'stopped',
      'unknown', alice.id, 'agent:caller', 'cuid_' + id, ended - HOUR, ended);
  // How the run ended is read from the audit trail, exactly as `stopSession` writes it: `system` for the
  // reaper, a member's EMAIL for the console kill button, the agent's own id for a self-stop.
  if (endedBy !== 'reaped') {
    aos.audit.append({ ts: ended, runId: id, tenant: aos.tenant, principal: endedBy, type: 'session.stopped', data: { tmux: 'aos-' + id } });
  }
  const t = aos.tasks.create({
    tenant: aos.tenant, title: `hand-off ${n}`, body: '', assignee: 'agent:engineer', owner: alice.id,
    createdBy: 'agent:caller', autoDispatch: true, pokeOnDone: true,
    callerAgent: 'agent:caller', callerClaudeId: 'cuid_caller',
  });
  aos.tasks.update(t.id, { status: 'doing', by: 'agent:engineer' });
  aos.db.prepare('UPDATE tasks SET last_session_id = ? WHERE id = ?').run(id, t.id);
  return { task: t.id, session: id };
}
const strandedAudit = (sessionId) => {
  const r = aos.db.prepare("SELECT data FROM audit_events WHERE run_id = ? AND type = 'task.stranded' ORDER BY id DESC LIMIT 1").get(sessionId);
  return r ? JSON.parse(r.data) : null;
};

console.log('\n\x1b[1m1) a run that just ENDED (reaped, unknown outcome) still wakes the caller\x1b[0m');
{
  const h = handOff('reaped');
  const out = sweepStrandedTasks(aos, poker, { budget: 5 });
  assert(out.poked === 1 && poked.length === 1, 'the caller is woken — nobody else is coming for this one', out);
  assert(poked[0].source === h.task && poked[0].callerAgent === 'agent:caller', 'about the right hand-off', poked[0]);
  assert(poked[0].kind === 'poke-stranded', 'as a stranding, the class that earns a resume when the caller is cold', poked[0].kind);
  assert(strandedAudit(h.session).poked === true, 'and the audit line says it was woken', strandedAudit(h.session));
}

console.log('\n\x1b[1m2) a run a HUMAN stopped is marked, never woken\x1b[0m');
{
  poked.length = 0;
  const h = handOff(alice.email);                 // the console kill button: `by` = the member's email
  const out = sweepStrandedTasks(aos, poker, { budget: 5 });
  assert(poked.length === 0, 'no wake-up — the person who stopped it is the one deciding', poked);
  assert(out.marked === 1 && out.poked === 0, 'still MARKED, so it can never fire on a later tick', out);
  const a = strandedAudit(h.session);
  assert(a && a.poked === false && a.reason === 'human-stopped', 'and the suppression is on the record', a);
  poked.length = 0;
  sweepStrandedTasks(aos, poker, { budget: 5 });
  assert(poked.length === 0, 'a second tick does not resurrect it either', poked);
}

console.log('\n\x1b[1m3) an agent stopping ITSELF is not a human veto — that caller is still woken\x1b[0m');
{
  poked.length = 0;
  handOff('engineer');                            // the `stop` MCP tool: `by` = the agent id
  const out = sweepStrandedTasks(aos, poker, { budget: 5 });
  assert(out.poked === 1 && poked.length === 1, 'a self-stop may still have left work behind for the caller', out);
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail === 0 ? 0 : 1);
