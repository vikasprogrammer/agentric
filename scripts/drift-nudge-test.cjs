#!/usr/bin/env node
/* DRIFT FOCUS CHECK — the rabbit-hole nudge (src/edge/drift.ts).
 *
 * What has to hold, in the order it matters:
 *
 *   1. It never costs the gate anything. The judge runs out of band; a tool call is never delayed, and a
 *      broken/garbled/absent judge can only ever mean "no nudge" — never a false "drifted".
 *   2. It is quiet by construction: nothing before a run has done real work, one judgement per interval,
 *      a low-confidence "drifted" is ignored, one human card per drifting streak (and none for a run a
 *      human is already watching).
 *   3. The note is advisory copy, not an order — coercive framing is flagged by the model as injection.
 *   4. The progress strip says `drifting`, below the more certain `circling`/`blocked`, and stops saying
 *      it once the run comes back or the verdict ages out.
 *
 * Run: node scripts/drift-nudge-test.cjs   (needs `npm run build` first) */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-drift-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;
delete process.env.AOS_DRIFT;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));
const eq = (a, b, name) => assert(a === b, name, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const D = require(path.join(ROOT, 'dist/edge/drift.js'));
const { deriveProgress } = require(path.join(ROOT, 'dist/state/session-progress.js'));
const { classifyActivity } = require(path.join(ROOT, 'dist/state/session-activity.js'));

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const J = (verdict, confidence = 0.9, tangent = 'the CI cache config', reason = 'none of it touches the webhook') => ({ verdict, confidence, tangent, reason });

console.log('\n\x1b[1mparseDriftJudgement — a garbled judge never reads as drifted\x1b[0m');
{
  const p = D.parseDriftJudgement;
  eq(p('{"verdict":"drifted","confidence":0.82,"tangent":"CI cache","reason":"unrelated"}')?.verdict, 'drifted', 'plain JSON');
  eq(p('```json\n{"verdict":"supporting","confidence":0.6,"tangent":"x","reason":"y"}\n```')?.verdict, 'supporting', 'fenced JSON');
  eq(p('Sure! {"verdict":"on_track","confidence":1,"tangent":"","reason":""} hope that helps')?.verdict, 'on_track', 'prose around the object');
  eq(p('{"verdict":"maybe","confidence":0.9}'), null, 'unknown verdict → null');
  eq(p('drifted'), null, 'bare word → null');
  eq(p('{not json}'), null, 'broken JSON → null');
  eq(p(null), null, 'no reply → null');
  eq(p('{"verdict":"drifted","confidence":7}').confidence, 1, 'confidence clamped to 1');
  eq(p('{"verdict":"drifted","confidence":"high"}').confidence, 0, 'non-numeric confidence → 0 (so it can never clear the floor)');
}

console.log('\n\x1b[1mbuildDriftInput — what the judge sees\x1b[0m');
{
  const convo = (turns) => ({ found: true, turns });
  eq(D.buildDriftInput('', convo([{ kind: 'assistant', text: 'hi', ts: 1 }])), null, 'no ask → nothing to judge');
  eq(D.buildDriftInput('fix it', { found: false, turns: [] }), null, 'no transcript → nothing to judge');
  const turns = [
    { kind: 'user', text: 'fix the refund webhook', ts: 1 },
    { kind: 'activity', tool: 'Bash', label: 'Ran a command', detail: 'npm test', status: 'error', ts: 2 },
    { kind: 'user', text: 'actually, look at the CI cache first', ts: 3 },
    { kind: 'assistant', text: 'Looking at CI.', ts: 4 },
  ];
  const input = D.buildDriftInput('fix the refund webhook', convo(turns));
  assert(input.startsWith('ORIGINAL REQUEST:\nfix the refund webhook'), 'leads with the original request');
  assert(/LATER HUMAN MESSAGES[\s\S]*look at the CI cache first/.test(input), 'a human redirection is surfaced as its own section (the latest instruction IS the ask)');
  assert(!/LATER HUMAN MESSAGES[\s\S]*- fix the refund webhook/.test(input), 'the first human turn (the ask itself) is not repeated as a redirection');
  assert(input.includes('· Ran a command — npm test [failed]'), 'tool activity rendered with status');
  const many = Array.from({ length: 400 }, (_, i) => ({ kind: 'assistant', text: `step ${i} ` + 'x'.repeat(280), ts: i }));
  const big = D.buildDriftInput('ask', convo(many));
  assert(big.length < 13_000, 'bounded input on a long run', `len ${big.length}`);
  assert(big.includes('step 399'), 'keeps the TAIL — the rabbit hole is at the end');
}

console.log('\n\x1b[1mDriftMonitor — trigger cadence\x1b[0m');
{
  const m = new D.DriftMonitor();
  let fired = 0;
  for (let i = 1; i < D.DRIFT_FIRST_CHECK_ACTIONS; i++) if (m.observe('s', NOW)) fired++;
  eq(fired, 0, `no judgement before ${D.DRIFT_FIRST_CHECK_ACTIONS} actions`);
  assert(m.observe('s', NOW), `judgement due at action ${D.DRIFT_FIRST_CHECK_ACTIONS}`);
  let during = 0;
  for (let i = 0; i < 50; i++) if (m.observe('s', NOW + 20 * MIN)) during++;
  eq(during, 0, 'at most one judgement in flight per session');
  m.record('s', J('on_track'));
  eq(m.observe('s', NOW + MIN), false, 'enough actions but inside the min interval → not yet');
  assert(m.observe('s', NOW + D.DRIFT_MIN_INTERVAL_MS + MIN), 'actions + interval both satisfied → due');
  m.abort('s');
  const m2 = new D.DriftMonitor();
  for (let i = 0; i < D.DRIFT_FIRST_CHECK_ACTIONS - 1; i++) m2.observe('x', NOW);
  let t = NOW;
  let judged = 0;
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < D.DRIFT_EVERY_ACTIONS; i++) if (m2.observe('x', t)) { judged++; m2.abort('x'); }
    t += D.DRIFT_MIN_INTERVAL_MS;
  }
  eq(judged, D.DRIFT_MAX_FAILURES, `a failing backend is given up on after ${D.DRIFT_MAX_FAILURES} failures`);
  const m3 = new D.DriftMonitor();
  let t3 = NOW;
  for (let i = 0; i < D.DRIFT_FIRST_CHECK_ACTIONS - 1; i++) m3.observe('y', t3);
  let clean = 0;
  for (let round = 0; round < 10; round++) {
    for (let k = 0; k < D.DRIFT_EVERY_ACTIONS; k++) if (m3.observe('y', t3)) { clean++; m3.abort('y', false); }
    t3 += D.DRIFT_MIN_INTERVAL_MS;
  }
  eq(clean, 10, 'a non-failure abort (nothing to read yet) never counts toward giving up');
}

