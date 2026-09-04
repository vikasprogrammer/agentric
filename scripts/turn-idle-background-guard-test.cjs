#!/usr/bin/env node
/* Turn-end background guard — the falsifier for `pendingBackgroundWork` + `markTurnIdle`'s defer.
 *
 * The bug it pins (instapods ses_11dd20920d30aae4, 2026-08-11): an unattended run launched a review
 * subagent, ended its turn to wait for it, and the Stop-hook teardown killed the run and the subagent
 * mid-work — so it never reached `report` and landed as "no report". The guard defers teardown while
 * background children are outstanding, bounded by BACKGROUND_GRACE_MS and only for a run that has NOT
 * already reported.
 *
 * Isolated home + a fake CLAUDE_CONFIG_DIR holding fixture transcripts; backend stubbed, no real tmux. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-bgguard-test-'));
const CLAUDE = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-bgguard-claude-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
delete process.env.AGENT_OS_SECRET_KEY;
const PROJECTS = path.join(CLAUDE, 'projects', 'fixture');
fs.mkdirSync(PROJECTS, { recursive: true });

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { pendingBackgroundWork, BACKGROUND_GRACE_MS, UNATTENDED_TURN_BRIEF } = require(path.join(ROOT, 'dist/edge/background-work.js'));
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

// ── transcript fixtures — the exact shapes Claude Code writes ──────────────────────────────────────
const bgShellAck = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id,
  content: `Command running in background with ID: bx${id}. Output is being written to: /tmp/tasks/bx${id}.output. You will be notified when it completes.` }] } });
const subagentAck = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text',
  text: 'Async agent launched successfully. (This tool result is internal metadata …)\nagentId: af69c6436eaec35f8\nThe agent is working in the background.' }] }] } });
// The shape the incident ACTUALLY used — `/code-review` as a forked Skill run. Reads nothing like the
// other two acks, and a detector written from those alone would have missed the run it was built for.
const skillAck = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id,
  content: 'Skill "code-review" launched (forked execution, running in the background).\n\nRunning in the background as @code-review' }] } });
const notification = (id, status) => ({ type: 'user', message: { content:
  `<task-notification>\n<task-id>t_${id}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status || 'completed'}</status>\n</task-notification>` } });
const syncAgentResult = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id,
  content: [{ type: 'text', text: 'internal/git/deploy.go:117: 🟡 risk: path concatenated into a bash command.' }] }] } });

let fx = 0;
const writeTranscript = (rows) => {
  const id = `fixture-${++fx}`;
  fs.writeFileSync(path.join(PROJECTS, `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path.join(PROJECTS, `${id}.jsonl`);
};

console.log('\n\x1b[1m1) pendingBackgroundWork — launch acks vs completion notifications\x1b[0m');
assert(pendingBackgroundWork(undefined) === null, 'no transcript → null (fails open)');
assert(pendingBackgroundWork(path.join(PROJECTS, 'nope.jsonl')) === null, 'missing file → null (fails open)');
assert(pendingBackgroundWork(writeTranscript([])) === null, 'empty transcript → null');

const shellOnly = pendingBackgroundWork(writeTranscript([bgShellAck('toolu_A')]));
assert(shellOnly && shellOnly.shell === 1 && shellOnly.subagents === 0 && shellOnly.count === 1, 'background Bash, no notification → 1 pending shell');
assert(pendingBackgroundWork(writeTranscript([bgShellAck('toolu_A'), notification('toolu_A')])) === null, '…notification for that id clears it');
assert(pendingBackgroundWork(writeTranscript([bgShellAck('toolu_A'), notification('toolu_A', 'killed')])) === null, '…a killed/failed notification clears it too');

const sub = pendingBackgroundWork(writeTranscript([subagentAck('toolu_B')]));
assert(sub && sub.subagents === 1 && sub.shell === 0, 'async subagent launch → 1 pending subagent');
assert(pendingBackgroundWork(writeTranscript([subagentAck('toolu_B'), notification('toolu_B')])) === null, '…its notification clears it');
assert(pendingBackgroundWork(writeTranscript([syncAgentResult('toolu_C')])) === null, 'a SYNCHRONOUS subagent (result inline) is not pending work');

const other = pendingBackgroundWork(writeTranscript([subagentAck('toolu_B'), notification('toolu_ZZZ')]));
assert(other && other.count === 1, 'a notification for a different id does NOT clear it');

const skill = pendingBackgroundWork(writeTranscript([skillAck('toolu_D')]));
assert(skill && skill.skills === 1 && skill.count === 1, 'a forked Skill run (`/code-review`) → 1 pending skill');
assert(pendingBackgroundWork(writeTranscript([skillAck('toolu_D'), notification('toolu_D', 'killed')])) === null, '…its notification clears it');

// The incident itself: PR pushed, `/code-review` forked, two never-ending sleep loops, turn ended.
const incident = pendingBackgroundWork(writeTranscript([
  skillAck('toolu_review'), bgShellAck('toolu_sleep1'), bgShellAck('toolu_sleep2'),
  { type: 'assistant', message: { content: [{ type: 'text', text: "PR #502 is open and the code review is still running." }] } },
]));
assert(incident && incident.count === 3 && incident.skills === 1 && incident.shell === 2, 'the ses_11dd2092 shape → 3 outstanding children');

const mixed = pendingBackgroundWork(writeTranscript([
  bgShellAck('toolu_A'), notification('toolu_A'), subagentAck('toolu_B'),
]));
assert(mixed && mixed.count === 1 && mixed.subagents === 1, 'one finished + one running → only the running one counts');

const torn = path.join(PROJECTS, 'torn.jsonl');
fs.writeFileSync(torn, JSON.stringify(subagentAck('toolu_B')) + '\n{"message":{"content":[{"type":"tool_res');
assert(pendingBackgroundWork(torn)?.count === 1, 'a half-flushed final line does not lose the lines before it');

console.log('\n\x1b[1m2) markTurnIdle — defer while children run, bounded by the grace\x1b[0m');
const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const killed = [];
tm.backend.hasClient = () => false;
tm.backend.kill = (_space, tmux) => { killed.push(tmux); };
tm.backend.aliveNames = () => new Set(aos.db.prepare('SELECT tmux FROM term_sessions').all().map((r) => r.tmux));

let n = 0;
const mkSession = (o, rows) => {
  const id = 'ts_' + (++n);
  const claudeId = `cs-${id}`;
  if (rows) fs.writeFileSync(path.join(PROJECTS, `${claudeId}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,claimed_by,spawned_by,run_as,claude_session_id,created_at,updated_at)
    VALUES (@id,@agent,@title,@task,@tmux,@status,@headless,@resident,@claimed_by,@spawned_by,NULL,@claude_session_id,@created_at,@updated_at)`)
    .run({ id, agent: 'engineer', title: 't', task: 'x', tmux: 'aos-' + id, status: 'running', headless: 1, resident: 0,
      claimed_by: null, spawned_by: 'task:tsk_1', claude_session_id: rows ? claudeId : null, created_at: Date.now(), updated_at: Date.now(), ...o });
  return id;
};
const statusOf = (id) => aos.db.prepare('SELECT status s FROM term_sessions WHERE id=?').get(id).s;
const events = (id) => aos.db.prepare('SELECT type, data FROM audit_events WHERE run_id=? ORDER BY id').all(id);
const reapReason = (id) => { const e = events(id).filter((x) => x.type === 'session.reaped').pop(); return e ? JSON.parse(e.data).reason : null; };
const deferrals = (id) => events(id).filter((x) => x.type === 'session.turnend.deferred');

const plain = mkSession({}, [{ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }]);
tm.markTurnIdle(plain);
assert(killed.includes('aos-' + plain), 'no background work → torn down at turn-end, exactly as before');
assert(reapReason(plain) === 'turn-end', '…audited as reason "turn-end"');

const waiting = mkSession({}, [skillAck('toolu_review'), bgShellAck('toolu_sleep1')]);
tm.markTurnIdle(waiting);
assert(!killed.includes('aos-' + waiting), 'children still running → pane NOT killed');
assert(statusOf(waiting) === 'running', '…row left running');
const d = deferrals(waiting);
assert(d.length === 1 && JSON.parse(d[0].data).count === 2, '…one session.turnend.deferred, carrying the child count');
assert(JSON.parse(d[0].data).graceMs === BACKGROUND_GRACE_MS, '…and the grace it is measured against');

tm.markTurnIdle(waiting);
assert(!killed.includes('aos-' + waiting), 'a second turn-end inside the grace still defers');
assert(deferrals(waiting).length === 2, '…and is audited again');

// Renewal check: the grace clock is per RUN, so backdating the FIRST defer expires it however many
// turns have ended since. A never-ending sleep loop must not buy an immortal pane.
tm.turnEndDeferred.set(waiting, Date.now() - BACKGROUND_GRACE_MS - 1000);
tm.markTurnIdle(waiting);
assert(killed.includes('aos-' + waiting), 'past the grace → torn down even though children are still pending');
assert(reapReason(waiting) === 'turn-end-grace-expired', '…audited distinctly, so the wait is queryable');
assert(!tm.turnEndDeferred.has(waiting), '…and the defer clock is dropped');

const reported = mkSession({ status: 'done' }, [subagentAck('toolu_review')]);
tm.markTurnIdle(reported);
assert(killed.includes('aos-' + reported), 'a run that already REPORTED (done) is torn down despite a stray child');
assert(deferrals(reported).length === 0, '…with no defer at all — report means finished');

const claimed = mkSession({ claimed_by: 'm_alice' }, [subagentAck('toolu_review')]);
tm.markTurnIdle(claimed);
assert(!killed.includes('aos-' + claimed) && deferrals(claimed).length === 0, 'a claimed take-over is still the human\'s — untouched, no defer');

const interactive = mkSession({ headless: 0 }, [subagentAck('toolu_review')]);
tm.markTurnIdle(interactive);
assert(!killed.includes('aos-' + interactive) && deferrals(interactive).length === 0, 'an interactive session is untouched, as before');

const noTranscript = mkSession({});
tm.markTurnIdle(noTranscript);
assert(killed.includes('aos-' + noTranscript), 'no transcript to read → fails OPEN and tears down (never a stuck pane)');

console.log('\n\x1b[1m3) the unattended prompt brief\x1b[0m');
for (const tool of ['task_wait', 'ask', 'schedule', 'task_create', 'report'])
  assert(UNATTENDED_TURN_BRIEF.includes(tool), `names \`${tool}\` — an agent told "don't wait" needs the alternative`);
assert(/sleep/i.test(UNATTENDED_TURN_BRIEF), 'names the sleep/poll anti-pattern the incident invented');
const unattendedMd = tm.buildCompanyMd('engineer', undefined, true);
const interactiveMd = tm.buildCompanyMd('engineer', undefined, false);
assert(unattendedMd.includes(UNATTENDED_TURN_BRIEF), 'injected into an unattended run\'s prompt');
assert(!interactiveMd.includes(UNATTENDED_TURN_BRIEF), 'NOT injected into an attended/resident one (there it would be false)');
assert(tm.buildCompanyMd('engineer').indexOf(UNATTENDED_TURN_BRIEF) === -1, 'defaults to off when the lane is not stated');

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}TURN-END BACKGROUND GUARD: ${pass}/${pass + fail} passed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
try { fs.rmSync(CLAUDE, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
