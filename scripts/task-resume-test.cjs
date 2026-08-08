#!/usr/bin/env node
/* Task re-dispatch RESUMES the prior transcript (Automations.dispatchTask + resumableTaskTranscript).
 *
 * A task is the durable unit of work; a session is one attempt. Every other re-entry path (chat threads,
 * DM replies, poke-back, self-schedule) `--resume`s the prior transcript — task re-dispatch was the lone
 * exception, spawning fresh with only a text summary, so a retried/reopened task re-derived everything.
 *
 * This pins the resume ladder the dispatcher now runs:
 *   fresh → resume → resume → fresh-escape → park   (MAX_TASK_RESUMES=2, TASK_MAX_ATTEMPTS=4)
 * plus the guards: a resume only reuses a transcript from the SAME agent, and the escape mints a NEW
 * transcript so a wedged one can't be reloaded forever. The tmux backend is stubbed and createSession is
 * captured, so no real claude spawns.
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-task-resume-test-'));
process.env.AGENT_OS_HOME = HOME; process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;
let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations, TASK_MAX_ATTEMPTS, MAX_TASK_RESUMES } = require(path.join(ROOT, 'dist/edge/automations.js'));
const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
tm.backend.aliveNames = () => new Set(); // nothing alive → the pile-up guard never trips
tm.backend.kill = () => {}; tm.backend.hasClient = () => false; tm.backend.spawn = () => {}; tm.backend.capturePane = () => null;
const autos = new Automations(aos, tm);

// Provision two real claude-code agents on disk.
const mkAgent = (id) => {
  const dir = path.join(aos.paths.userAgents, id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { id, version: '1.0.0', description: `${id}`, principal: `svc-${id}`, policyContext: 'default@v3', runtime: 'claude-code' };
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(manifest) + '\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# ${id}\n`);
  aos.registerAgent({ ...manifest, dir });
};
mkAgent('engineer'); mkAgent('analyst');

// Capture createSession — record the resumeClaudeId (index 8) + the prompt (index 2), simulate the row
// the real launcher would write (spawned_by, agent, and the pinned claude_session_id = resumeId || new).
let n = 0, clock = Date.now() - 3_600_000;
const calls = [];
tm.createSession = (agent, title, task, spawnedBy, headless, slack, discord, runAs, resumeClaudeId) => {
  const id = 'ts_' + (++n);
  const cs = resumeClaudeId || ('cuid_' + id);
  calls.push({ agent, spawnedBy, resumeClaudeId: resumeClaudeId ?? null, cs, prompt: task });
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,run_as,spawned_by,claude_session_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,0,?,?,?,?,?)`).run(id, agent, title || 't', task || 'x', 'aos-' + id, 'done', runAs ?? null, spawnedBy ?? null, cs, (clock += 1000), clock + 500);
  return { id, tmux: 'aos-' + id };
};
const dispatch = (taskId) => autos.dispatchTask(taskId, { guard: false });

console.log(`\n\x1b[1m0) constants — the ladder needs room for two resumes + a fresh escape\x1b[0m`);
assert(MAX_TASK_RESUMES === 2, 'MAX_TASK_RESUMES = 2', MAX_TASK_RESUMES);
assert(TASK_MAX_ATTEMPTS === 4, 'TASK_MAX_ATTEMPTS = 4 (was 3 — bumped so the escape-fresh attempt runs)', TASK_MAX_ATTEMPTS);

console.log('\n\x1b[1m1) the resume ladder: fresh → resume → resume → fresh-escape → park\x1b[0m');
const t = aos.tasks.create({ tenant: aos.tenant, title: 'Fix the webhook', assignee: 'agent:engineer', createdBy: 'm_alice' });

const r1 = dispatch(t.id);
assert(r1.ok && calls[0].resumeClaudeId === null, 'attempt 1 is FRESH — no transcript to resume yet', calls[0]);
const C1 = calls[0].cs;

const r2 = dispatch(t.id);
assert(r2.ok && calls[1].resumeClaudeId === C1, 'attempt 2 RESUMES the first run\'s transcript', calls[1]);
assert(/RESUMING your own earlier session/.test(calls[1].prompt), 'and the prompt tells it to continue, not restart', calls[1].prompt.slice(0, 60));

const r3 = dispatch(t.id);
assert(r3.ok && calls[2].resumeClaudeId === C1, 'attempt 3 RESUMES the same transcript again', calls[2]);

const r4 = dispatch(t.id);
assert(r4.ok && calls[3].resumeClaudeId === null, 'attempt 4 is a FRESH escape — 2 resumes did not close it', calls[3]);
assert(calls[3].cs !== C1, 'the escape mints a NEW transcript (the wedged one can\'t be reloaded again)', { C1, escape: calls[3].cs });
assert(/You are working task/.test(calls[3].prompt) && !/RESUMING/.test(calls[3].prompt), 'the fresh escape gets the full task prompt, not the resume seed');

const r5 = dispatch(t.id);
assert(!r5.ok && /ceiling/.test(r5.reason || ''), 'attempt 5 is refused — the attempt ceiling is reached', r5);
assert(aos.tasks.get(t.id).status === 'blocked', 'and the task is parked blocked for a human', aos.tasks.get(t.id).status);
assert(calls.length === 4, 'exactly 4 sessions were ever spawned for this task', calls.length);

console.log('\n\x1b[1m2) a transcript is only resumed by the SAME agent (you can\'t resume A\'s into B)\x1b[0m');
const t2 = aos.tasks.create({ tenant: aos.tenant, title: 'Analyse traffic', assignee: 'agent:engineer', createdBy: 'm_alice' });
dispatch(t2.id); // engineer runs it once → transcript exists for engineer
const engCs = calls[calls.length - 1].cs;
aos.tasks.update(t2.id, { assignee: 'agent:analyst', by: 'm_alice' }); // reassigned mid-flight
const rr = dispatch(t2.id);
assert(rr.ok && calls[calls.length - 1].resumeClaudeId === null, 'the new assignee starts FRESH — no cross-agent resume', calls[calls.length - 1]);
assert(calls[calls.length - 1].cs !== engCs, 'and gets its own transcript');

console.log('\n\x1b[1m3) resumableTaskTranscript — the read the decision turns on\x1b[0m');
const probe = tm.resumableTaskTranscript(t.id, 'engineer');
assert(probe && probe.claudeSessionId === calls[3].cs, 'returns the MOST RECENT engineer transcript for the task', probe);
assert(probe && probe.uses === 1, 'the escape transcript has been used once (only the escape run)', probe);
assert(tm.resumableTaskTranscript(t.id, 'nobody') === undefined, 'an agent that never ran the task has nothing to resume');

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