console.log('\n\x1b[1mDriftMonitor — streak outcomes\x1b[0m');
{
  const m = new D.DriftMonitor();
  eq(m.record('s', J('on_track')), 'none', 'on_track, no streak → none');
  eq(m.record('s', J('drifted', 0.5)), 'none', `a drifted verdict below ${D.DRIFT_MIN_CONFIDENCE} confidence is not acted on`);
  eq(m.record('s', J('drifted'), 'NOTE-1'), 'detected', 'first confident drift → detected (nudge)');
  eq(m.takeNote('s'), 'NOTE-1', 'the note is parked for the next tool call');
  eq(m.takeNote('s'), undefined, '… and delivered once');
  eq(m.record('s', J('drifted'), 'NOTE-2'), 'escalated', 'still drifted after the nudge → escalated (human told)');
  eq(m.takeNote('s'), 'NOTE-2', 'escalation also re-nudges the agent');
  eq(m.record('s', J('drifted'), 'NOTE-3'), 'persisting', 'still drifted after escalation → persisting (no second card)');
  eq(m.takeNote('s'), undefined, 'persisting parks no further note (no nagging)');
  eq(m.record('s', J('supporting')), 'cleared', 'back to supporting work → cleared');
  eq(m.record('s', J('drifted'), 'NOTE-4'), 'detected', 'a NEW streak starts over at detected');
  eq(m.record('s', J('on_track')), 'cleared', 'clearing drops the streak …');
  eq(m.takeNote('s'), undefined, '… and any undelivered note with it');
  const obs = new D.DriftMonitor();
  obs.record('o', J('drifted'), undefined);
  eq(obs.takeNote('o'), undefined, 'observe mode (no note passed) never parks a nudge');
  m.forget('s');
  eq(m.record('s', J('drifted'), 'N'), 'detected', 'forget() resets the session');
}

