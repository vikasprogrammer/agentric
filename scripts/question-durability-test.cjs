#!/usr/bin/env node
/* Durable asks — a question that outlives the run that raised it.
 *
 * The failure this pins is live and repeated (instapods growth trial, 2026-09-21..23): an unattended run
 * asks a human something, the run ends ~5 minutes later, and the pending question is CANCELLED with it.
 * The human's DM pointed at a card that was already dead, so the same question was re-asked on three
 * consecutive runs and never answered once. Worse shape: a decision nobody can take is also a decision
 * nothing proceeds on.
 *
 * So a question carrying a `default` or a `deadline` now survives the session end, the deadline resolves
 * it to that default (deterministically, off the scheduler tick), and the answer — human's or defaulted —
 * is delivered to the agent through the wake queue rather than into nothing. Also pinned: the bounds on
 * the deadline, multi-pick validation, and that a PLAIN question still dies with its run (unchanged).
 *
 * Isolated home; no ttyd.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-askdur-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`));

const HOUR = 3_600_000;

(async () => {
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, tm } = registry.default();
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = aos.team.listMembers().find((m) => m.role === 'owner');
  const agent = [...aos.agents.values()][0].id;

  // A session row the ask can hang off, with a pinned transcript so the wake queue has something to
  // resume. `secret` is what the loopback /api/ask gate checks.
  let seq = 0;
  const mkSession = (status = 'running') => {
    const id = `ses_dur${String(++seq).padStart(4, '0')}`;
    aos.db.prepare('INSERT INTO term_sessions (id, agent, title, task, tmux, status, spawned_by, created_at, secret, updated_at, run_as, claude_session_id, headless) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)')
      .run(id, agent, 'run', 'run', `aos-${id}`, status, 'automation:au_x', Date.now(), `sec-${id}`, Date.now(), owner.id, `claude-${id}`);
    return id;
  };
  const ask = async (session, body) => (await fetch(base + '/api/ask', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-aos-secret': `sec-${session}` },
    body: JSON.stringify({ session, agent, ...body }),
  })).json();
  const qrow = (id) => aos.db.prepare('SELECT status, kind, options, default_answer, expires_at, goal_id, answer, answered_by FROM questions WHERE id = ?').get(id);
  const card = (id) => aos.db.prepare("SELECT status, args FROM messages WHERE question_id = ? AND type = 'question'").get(id);
  // The deliverer is wired in tenant-registry to the wake queue; capture what it would send.
  const delivered = [];
  tm.setQuestionDeliverer((n) => delivered.push(n));

  console.log('\n\x1b[1m1) A plain question still dies with its run\x1b[0m');
  const s1 = mkSession();
  const plain = await ask(s1, { question: 'What now?' });
  assert(!!plain.id, 'it posts', plain);
  tm.stopSession(s1, 'system');
  assert(qrow(plain.id).status === 'cancelled', 'cancelled when the session ends — unchanged behaviour', qrow(plain.id));

  console.log('\n\x1b[1m2) A question with a default OUTLIVES its run\x1b[0m');
  const s2 = mkSession();
  const dur = await ask(s2, { question: 'Build the tool page?', options: ['Yes, build it', 'No'], default: 'No', deadlineHours: 24 });
  assert(!!dur.id && dur.default === 'No', 'the default comes back on the ask', dur);
  assert(Math.abs(dur.expiresAt - (Date.now() + 24 * HOUR)) < 5000, 'the deadline is 24h out', dur.expiresAt);
  const row2 = qrow(dur.id);
  assert(row2.kind === 'one' && JSON.parse(row2.options)[0] === 'Yes, build it', 'kind + options are stored on the question, not just the card', row2);
  tm.stopSession(s2, 'system');
  assert(qrow(dur.id).status === 'pending', 'still pending after the run ended', qrow(dur.id));
  assert(card(dur.id).status === 'pending', 'and its card is still asking', card(dur.id));
  const carried = aos.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE type = 'question.carried' AND data LIKE ?").get(`%${dur.id}%`);
  assert(carried.n === 1, 'the carry is audited', carried);

  console.log('\n\x1b[1m3) A late human answer is delivered to the agent\x1b[0m');
  delivered.length = 0;
  assert(tm.answerQuestion(dur.id, 'Yes, build it', owner.id) === true, 'the answer lands on a finished run');
  assert(qrow(dur.id).status === 'answered' && qrow(dur.id).answer === 'Yes, build it', 'and is recorded', qrow(dur.id));
  assert(delivered.length === 1 && delivered[0].answer === 'Yes, build it' && !delivered[0].defaulted, 'the deliverer is handed the answer (→ wake queue)', delivered);

  console.log('\n\x1b[1m4) A live asker is left to its own polling\x1b[0m');
  // Delivery keys off REACHABILITY (is the pane there), never the row's status — the lesson from the four
  // poke-lane bugs in edge/wakeups.ts. This harness has no tmux at all, so every run reads unreachable;
  // stub the one question to pin the rule rather than the harness.
  delivered.length = 0;
  const s4 = mkSession();
  const live = await ask(s4, { question: 'Pick one', options: ['A', 'B'], default: 'A' });
  const realReachable = tm.reachable.bind(tm);
  tm.reachable = (id) => (id === s4 ? true : realReachable(id));
  tm.answerQuestion(live.id, 'B', owner.id);
  tm.reachable = realReachable;
  assert(delivered.length === 0, 'no wake-up while its pane is alive — it is polling /api/ask/:id itself', delivered);
  assert(qrow(live.id).answer === 'B', 'the answer is still recorded either way', qrow(live.id));

  console.log('\n\x1b[1m5) The deadline applies the default, and tells the agent\x1b[0m');
  delivered.length = 0;
  const s5 = mkSession();
  const late = await ask(s5, { question: 'Press the indexing button?', options: ['Done', 'Skip it'], default: 'Skip it', deadlineHours: 2 });
  tm.stopSession(s5, 'system');
  assert(tm.sweepExpiredQuestions(Date.now() + HOUR).length === 0, 'nothing expires before its deadline');
  const swept = tm.sweepExpiredQuestions(Date.now() + 3 * HOUR);
  assert(swept.length === 1 && swept[0].outcome === 'defaulted', 'past the deadline it defaults', swept);
  const row5 = qrow(late.id);
  assert(row5.status === 'answered' && row5.answer === 'Skip it' && row5.answered_by === 'system:default', 'the default is the answer, attributed to the system', row5);
  assert(card(late.id).status === 'cancelled', 'the card stops asking', card(late.id));
  assert(delivered.length === 1 && delivered[0].defaulted === true, 'the agent is told the DEADLINE decided, not a person', delivered);
  const audited = aos.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE type = 'question.defaulted' AND data LIKE ?").get(`%${late.id}%`);
  assert(audited.n === 1, 'and it is audited as defaulted', audited);

  console.log('\n\x1b[1m6) A deadline with no default just expires\x1b[0m');
  const s6 = mkSession();
  const nodflt = await ask(s6, { question: 'Anything to add?', deadlineHours: 1 });
  const swept6 = tm.sweepExpiredQuestions(Date.now() + 2 * HOUR);
  assert(swept6.some((r) => r.id === nodflt.id && r.outcome === 'expired'), 'expired, not answered', swept6);
  assert(qrow(nodflt.id).status === 'cancelled', 'it ends cancelled — nothing is invented for the agent', qrow(nodflt.id));

  console.log('\n\x1b[1m7) Multi-pick\x1b[0m');
  const s7 = mkSession();
  const many = await ask(s7, { question: 'Which communities?', options: ['Forum', 'Reddit', 'HN'], multi: true });
  assert(qrow(many.id).kind === 'many', 'kind is many', qrow(many.id));
  assert(JSON.parse(card(many.id).args).multi === true, 'the card is told to render multi-select', card(many.id).args);
  assert(tm.answerQuestion(many.id, 'Forum, HN', owner.id) === true, 'a joined answer is accepted');
  const bad = await ask(mkSession(), { question: 'Which?', multi: true });
  assert(/options/.test(bad.error || ''), 'multi with no options is refused', bad);

  console.log('\n\x1b[1m8) Bounds and validation\x1b[0m');
  const clampLow = await ask(mkSession(), { question: 'Soon?', default: 'no', deadlineHours: 0.1 });
  assert(Math.abs(clampLow.expiresAt - (Date.now() + HOUR)) < 5000, 'under an hour is clamped UP to an hour — nothing shorter is answerable', clampLow);
  const clampHigh = await ask(mkSession(), { question: 'Someday?', default: 'no', deadlineHours: 10_000 });
  assert(Math.abs(clampHigh.expiresAt - (Date.now() + 168 * HOUR)) < 5000, 'over a week is clamped DOWN to a week', clampHigh);
  const noDeadline = await ask(mkSession(), { question: 'Ship it?', default: 'hold' });
  assert(Math.abs(noDeadline.expiresAt - (Date.now() + 168 * HOUR)) < 5000, 'a default with no deadline gets the ceiling, never "eventually"', noDeadline);
  const mismatch = await ask(mkSession(), { question: 'Pick', options: ['A', 'B'], default: 'C' });
  assert(/must be one of the options/.test(mismatch.error || ''), 'a default outside the options is refused', mismatch);

  console.log('\n\x1b[1m9) A question can belong to a goal\x1b[0m');
  const goal = aos.goals.create({ tenant: aos.tenant, title: 'Clicks', metric: { name: 'clicks', target: 100, baseline: 0, direction: 'up', everyDays: 1 }, owner: owner.id, createdBy: owner.id });
  const tied = await ask(mkSession(), { question: 'Which lever next?', options: ['Pages', 'Links'], default: 'Pages', goal: goal.id });
  assert(qrow(tied.id).goal_id === goal.id, 'the goal id is stored', qrow(tied.id));
  const badGoal = await ask(mkSession(), { question: 'x', default: 'y', goal: 'goal_nope' });
  assert(/no goal/.test(badGoal.error || ''), 'an unknown goal is refused rather than silently dropped', badGoal);

  server.close();
  registry.stopAll?.();
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} process.exit(1); });
