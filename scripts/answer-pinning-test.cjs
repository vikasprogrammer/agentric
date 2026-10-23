#!/usr/bin/env node
/* A late answer goes back to the SESSION THAT ASKED — never to another run of the same agent.
 *
 * A durable `ask` outlives its run, so its answer is delivered after the asker has gone. Both delivery
 * paths used to pick a transcript by agent, not by question:
 *   - the wake queue typed it into any live SIBLING of the agent, or coalesced it with other pending
 *     wake-ups and resumed whichever transcript was newest;
 *   - the task path resumed the newest `task:<id>` run, which is not the asker when the asker claimed the
 *     task from a chat/cron run.
 * Live symptom: an infra-ops answer ("apply the hotfix") landing in a different infra-ops conversation.
 *
 * Pins:
 *   1 cold asker + a live sibling (same agent, same run-as) → the asker's transcript is RESUMED, the
 *     sibling is not touched;
 *   2 asker pane still live + a newer sibling → injected into the asker's own pane;
 *   3 an answer never coalesces with a pending poke for another transcript;
 *   4 the delivered message names the question and the asking session;
 *   5 task path: the asker (a chat run that claimed the task) is resumed, not an older `task:` run — and
 *     not while its pane is still up.
 *
 * Real tenant wiring (TenantRegistry), isolated home; createSession + panes stubbed — no tmux/claude. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-answer-pin-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
process.env.AOS_ANSWER_RETRY_MS = '40';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, tm, autos } = registry.default();
  aos.agents.set('infra', { id: 'infra', name: 'Infra', runtime: 'claude-code', dir: HOME });
  const owner = aos.team.listMembers().find((m) => m.role === 'owner');

  const alive = new Set();
  const injected = [];
  tm.backend.aliveNames = () => new Set(alive);
  tm.backend.injectText = (_s, tmux, text) => { injected.push({ tmux, text }); return alive.has(tmux); };
  tm.backend.capturePane = () => '';
  tm.backend.hasClient = () => false;

  let sn = 0, clock = Date.now() - 3_600_000;
  const mkRun = (spawnedBy, cs, live = true) => {
    const id = 'ses_ap' + (++sn);
    aos.db.prepare('INSERT INTO term_sessions (id,agent,title,task,tmux,status,spawned_by,run_as,headless,claude_session_id,secret,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)')
      .run(id, 'infra', 't', 'x', 'aos-' + id, 'running', spawnedBy, owner.id, cs ?? 'cs_' + id, 'sec', (clock += 1000), clock);
    if (live) alive.add('aos-' + id);
    return id;
  };
  const end = (sid) => { alive.delete('aos-' + sid); aos.db.prepare("UPDATE term_sessions SET status='done' WHERE id=?").run(sid); };
  const spawned = [];
  tm.createSession = (agent, title, task, spawnedBy, _h, _s, _d, _runAs, resumeClaudeId) => {
    const id = mkRun(spawnedBy, resumeClaudeId ?? undefined);
    spawned.push({ id, task, spawnedBy, resume: resumeClaudeId ?? null });
    if (spawnedBy?.startsWith('task:')) aos.db.prepare('UPDATE tasks SET last_session_id = ? WHERE id = ?').run(id, spawnedBy.slice(5));
    return { id, tmux: 'aos-' + id };
  };
  const durable = { defaultAnswer: 'Hold', expiresAt: Date.now() + 3_600_000 };
  const ask = (sid, prompt) => tm.askQuestion(sid, 'infra', prompt, undefined, ['Apply', 'Hold'], durable).id;
  const csOf = (sid) => aos.db.prepare('SELECT claude_session_id AS cs FROM term_sessions WHERE id = ?').get(sid).cs;
  const quiet = () => { for (const t of [...alive]) alive.delete(t); };

  console.log('\n\x1b[1m1) cold asker + a live sibling → resume the ASKER, leave the sibling alone\x1b[0m');
  {
    const asker = mkRun('automation:cron');
    const qid = ask(asker, 'Apply the nr_open hotfix?');
    end(asker);
    const sibling = mkRun('automation:other');               // same agent, same run-as, unbound: the old sibling lane
    const before = spawned.length;
    injected.length = 0;
    tm.answerQuestion(qid, 'Apply', owner.email);
    assert(!injected.some((i) => i.tmux === 'aos-' + sibling), 'nothing typed into the sibling', injected);
    assert(spawned.length === before + 1 && spawned.at(-1).resume === csOf(asker), 'the asker\'s own transcript was resumed', spawned.slice(before));
    assert(/A: Apply/.test(spawned.at(-1).task), 'with the answer in it', spawned.at(-1)?.task);
    assert(spawned.at(-1).task.includes(qid) && spawned.at(-1).task.includes(asker), 'naming the question and the asking session', spawned.at(-1)?.task);
    const row = aos.db.prepare("SELECT kind, delivered_via, delivered_session FROM agent_wakeups WHERE source = ?").get('question:' + qid);
    assert(row.kind === 'answer' && row.delivered_via === 'resume', 'recorded as a pinned answer wake-up', row);
    quiet();
  }

  console.log('\n\x1b[1m2) asker pane still up + a NEWER sibling → inject into the asker\'s own pane\x1b[0m');
  {
    const asker = mkRun('automation:cron');
    const qid = ask(asker, 'Restart nginx?');
    mkRun('automation:other');                               // newer, so it would have been first in the old pool
    const before = spawned.length;
    injected.length = 0;
    tm.answerQuestion(qid, 'Hold', owner.email);
    // A live asker polls /api/ask itself — answerQuestion only queues when it is unreachable. Make it so,
    // then let the asker's pane come back (a human re-attached) before the queue retries.
    assert(injected.length === 0 && spawned.length === before, 'a live asker is left to pick the answer up itself', { injected, spawned: spawned.length - before });
    quiet();
  }
  {
    const asker = mkRun('automation:cron');
    const qid = ask(asker, 'Rotate the cert?');
    end(asker);
    autos.wakeups.enqueue({ agent: 'infra', transcript: 'cs_block', source: 'tsk_hold', kind: 'poke-blocked', message: 'held' }, { budget: 0 });
    const sibling = mkRun('automation:other');
    alive.add('aos-' + asker);                               // the asker's pane is reachable again
    aos.db.prepare("UPDATE term_sessions SET status='running' WHERE id=?").run(asker);
    injected.length = 0;
    const r = autos.wakeups.enqueue({ agent: 'infra', transcript: csOf(asker), source: 'question:' + qid, kind: 'answer', message: 'A: Rotate' });
    assert(r.ok && r.via === 'inject' && r.sessionId === asker, 'the answer went into the asker\'s pane', r);
    assert(!injected.some((i) => i.tmux === 'aos-' + sibling && /Rotate/.test(i.text)), 'not into the sibling', injected);
    quiet();
    aos.db.prepare("UPDATE agent_wakeups SET status='dropped' WHERE status='pending'").run();
  }

  console.log('\n\x1b[1m3) an answer never coalesces with a pending poke for another transcript\x1b[0m');
  {
    autos.wakeups.enqueue({ agent: 'infra', transcript: 'cs_other_caller', source: 'tsk_x', kind: 'poke-blocked', message: 'POKE: delegate handed tsk_x back' }, { budget: 0 });
    const asker = mkRun('automation:cron');
    const qid = ask(asker, 'Proceed with 13127?');
    end(asker);
    const before = spawned.length;
    tm.answerQuestion(qid, 'Apply', owner.email);
    const got = spawned.slice(before);
    assert(got.length === 1 && got[0].resume === csOf(asker), 'one resume, on the asker\'s transcript', got);
    assert(!/POKE:/.test(got[0]?.task ?? ''), 'the poke was not folded into the answer', got[0]?.task);
    const poke = aos.db.prepare("SELECT status FROM agent_wakeups WHERE source = 'tsk_x'").get();
    assert(poke.status === 'pending', 'the poke waits for its own delivery (one new claude per pass)', poke);
    quiet();
    autos.wakeups.sweep();
    const last = spawned.at(-1);
    assert(last.resume === 'cs_other_caller' && /POKE:/.test(last.task), 'and the next pass resumes ITS caller', last);
    quiet();
  }

  console.log('\n\x1b[1m4) task path: resume the asker, not the newest task run — and wait for its pane\x1b[0m');
  {
    const task = aos.tasks.create({ tenant: aos.tenant, title: 'group-15 renewals', body: '', owner: owner.id, createdBy: owner.id, assignee: 'agent:infra' });
    const older = mkRun('task:' + task.id, 'cs_old_task_run', false);   // an earlier dispatched run
    const asker = mkRun('chat:infra');                                  // claimed the task from chat
    aos.db.prepare('UPDATE tasks SET last_session_id = ? WHERE id = ?').run(asker, task.id);
    const qid = ask(asker, 'Apply the hotfix on all 11?');
    aos.tasks.update(task.id, { status: 'blocked', blockedOn: 'human', note: 'waiting', by: 'agent:infra' });
    const before = spawned.length;
    tm.answerQuestion(qid, 'Apply', owner.email);
    await sleep(120);
    assert(spawned.length === before, 'no dispatch while the asker\'s pane is still up', spawned.slice(before));
    end(asker);
    await sleep(150);
    const got = spawned.slice(before);
    assert(got.length === 1 && got[0].spawnedBy === 'task:' + task.id, 'dispatched once, as the task', got);
    assert(got[0]?.resume === csOf(asker) && got[0]?.resume !== csOf(older), 'resuming the ASKER\'s transcript', got[0]);
    assert(got[0]?.task.includes(asker) && /A: Apply/.test(got[0]?.task), 'with the answer and the asking session in the prompt', got[0]?.task.slice(-300));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  registry.stopAll?.();
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