console.log('\n\x1b[1mCopy — advisory, not coercive\x1b[0m');
{
  const note = D.driftNote('Fix the refund webhook\nmore detail below', J('drifted'));
  assert(note.startsWith('Agentric focus check:'), 'branded');
  assert(note.includes('“Fix the refund webhook”'), 'quotes the ask gist (first line only)');
  assert(note.includes('the CI cache config'), 'names what the work is about');
  assert(/carry on/.test(note) && /can be wrong/.test(note), 'explicitly allows "this is needed, carry on"');
  assert(note.includes('task_create'), 'offers the constructive move: park the tangent as a task');
  assert(!/\b(?:MUST|DO NOT|NEVER|REQUIRED|immediately)\b/.test(note), 'no coercive framing');
  const body = D.driftEscalationBody('Fix it', J('drifted'));
  assert(/Asked: “Fix it”/.test(body) && /Now working on: the CI cache config/.test(body), 'escalation card says asked vs now');
  eq(D.askGist('\n\n   Title line   \nrest'), 'Title line', 'gist = first non-empty line');
}

console.log('\n\x1b[1mProgress strip — `drifting`\x1b[0m');
{
  const base = { now: NOW, claims: [], lastActivityTs: NOW - MIN, loopTs: null, awaiting: null };
  const drift = (agoMin, drifting = true) => ({ ts: NOW - agoMin * MIN, drifting, tangent: 'the CI cache config' });
  const v = (o) => deriveProgress({ ...base, ...o });
  eq(v({ drift: drift(2) }).verdict, 'drifting', 'a recent drifted judgement → drifting');
  assert(/CI cache/.test(v({ drift: drift(2) }).reason), 'reason names the tangent');
  eq(v({ drift: drift(2, false) }).verdict, 'forward', 'a newer clearing judgement → not drifting');
  eq(v({ drift: drift(45) }).verdict, 'forward', 'a drifted judgement older than the window ages out');
  eq(v({ drift: drift(2), awaiting: 'approval' }).verdict, 'blocked', 'blocked outranks drifting');
  eq(v({ drift: drift(2), loopTs: NOW - MIN, loopCount: 6 }).verdict, 'circling', 'circling (the more certain diagnosis) outranks drifting');
  eq(v({ drift: drift(2), lastActivityTs: NOW - 20 * MIN }).verdict, 'drifting', 'drifting outranks stuck');
  eq(v({}).verdict, 'forward', 'no judgement at all → unchanged behaviour');
}

console.log('\n\x1b[1mActivity trail — drift bookkeeping is not agent activity\x1b[0m');
for (const t of ['drift.judged', 'drift.judge_failed', 'drift.nudged', 'drift.escalated']) {
  eq(classifyActivity(t, {}), null, `${t} is noise (never "activity", never keeps a quiet run looking busy)`);
}

