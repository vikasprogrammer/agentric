#!/usr/bin/env node
/* Does a RESUMED launch re-seed the prompt? (terminal/claude-launch.sh, both lanes)
 *
 * `--resume` serves two callers with opposite needs, and $TASK means something different to each:
 *   - a BROWSER REATTACH (attach.sh re-launches us off the persisted env, RESUMED_FROM_ENV=1) — $TASK is
 *     the ORIGINAL prompt, already in the transcript. Re-seeding it re-runs the whole run.
 *   - a SERVER-DRIVEN relaunch (task re-dispatch, chat follow-up, revive) — $TASK is a genuinely NEW
 *     prompt. Dropping it opens the TUI on the old transcript with an EMPTY COMPOSER: no turn starts, so
 *     no UserPromptSubmit and no Stop ever fire, the row keeps the `busy_since` stamped at launch, and the
 *     console reads "working" on a session that will never do anything.
 *
 * instapods 2026-08-17: fleet-janitor's task tsk_5aa0fd20887a2d79 was re-dispatched with mode:interactive.
 * The unattended lane had already learned this split; the INTERACTIVE lane had not — it dropped $TASK
 * unconditionally. The pane sat at `❯ ` in front of a healthy claude, the row read `working`, and the
 * task's "you are RESUMING … continue and finish it" prompt was never delivered.
 *
 * This runs the REAL dispatch blocks, lifted out of the live script by their anchor lines (so the test
 * cannot drift from the source it pins), under bash with `claude` stubbed to record its argv.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'terminal/claude-launch.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-resume-seed-test-'));

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`));

const ANCHOR = 'if [ "${RESUME:-}" = "1" ] && [ -n "${CLAUDE_SESSION_ID:-}" ]; then';
const lines = fs.readFileSync(SCRIPT, 'utf8').split('\n');

/** Lift the Nth `--resume` dispatch block out of the live script: the anchor `if`, everything up to the
 *  `elif` that ends it, and a closing `fi`. Comments come along — they are the block. */
function liftBlock(nth) {
  let seen = 0, start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === ANCHOR && ++seen === nth) { start = i; break; }
  }
  if (start < 0) throw new Error(`anchor #${nth} not found in claude-launch.sh — did the dispatch blocks move?`);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('elif ')) { end = i; break; }
  }
  if (end < 0) throw new Error(`no elif closing anchor #${nth}`);
  return lines.slice(start, end).join('\n') + '\nfi\n';
}

const UNATTENDED = liftBlock(1);   // the RESIDENT/UNATTENDED lane (uses RES_ARGS)
const INTERACTIVE = liftBlock(2);  // the attachable interactive lane (uses COMMON_ARGS)

/** Run one lifted block with `claude` stubbed. Returns the argv of each `claude` invocation. */
function run(block, env, { claudeFails = false } = {}) {
  const log = path.join(TMP, 'argv.log');
  fs.writeFileSync(log, '');
  // One argument per line, NUL-free — so an argv containing spaces/newlines stays one entry.
  const harness = [
    'set -u',
    'dim() { :; }',
    'notify_resumed() { :; }',
    `claude() { printf '%s\\n' "$#" >> "$ARGV_LOG"; for a in "$@"; do printf '%s\\n' "$a" >> "$ARGV_LOG"; done; return ${claudeFails ? 1 : 0}; }`,
    'COMMON_ARGS=(--settings .claude/aos-settings.json)',
    'RES_ARGS=(--dangerously-skip-permissions --settings .claude/aos-settings.json)',
    block,
    'true',   // the fallback case ends on a failing claude; we assert on the argv, not the exit status
  ].join('\n');
  execFileSync('bash', ['-c', harness], { env: { ...process.env, ...env, ARGV_LOG: log }, stdio: ['ignore', 'ignore', 'inherit'] });
  // Rebuild the calls from the flat log: a count line, then that many argv lines.
  const raw = fs.readFileSync(log, 'utf8').split('\n');
  const calls = [];
  for (let i = 0; i < raw.length && raw[i] !== ''; ) {
    const n = Number(raw[i++]);
    calls.push(raw.slice(i, i + n));
    i += n;
  }
  return calls;
}

const TASK = 'You are RESUMING your own earlier session on task tsk_5aa0fd20887a2d79. Continue and finish it.';
const SID = 'a56a1484-4831-4e26-83f0-baba6b1d947c';
const SERVER = { RESUME: '1', CLAUDE_SESSION_ID: SID, TASK, RESUMED_FROM_ENV: '' };
const REATTACH = { ...SERVER, RESUMED_FROM_ENV: '1' };
const seeded = (argv) => argv.includes(TASK);
const resumed = (argv) => argv[0] === '--resume' && argv[1] === SID;

for (const [lane, block] of [['INTERACTIVE', INTERACTIVE], ['UNATTENDED', UNATTENDED]]) {
  console.log(`\n\x1b[1m${lane} lane — a server-driven resume carries the new prompt\x1b[0m`);
  {
    const calls = run(block, SERVER);
    assert(calls.length === 1, 'one claude call (the resume succeeded, no fallback)', calls);
    assert(resumed(calls[0]), 'it resumes the SAME transcript', calls[0]);
    assert(seeded(calls[0]), 'and the NEW prompt rides along — this is the bug', calls[0]);
  }
  console.log(`\n\x1b[1m${lane} lane — a BROWSER REATTACH must NOT re-seed\x1b[0m`);
  {
    const calls = run(block, REATTACH);
    assert(calls.length === 1 && resumed(calls[0]), 'it resumes the transcript', calls);
    assert(!seeded(calls[0]), 'and does NOT re-run the original prompt (the human just wants the TUI back)', calls[0]);
  }
  console.log(`\n\x1b[1m${lane} lane — a LOST transcript falls back to a fresh session, seeded either way\x1b[0m`);
  console.log('   (no transcript means no prompt in it, so both callers need $TASK on the escape hatch)');
  for (const [who, env] of [['server-driven', SERVER], ['browser reattach', REATTACH]]) {
    const calls = run(block, env, { claudeFails: true });
    assert(calls.length === 2, `${who}: the fallback ran`, calls);
    assert(calls[1][0] === '--session-id' && calls[1][1] === SID, `${who}: under the same session id`, calls[1]);
    assert(seeded(calls[1]), `${who}: seeded — an empty composer would be a dead run`, calls[1]);
  }
  console.log(`\n\x1b[1m${lane} lane — an EMPTY $TASK is passed as nothing, not as ""\x1b[0m`);
  console.log('   (bash 3.2 + set -u: a bare "$TASK" would hand claude an empty positional prompt)');
  {
    const calls = run(block, { ...SERVER, TASK: '' });
    assert(calls[0].every((a) => a !== ''), 'no empty argv entry', calls[0]);
  }
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail ? 1 : 0);
