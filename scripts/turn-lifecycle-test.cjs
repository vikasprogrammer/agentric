#!/usr/bin/env node
/* Turn/session lifecycle — the state machine behind the console's `working` ("a turn is running right
 * now") flag, driven by Claude Code's own hook events.
 *
 * The bug this pins: `busy_since` was a ONE-WAY LATCH. It was stamped at spawn / on a server-side
 * delivery, and cleared in exactly ONE place — the `resident` branch of `markTurnIdle`. A member's own
 * interactive session returns before that branch (`!r.headless`), so its flag was never cleared and the
 * console drew a spinner on it forever; every finished unattended run kept the flag too. Live northwind
 * had 24 of its 25 most recent rows — `done` and `stopped` ones included — carrying a `busy_since` hours
 * old. There was also no turn-START signal at all for a human typing straight into an attached TUI, and
 * no handler for `StopFailure`, which is the ONLY end signal a turn killed by a rate limit produces.
 *
 * Isolated home; the session backend is stubbed, so no tmux and no real `claude` are involved. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-turn-lifecycle-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));

let livePanes = new Set();
const killed = [];
tm.backend.aliveNames = () => new Set(livePanes);
tm.backend.spawn = (_s, o) => { livePanes.add(o.tmuxName); };
tm.backend.kill = (_s, tmux) => { killed.push(tmux); livePanes.delete(tmux); };
tm.backend.injectText = () => true;
tm.backend.capturePane = () => '';
tm.backend.hasClient = () => false;

const HOUR = 3600_000;
const row = (id) => aos.db.prepare('SELECT * FROM term_sessions WHERE id = ?').get(id);
const audits = (id, type) => aos.db.prepare('SELECT data FROM audit_events WHERE run_id = ? AND type = ?').all(id, type).map((r) => JSON.parse(r.data));
/** The row as the CONSOLE sees it — this is what actually drives the status icon. */
const seen = (id) => tm.listSessions().find((s) => s.id === id);