// ─── End-to-end through the real gate ───────────────────────────────────────────────────────────────
(async () => {
  console.log('\n\x1b[1mEnd-to-end — TerminalManager.gate + a stub Anthropic API\x1b[0m');
  let reply = '{"verdict":"drifted","confidence":0.9,"tangent":"the CI cache config","reason":"nothing here touches the webhook"}';
  // Optional per-request override queue, consumed before `reply` — lets a test script a split vote.
  const queue = [];
  const requests = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ url: req.url, key: req.headers['x-api-key'], body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: queue.length ? queue.shift() : reply }] }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${stub.address().port}`;

  const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
  const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
  const aos = loadAgentOS();
  const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'), 'https://aos.example.com');
  aos.settings.setAnthropicKey('sk-test-drift');
  aos.settings.setAnthropicModel('claude-opus-5'); // the judge must pin Haiku regardless of the Q&A model
  for (const id of ['builder', 'explorer']) {
    const dir = path.join(HOME, `agent-${id}`);
    fs.mkdirSync(dir, { recursive: true });
    aos.agents.set(id, { id, name: id, runtime: 'claude-code', dir, ...(id === 'explorer' ? { driftCheck: false } : {}) });
  }
  const owner = aos.team.invite({ email: 'owner@example.com', role: 'owner' }).member.id;
  let seq = 0;
  const mkRun = (agent, headless) => {
    const id = `ses_drift_${++seq}`;
    const t = Date.now();
    aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,spawned_by,run_as,headless,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, agent, 'refund fix', 'Fix the refund webhook so Stripe retries stop failing', `t${seq}`, 'running', owner, owner, headless ? 1 : 0, t, t);
    return id;
  };
  tm.sessionConversation = () => ({ found: true, turns: [
    { kind: 'user', text: 'Fix the refund webhook so Stripe retries stop failing', ts: 1 },
    { kind: 'activity', tool: 'Bash', label: 'Ran a command', detail: 'cat .github/workflows/ci.yml', status: 'ok', ts: 2 },
    { kind: 'assistant', text: 'The CI cache key looks wrong, let me rework the whole cache layer.', ts: 3 },
  ] });
  const settle = () => new Promise((r) => setTimeout(r, 150));
  let cmdSeq = 0;
  const bash = (sid, agent, n) => {
    const out = [];
    // Distinct, digit-free commands: the loop detector folds digit runs together, and its own note must
    // not be mistaken for (or mask) the drift note under test.
    const word = () => String(++cmdSeq).replace(/\d/g, (d) => 'abcdefghij'[d]);
    for (let i = 0; i < n; i++) out.push(tm.gate(sid, agent, 'shell.exec', { tool: 'Bash', input: { command: `ls ${word()}` } }, 'look around'));
    return out;
  };
  const audits = (sid, type) => aos.db.prepare('SELECT data FROM audit_events WHERE run_id = ? AND type = ? ORDER BY ts, id').all(sid, type).map((r) => JSON.parse(r.data));
  const cards = (sid) => aos.db.prepare("SELECT title, body FROM messages WHERE session_id = ? AND title LIKE 'Drifting%'").all(sid);

  // Unattended run, nudge mode (the default).
  const s1 = mkRun('builder', true);
  const t0 = Date.now();
  const first = bash(s1, 'builder', D.DRIFT_FIRST_CHECK_ACTIONS);
  assert(Date.now() - t0 < 1000, 'the gate never waits on the judge', `${Date.now() - t0}ms for ${first.length} calls`);
  assert(first.every((g) => g.decision === 'allow' && !g.note), 'no note on the calls that triggered the judgement');
  await settle();
  eq(audits(s1, 'drift.judged').length, 1, 'exactly one judgement after the first-check threshold');
  eq(requests.length, 1 + D.DRIFT_CONFIRM_VOTES, 'a drifted first vote is confirmed by extra votes');
  eq(audits(s1, 'drift.judged')[0]?.votes?.join(','), 'drifted,drifted,drifted', 'votes recorded on the audit row');
  eq(requests[0]?.body.model, 'claude-haiku-4-5', 'the judge pins Haiku even when the workspace Q&A model is Opus');
  eq(requests[0]?.key, 'sk-test-drift', 'uses the workspace Anthropic key');
  assert(/Fix the refund webhook/.test(requests[0]?.body.messages?.[0]?.content || ''), 'the ask reaches the judge');
  const [next] = bash(s1, 'builder', 1);
  eq(next.decision, 'allow', 'a drift note never changes the decision');
  assert(next.note && next.note.startsWith('Agentric focus check:'), 'the NEXT tool call carries the note');
  eq(bash(s1, 'builder', 1)[0].note, undefined, 'and only that one');
  eq(audits(s1, 'drift.judged')[0]?.outcome, 'detected', 'drift.judged audited with outcome detected');
  eq(audits(s1, 'drift.nudged').length, 1, 'drift.nudged audited once');
  eq(cards(s1).length, 0, 'no human card on the first drift — the agent gets a chance first');

  // Second check, still drifted → escalate once. Move the clock past the interval.
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  skew += D.DRIFT_MIN_INTERVAL_MS + MIN;
  bash(s1, 'builder', D.DRIFT_EVERY_ACTIONS);
  await settle();
  eq(audits(s1, 'drift.judged').length, 2, 'second judgement after interval + actions');
  eq(audits(s1, 'drift.judged')[1]?.outcome, 'escalated', 'still drifted → escalated');
  eq(cards(s1).length, 1, 'one Inbox card for the unattended run\'s owner');
  assert(/Now working on: the CI cache config/.test(cards(s1)[0]?.body || ''), 'the card says asked vs now');
  skew += D.DRIFT_MIN_INTERVAL_MS + MIN;
  bash(s1, 'builder', D.DRIFT_EVERY_ACTIONS + 1);
  await settle();
  eq(audits(s1, 'drift.judged')[2]?.outcome, 'persisting', 'third drifted verdict → persisting');
  eq(cards(s1).length, 1, 'still only one card per streak');

  // Came back to the ask.
  reply = '{"verdict":"on_track","confidence":0.95,"tangent":"refund webhook handler","reason":"editing the handler"}';
  skew += D.DRIFT_MIN_INTERVAL_MS + MIN;
  bash(s1, 'builder', D.DRIFT_EVERY_ACTIONS + 1);
  await settle();
  eq(audits(s1, 'drift.judged')[3]?.outcome, 'cleared', 'on_track after a streak → cleared');

  // A single noisy drifted vote that the confirmation votes overrule: no nudge.
  reply = '{"verdict":"drifted","confidence":0.9,"tangent":"the CI cache config","reason":"x"}';
  const s7 = mkRun('builder', true);
  const on = '{"verdict":"on_track","confidence":0.9,"tangent":"refund handler","reason":"y"}';
  queue.push(reply, on, on);
  const reqBefore = requests.length;
  bash(s7, 'builder', D.DRIFT_FIRST_CHECK_ACTIONS); await settle();
  eq(requests.length - reqBefore, 3, 'drifted first vote → two confirmation votes');
  eq(audits(s7, 'drift.judged')[0]?.outcome, 'none', '1 of 3 drifted is not a majority → no drift');
  eq(audits(s7, 'drift.judged')[0]?.verdict, 'on_track', 'the dissenting vote is recorded as the verdict');
  eq(bash(s7, 'builder', 1)[0].note, undefined, '… and no nudge');
  queue.push(on);
  const s8 = mkRun('builder', true);
  const reqBefore8 = requests.length;
  bash(s8, 'builder', D.DRIFT_FIRST_CHECK_ACTIONS); await settle();
  eq(requests.length - reqBefore8, 1, 'a non-drifted first vote costs exactly one call');
  queue.push(reply, on, reply);
  const s9 = mkRun('builder', true);
  bash(s9, 'builder', D.DRIFT_FIRST_CHECK_ACTIONS); await settle();
  eq(audits(s9, 'drift.judged')[0]?.outcome, 'detected', '2 of 3 drifted → confirmed');

  // Interactive run: nudged, but never carded (a human is already on it).
  reply = '{"verdict":"drifted","confidence":0.9,"tangent":"the CI cache config","reason":"x"}';
  const s2 = mkRun('builder', false);
  bash(s2, 'builder', D.DRIFT_FIRST_CHECK_ACTIONS); await settle();
  assert(bash(s2, 'builder', 1)[0].note, 'interactive run is nudged too');
  skew += D.DRIFT_MIN_INTERVAL_MS + MIN;
  bash(s2, 'builder', D.DRIFT_EVERY_ACTIONS); await settle();
  eq(audits(s2, 'drift.judged').pop()?.outcome, 'escalated', 'interactive run escalates in the audit/strip');
  eq(cards(s2).length, 0, '… but posts no Inbox card');

  // Per-agent opt-out.
  const before = requests.length;
  const s3 = mkRun('explorer', true);
  bash(s3, 'explorer', D.DRIFT_FIRST_CHECK_ACTIONS * 3); await settle();
  eq(requests.length, before, 'driftCheck:false agent is never judged');

  // Observe mode: judged + recorded, never nudged, never carded.
  aos.settings.setDriftMode('observe');
  const s4 = mkRun('builder', true);
  bash(s4, 'builder', D.DRIFT_FIRST_CHECK_ACTIONS); await settle();
  eq(audits(s4, 'drift.judged')[0]?.mode, 'observe', 'observe mode still judges');
  eq(bash(s4, 'builder', 1)[0].note, undefined, 'observe mode never nudges');
  skew += D.DRIFT_MIN_INTERVAL_MS + MIN;
  bash(s4, 'builder', D.DRIFT_EVERY_ACTIONS); await settle();
  eq(cards(s4).length, 0, 'observe mode never cards');

  // Off.
  aos.settings.setDriftMode('off');
  const before2 = requests.length;
  const s5 = mkRun('builder', true);
  bash(s5, 'builder', D.DRIFT_FIRST_CHECK_ACTIONS * 2); await settle();
  eq(requests.length, before2, 'off mode makes no model calls');

  // A garbled judge: failure audited, no nudge.
  aos.settings.setDriftMode('nudge');
  reply = 'I think it is probably fine?';
  const s6 = mkRun('builder', true);
  bash(s6, 'builder', D.DRIFT_FIRST_CHECK_ACTIONS); await settle();
  eq(audits(s6, 'drift.judge_failed')[0]?.reason, 'unparseable', 'an unparseable reply is audited as a failure');
  eq(bash(s6, 'builder', 1)[0].note, undefined, '… and never becomes a nudge');

  Date.now = realNow;
  stub.close();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
