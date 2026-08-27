#!/usr/bin/env node
/* Episode-quality test — what a finished session is allowed to write into the agent's memory.
 *
 * Episodes are auto-encoded (no agent decides to store them), so every rule that keeps them useful has
 * to live in code. Measured against the live fleet on 2026-08-27, three failures were visible in the
 * instapods + instawp memory stores, and this pins the fix for each:
 *
 *   1. The `Task:` line was stored VERBATIM. An unattended run's task is a multi-paragraph standing
 *      order; one 1979-char support-sweep prompt filled a whole memory (automem caps at 2000 chars),
 *      leaving no room for what the run actually did. 419 stored episodes carried a >300-char task line.
 *   2. Launch plumbing counted as work. `github.token.injected` fires on every run before the agent has
 *      done anything, so smoke runs ("Task: cred check - stop") became episodes — 72 of them, recalled
 *      22 times, each one displacing a real lesson in a top-k recall.
 *   3. Nothing deduped. One 2h cron wrote the same byte-identical episode 177 times in a month — 7% of
 *      that tenant's entire memory, one string, and it ranked in live recall probes.
 *
 * Isolated home; no tmux or claude needed (episode composition + the dedupe read are pure over the DB). */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-episode-test-'));
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

let seq = 0;
const mkSession = (agent, task) => {
  const id = `ts_${++seq}`;
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,spawned_by,created_at,updated_at) VALUES (?,?,?,?,?,'done',1,'m_owner',?,?)")
    .run(id, agent, 'run', task, `t_${id}`, Date.now(), Date.now());
  return id;
};
const addEvents = (id, agent, types) => {
  for (const t of types) aos.audit.append({ ts: Date.now(), runId: id, tenant: aos.tenant, principal: agent, type: t, data: {} });
};
const addReport = (id, agent, outcome, body) => {
  aos.db.prepare("INSERT INTO messages (id,session_id,agent,title,status,type,body,outcome,created_at) VALUES (?,?,?,'done','open','completed',?,?,?)")
    .run(`msg_${id}`, id, agent, body, outcome, Date.now());
};
const memories = (agent) => aos.db.prepare('SELECT content FROM memories WHERE agent_id = ? ORDER BY created_at').all(agent).map((r) => r.content);
const audited = (id, type) => !!aos.db.prepare('SELECT 1 FROM audit_events WHERE run_id = ? AND type = ?').get(id, type);

/** writeEpisode stores through the async memory provider — settle it before reading the table. */
const settle = () => new Promise((r) => setImmediate(() => setImmediate(() => setTimeout(r, 30))));
const writeEpisode = async (id, agent, outcome) => { tm.writeEpisode(id, agent, outcome); await settle(); };

(async () => {
  console.log('\nepisode quality — what a finished session may write into memory\n');

  // ── 1. the task line is capped, the agent's own report is not ───────────────────────────────────
  const longTask = 'AUTOMATED INCREMENTAL SUPPORT SWEEP — runs every 2h, unattended, DRAFTS ONLY. ' + 'Follow your CLAUDE.md phases in INCREMENTAL mode. '.repeat(40);
  const body = 'The 06:30Z sweep was genuinely empty, and the way to prove it was a CONTROL query. ' + 'Both filtered searches returned nothing while the unfiltered control returned 12 rows. '.repeat(20);
  const s1 = mkSession('support', longTask);
  addEvents(s1, 'support', ['gate.decision', 'capability.invoked']);
  addReport(s1, 'support', 'success', body);
  await writeEpisode(s1, 'support');
  const ep1 = memories('support')[0] ?? '';
  const taskLine1 = ep1.split('\n')[0];
  assert(taskLine1.startsWith('Task: ') && taskLine1.length <= 210, 'a 2KB standing order is capped to one identifying task line', `len ${taskLine1.length}`);
  assert(taskLine1.endsWith('…'), 'the capped task line is marked as truncated');
  assert(taskLine1.includes('AUTOMATED INCREMENTAL SUPPORT SWEEP'), 'the cap keeps the identifying head of the task');
  assert(ep1.includes(body.trim()), "the agent's own report body is NOT capped — only the task line is");

  const s2 = mkSession('support', '  \n\n  Reconcile open tickets\nthen post a summary\n');
  addEvents(s2, 'support', ['gate.decision']);
  addReport(s2, 'support', 'success', 'Reconciled 4 tickets.');
  await writeEpisode(s2, 'support');
  assert((memories('support')[1] ?? '').startsWith('Task: Reconcile open tickets\n'), 'a short task keeps its first line verbatim, whitespace collapsed');

  // ── 2. launch plumbing is not work ──────────────────────────────────────────────────────────────
  const s3 = mkSession('smoke', 'cred check - stop');
  addEvents(s3, 'smoke', ['github.token.injected', 'runtime.account.selected', 'automation.fired', 'session.created']);
  await writeEpisode(s3, 'smoke', 'stopped');
  assert(memories('smoke').length === 0, 'a run that only emitted launch plumbing stores NO episode');

  const s4 = mkSession('smoke', 'do the actual thing');
  addEvents(s4, 'smoke', ['github.token.injected', 'gate.decision', 'gate.decision']);
  await writeEpisode(s4, 'smoke', 'stopped');
  const ep4 = memories('smoke')[0] ?? '';
  assert(ep4.includes('2 governed actions'), 'one real governed action still makes an episode');
  assert(!ep4.includes('github.token.injected'), 'plumbing is excluded from the activity summary it does survive');

  // ── 3. an identical repeat episode is not stored twice ──────────────────────────────────────────
  const cron = (n) => {
    const id = mkSession('cronbot', 'Nightly sweep — same standing order every night.');
    addEvents(id, 'cronbot', ['gate.decision']);
    addReport(id, 'cronbot', 'success', 'Nothing new since the watermark.');
    return id;
  };
  const c1 = cron(1); await writeEpisode(c1, 'cronbot');
  const c2 = cron(2); await writeEpisode(c2, 'cronbot');
  assert(memories('cronbot').length === 1, 'a byte-identical repeat run stores no second copy', `got ${memories('cronbot').length}`);
  assert(audited(c2, 'episode.duplicate'), 'the suppressed duplicate is audited, not silently dropped');
  assert(!audited(c2, 'episode.stored'), 'the suppressed duplicate records no episode.stored');

  const c3 = mkSession('cronbot', 'Nightly sweep — same standing order every night.');
  addEvents(c3, 'cronbot', ['gate.decision']);
  addReport(c3, 'cronbot', 'success', 'Found 3 new tickets and drafted replies.');
  await writeEpisode(c3, 'cronbot');
  assert(memories('cronbot').length === 2, 'a run whose report DIFFERS is still stored — dedupe is exact-content only');

  // dedupe is per agent: another agent's identical episode is its own memory
  const c4 = mkSession('otherbot', 'Nightly sweep — same standing order every night.');
  addEvents(c4, 'otherbot', ['gate.decision']);
  addReport(c4, 'otherbot', 'success', 'Nothing new since the watermark.');
  await writeEpisode(c4, 'otherbot');
  assert(memories('otherbot').length === 1, "a different agent's identical episode is not deduped away");

  // ── 4. idempotency still holds (the pre-existing guard) ─────────────────────────────────────────
  await writeEpisode(c3, 'cronbot');
  assert(memories('cronbot').length === 2, 'a doubled end signal for one session still writes one episode');

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
