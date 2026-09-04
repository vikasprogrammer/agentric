#!/usr/bin/env node
/**
 * Crown-jewel READ protection lives in the gate hook, not in `permissions.deny`.
 *
 * Until v0.415.0 claude-launch.sh wrote `Read(//$HOME/.ssh/**)`-style `permissions.deny` rules. That
 * had to change: on claude-code 2.1.259 the mere EXISTENCE of a `Read()` deny rule makes Claude
 * escalate every Bash command shaped `cd <dir> && <command with a relative path>` to a HUMAN-ONLY
 * approval it can't be talked out of — verified live on 2026-09-03, where the gate hook had already
 * returned `permissionDecision:"allow"` for the exact command and Claude escalated anyway (deny rules
 * outrank a hook allow). That shape is most of what an agent types, so the interactive lane parked on a
 * Yes/No for an ordinary grep.
 *
 * Two things must therefore stay true, and both are easy to undo by accident:
 *   1. claude-launch.sh writes NO `Read(...)` deny rule, exports AOS_PROTECTED_PATHS, and registers the
 *      read tools on the PreToolUse matcher.
 *   2. gate-hook.sh denies a read of / into a protected path and stays silent on everything else.
 * (1) is a text check; (2) drives the REAL hook with real PreToolUse events.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'terminal', 'gate-hook.sh');
const LAUNCH = path.join(ROOT, 'terminal', 'claude-launch.sh');

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) return console.log(`  ok   ${name}`);
  failed++;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
};

// ---------------------------------------------------------------- launcher text
const launch = fs.readFileSync(LAUNCH, 'utf8');

check(
  'claude-launch.sh writes no Read() deny rule',
  !/"Read\(/.test(launch),
  'a `Read(...)` entry in permissions.deny re-arms the cd-with-relative-path escalation for every agent',
);
check("claude-launch.sh still denies AskUserQuestion", /deny[^\n]*AskUserQuestion/.test(launch));
check('claude-launch.sh exports AOS_PROTECTED_PATHS', /export AOS_PROTECTED_PATHS=/.test(launch));
for (const jewel of ['.ssh', '.aws', '.gnupg', '.claude', 'connectors', 'control', 'tenants', 'agent-os.db']) {
  check(`AOS_PROTECTED_PATHS covers ${jewel}`, new RegExp(`/${jewel.replace('.', '\\.')}(\\b|$)`, 'm').test(launch));
}
// The WAL/SHM sidecars are separate files: a rule naming only `agent-os.db` leaves the live DB
// readable through `agent-os.db-wal`.
for (const side of ['agent-os.db-wal', 'agent-os.db-shm']) {
  check(`AOS_PROTECTED_PATHS covers ${side}`, launch.includes(side));
}
const matcher = launch.match(/"matcher":\s*"([^"]*Bash[^"]*)"/);
check(
  'read tools are on the PreToolUse matcher',
  !!matcher && ['Read', 'Glob', 'Grep', 'NotebookRead'].every((t) => new RegExp(`\\b${t}\\b`).test(matcher[1])),
  matcher ? `matcher: ${matcher[1]}` : 'no Bash matcher found',
);

// ---------------------------------------------------------------- the hook itself
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-protected-'));
const dataHome = path.join(home, 'data');
const agentDir = path.join(dataHome, 'agents', 'engineer');
fs.mkdirSync(agentDir, { recursive: true });
const PROTECTED = [
  path.join(home, '.ssh'),
  path.join(home, '.aws'),
  path.join(home, '.claude'),
  path.join(dataHome, 'connectors'),
  path.join(dataHome, 'agent-os.db'),
  path.join(dataHome, 'agent-os.db-wal'),
].join('\n');

/** Run the real hook on one PreToolUse event; returns its parsed decision (or null when silent). */
function gate(tool, input, cwd = agentDir) {
  const out = execFileSync('bash', [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: input }),
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      AOS_PROTECTED_PATHS: PROTECTED,
      AOS_RUNTIME: 'claude-code',
      // Deliberately unreachable: a protected-path denial must never need the gateway. If the hook
      // starts calling out for reads, these cases hang instead of passing, which is the signal we want.
      AOS_URL: 'http://127.0.0.1:1',
      SESSION: 'ses_test',
      AGENT: 'engineer',
    },
  }).trim();
  if (!out) return null;
  return JSON.parse(out).hookSpecificOutput;
}
const denied = (r) => !!r && r.permissionDecision === 'deny';

const cases = [
  ['Read of an ssh key is denied', 'Read', { file_path: path.join(home, '.ssh/id_rsa') }, true],
  ['Read of the tenant DB is denied', 'Read', { file_path: path.join(dataHome, 'agent-os.db') }, true],
  ['Read of the DB WAL sidecar is denied', 'Read', { file_path: path.join(dataHome, 'agent-os.db-wal') }, true],
  ['Read of a connector bag is denied', 'Read', { file_path: path.join(dataHome, 'connectors/x.json') }, true],
  // Resolved against cwd — an agent sitting in the data home must not reach the bag by relative path.
  ['relative Read into a protected dir is denied', 'Read', { file_path: 'connectors/x.json' }, true, dataHome],
  // Both directions: a recursive search whose ROOT contains a protected path would walk into it.
  ['Grep rooted above a protected dir is denied', 'Grep', { path: dataHome, pattern: 'token' }, true],
  ['Glob reaching into .ssh is denied', 'Glob', { path: home, pattern: '.ssh/*' }, true],
  ['NotebookRead of a protected path is denied', 'NotebookRead', { notebook_path: path.join(home, '.claude/x.ipynb') }, true],

  ['the agent reading its OWN file is allowed', 'Read', { file_path: path.join(agentDir, 'CLAUDE.md') }, false],
  ['Grep inside the agent folder is allowed', 'Grep', { path: agentDir, pattern: 'x' }, false],
  ['Glob inside the agent folder is allowed', 'Glob', { path: agentDir, pattern: '**/*.md' }, false],
  ['Grep with no path is allowed from the agent folder', 'Grep', { pattern: 'x' }, false],
  // Prefix matching must be path-segment aware, or a sibling directory is denied by coincidence.
  ['a .claude-backup sibling is NOT denied', 'Read', { file_path: path.join(home, '.claude-backup/x') }, false],
  ['a Grep pattern that looks like a path is not treated as one', 'Grep', { path: agentDir, pattern: '.ssh/id_rsa' }, false],
];

console.log('protected-path guard');
for (const [name, tool, input, wantDeny, cwd] of cases) {
  const res = gate(tool, input, cwd);
  check(name, denied(res) === wantDeny, `got ${res ? JSON.stringify(res.permissionDecision) : 'silence (allow)'}`);
}

// A denial has to tell the MODEL why, or it retries the same read until the turn dies.
const reason = gate('Read', { file_path: path.join(home, '.ssh/id_rsa') })?.permissionDecisionReason || '';
check('the denial carries a model-visible reason', /protected path/i.test(reason), `reason: ${reason || '(none)'}`);

// Bash must still reach the gateway — this change must not turn a shell command into a local decision.
check(
  'Bash is still routed to the gateway, not decided locally',
  /Bash\|shell\|local_shell[^\n]*CAP="shell\.exec"/.test(fs.readFileSync(HOOK, 'utf8')),
);

fs.rmSync(home, { recursive: true, force: true });

if (failed) {
  console.error(`\nprotected-path-guard-test: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nprotected-path-guard-test: all checks passed');