let n = 0;
const mk = (o = {}) => {
  const id = 'ses_life_' + (++n);
  const cols = {
    id, agent: 'agent-demo', title: 't', task: 'do a thing', tmux: 'aos-' + id, status: 'running',
    headless: 0, resident: 0, claude_session_id: 'cs-' + id, secret: 'sec', spawned_by: 'm_alice',
    run_as: 'm_alice', busy_since: Date.now(), last_activity: null, created_at: Date.now() - HOUR, updated_at: Date.now(), ...o,
  };
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,claude_session_id,secret,spawned_by,run_as,busy_since,last_activity,created_at,updated_at)
    VALUES (@id,@agent,@title,@task,@tmux,@status,@headless,@resident,@claude_session_id,@secret,@spawned_by,@run_as,@busy_since,@last_activity,@created_at,@updated_at)`).run(cols);
  livePanes.add(cols.tmux);
  return id;
};

console.log('\n\x1b[1m1) a member\'s INTERACTIVE session stops reading "working" at turn-end\x1b[0m');
console.log('   (the reported bug: this lane returned before the only clear, so it spun forever)');
{
  const id = mk();                                  // headless 0, resident 0 — a member's own TUI
  assert(seen(id).working === true, 'mid-turn → working');
  tm.markTurnIdle(id);                              // the Stop hook fires for this lane too
  assert(row(id).busy_since === null, 'Stop clears busy_since on an interactive run');
  assert(seen(id).working === false, 'console reads it as not working');
  assert(seen(id).alive === true && seen(id).status === 'running', 'the pane is untouched — still live, still running');
  assert(!killed.includes('aos-' + id), 'and nothing was torn down');
}

console.log('\n\x1b[1m2) UserPromptSubmit is the turn-START signal\x1b[0m');
{
  const id = mk({ busy_since: null });
  assert(seen(id).working === false, 'idle between turns → ready, not working');
  tm.recordLifecycle(id, 'UserPromptSubmit');       // a human typed into the attached TUI
  assert(row(id).busy_since != null, 'busy_since stamped');
  assert(seen(id).working === true, 'console reads it as working');
  const started = row(id).busy_since, act = row(id).last_activity;
  tm.recordLifecycle(id, 'UserPromptSubmit');       // a queued second prompt inside the same turn
  assert(row(id).busy_since === started, 'a second prompt keeps the ORIGINAL start (the staleness clock must measure the whole turn)');
  assert(row(id).last_activity === act, 'and does not move the turn-END clock past it (that would read as finished)');
  assert(seen(id).working === true, 'still working after the queued prompt');
}

console.log('\n\x1b[1m3) StopFailure ends the turn — the rate-limit zombie\x1b[0m');
console.log('   (claude fires NO Stop when the turn dies on an API error)');
{
  const id = mk();
  tm.recordLifecycle(id, 'StopFailure', { errorType: 'rate_limit' });
  assert(row(id).busy_since === null, 'busy_since cleared');
  assert(seen(id).working === false, 'no perpetual spinner');
  const a = audits(id, 'session.turn.failed');
  assert(a.length === 1 && a[0].errorType === 'rate_limit', 'audited WHY the turn ended', JSON.stringify(a));
}
{
  // …and an UNATTENDED run whose turn died is torn down, exactly as a clean turn-end would be, so the
  // automations pile-up guard releases instead of holding the slot until a 24h reaper notices.
  const id = mk({ headless: 1 });
  tm.recordLifecycle(id, 'StopFailure', { errorType: 'overloaded' });
  assert(killed.includes('aos-' + id), 'an unattended run is reaped, not left as a zombie');
}

console.log('\n\x1b[1m4) SessionEnd is terminal only for the reasons that really end a run\x1b[0m');
{
  const id = mk();
  tm.recordLifecycle(id, 'SessionEnd', { reason: 'clear' });    // /clear — mid-run, NOT the end
  assert(row(id).status === 'running', '`clear` does not end the session');
  assert(row(id).busy_since === null, 'but it does end the turn');
  assert(audits(id, 'session.runtime.end')[0].reason === 'clear', 'the reason is audited verbatim');
}
{
  const id = mk();
  tm.recordLifecycle(id, 'SessionEnd', { reason: 'compact' });
  assert(row(id).status === 'running', '`compact` does not end the session either');
}
{
  const id = mk();
  tm.recordLifecycle(id, 'SessionEnd', { reason: 'prompt_input_exit' });   // the human quit the TUI
  assert(row(id).status === 'done', '`prompt_input_exit` DOES end it');
  assert(row(id).busy_since === null, 'and clears the turn flag');
}
{
  const id = mk();
  tm.recordLifecycle(id, 'SessionEnd', { reason: 'other' });
  assert(row(id).status === 'running', '`other` is the catch-all and is NOT treated as terminal');
}

console.log('\n\x1b[1m5) `working` self-heals — no end signal can strand the spinner\x1b[0m');
{
  const id = mk({ busy_since: Date.now() - 3 * HOUR });          // a turn "running" for 3h
  assert(seen(id).working === false, 'a turn older than the 2h wedged-turn ceiling is not working');
}
{
  // The clause that heals rows latched by an OLDER build: every turn-end path stamps `last_activity`,
  // including the ones that used to return without clearing `busy_since`.
  const id = mk({ busy_since: Date.now() - 40 * 60_000, last_activity: Date.now() - 30 * 60_000 });
  assert(seen(id).working === false, 'a turn-END recorded after the start wins, even inside the 2h window');
}
{
  const id = mk({ status: 'stopped' });                          // latched flag on a terminal row
  assert(seen(id).working === false, 'a stopped row is never working, whatever the flag says');
}
{
  const id = mk({ status: 'crashed' });
  assert(seen(id).working === false, 'nor a crashed one');
}
{
  const id = mk({ status: 'done' });
  assert(seen(id).working === true, 'but `done` still counts — `report` flips the row mid-turn while the agent keeps working');
}
{
  const id = mk();
  livePanes.delete('aos-' + id);                                 // pane died mid-turn
  assert(seen(id).working === false, 'a dead pane is not working');
}

console.log('\n\x1b[1m6) every terminal transition drops the flag\x1b[0m');
{
  const id = mk();
  tm.stopSession(id, 'm_alice');
  assert(row(id).busy_since === null, 'stopSession clears it');
}
{
  const id = mk();
  tm.markEnded(id);
  assert(row(id).busy_since === null, 'markEnded clears it');
}

console.log('\n\x1b[1m7) an INTERRUPTED turn (Esc) stops reading "working"\x1b[0m');
console.log('   (Esc/Ctrl-C fires NO Stop, StopFailure or SessionEnd — there is no interrupt hook at all,');
console.log('    anthropics/claude-code#9516 — so the Notification bell is the only signal we get)');
{
  const id = mk();
  assert(seen(id).working === true, 'mid-turn → working');
  tm.notify(id, 'agent-demo', 'idle_prompt', 'Interrupted · What should Claude do instead?');
  assert(row(id).busy_since === null, 'the idle notification ends the turn — blocked on a human is not generating');
  assert(seen(id).working === false, 'no spinner');
  const card = aos.db.prepare("SELECT COUNT(*) c FROM messages WHERE session_id = ? AND type = 'notification' AND status = 'open'").get(id).c;
  assert(card === 1, 'and it reads `needs you` — an open waiting card, which outranks working');
}
{
  // …and typing the next prompt closes that loop: the card is stale the moment the human answers.
  const id = mk();
  tm.notify(id, 'agent-demo', 'idle_prompt', 'waiting');
  tm.recordLifecycle(id, 'UserPromptSubmit');
  const card = aos.db.prepare("SELECT COUNT(*) c FROM messages WHERE session_id = ? AND type = 'notification' AND status = 'open'").get(id).c;
  assert(card === 0, 'a submitted prompt retires the waiting card');
  assert(seen(id).working === true, 'back to working, not stuck on `needs you`');
}
{
  const id = mk();
  tm.notify(id, 'agent-demo', 'permission_prompt', 'Claude needs permission');
  assert(row(id).busy_since === null, 'a permission prompt ends the turn too');
}
{
  const id = mk();
  tm.notify(id, 'agent-demo', 'auth_success', 'logged in');   // a noise kind
  assert(row(id).busy_since != null, 'a NOISE notification kind changes nothing');
}

console.log('\n\x1b[1m8) an unknown event is ignored, not a crash\x1b[0m');
{
  const id = mk();
  const before = row(id).busy_since;
  tm.recordLifecycle(id, 'SomeFutureEvent', { reason: 'x' });
  assert(row(id).busy_since === before, 'a future claude event changes nothing');
  tm.recordLifecycle('ses_does_not_exist', 'UserPromptSubmit');
  assert(true, 'an unknown session is a no-op');
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail ? 1 : 0);
