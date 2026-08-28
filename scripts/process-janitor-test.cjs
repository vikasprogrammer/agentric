#!/usr/bin/env node
/**
 * PROCESS JANITOR — pins the reap predicates.
 *
 * The janitor kills processes, so every guard here is a safety guard: it must reap the orphan class that
 * took the Mac Mini to load 29 on 12 cores (2026-08-20 — 24 spinner subshells reparented to init when a
 * `go test` tool call died before its trailing `jobs -p | xargs kill`), and must NOT touch a live tenant's
 * ttyd/tmux, another user's processes, or a Bash tool call still in flight.
 *
 * Run: node scripts/process-janitor-test.cjs   (needs `npm run build` first)
 */
const assert = require('assert');
const { ProcessJanitor, parseProcessTable, parseEtime } = require('../dist/edge/process-janitor');

const UID = 501;
const SELF = 999;
const OLD = '01-14:12:34';   // ~38h — past the 10-min grace
const YOUNG = '00:30';       // 30s — inside the grace

/** The real argv the incident's spinners carried, trimmed to shape. */
const SNAP = '/Users/x/agent-os-data/instapods/claude-config/shell-snapshots/snapshot-zsh-1787194236778-0vmsej.sh';
const spinner = `/bin/zsh -c source ${SNAP} 2>/dev/null || true && eval 'cd /tmp/p && (for i in $(seq 1 24); do (while :; do :; done) & done; go test ./... -race)'`;

const row = (pid, ppid, args, etime = OLD, uid = UID) => `${pid} ${ppid} ${uid} ${etime} ${args}`;
const table = (...rows) => rows.join('\n') + '\n';

// ---------------------------------------------------------------- parseEtime
assert.strictEqual(parseEtime('00:30'), 30_000, 'MM:SS');
assert.strictEqual(parseEtime('01:02:03'), 3_723_000, 'HH:MM:SS');
assert.strictEqual(parseEtime('01-14:12:34'), 137_554_000, 'D-HH:MM:SS');
assert.strictEqual(parseEtime('garbage'), 0, 'unparseable etime is treated as too young, never as old');

// ---------------------------------------------------- parseProcessTable shape
{
  const got = parseProcessTable(table(
    row(100, 1, spinner),                                              // the orphan we must catch
    row(101, 555, spinner),                                            // SAME argv, live parent = tool call in flight
    row(102, 1, spinner, OLD, 502),                                    // another user's — never ours to signal
    row(SELF, 1, spinner),                                             // ourselves
    row(103, 1, '/usr/local/bin/node /srv/app/server.js'),             // a daemonised server: exec'd, no snapshot argv
    row(104, 1, '/bin/zsh -c source /x/shell-snapshots/snap.sh && :'), // snapshot-shaped but not `snapshot-` prefixed
    row(200, 1, '/usr/local/bin/ttyd -p 3011 /opt/aos/terminal/attach.sh /tmp/aos/tmux.sock'),
    row(201, 1, 'tmux -S /tmp/aos/tmux.sock attach -t aos-1'),
    row(202, 1, '/usr/bin/ttyd -W -i lo -p 7681 -O login'),            // Ubuntu's apt ttyd — not ours
  ), UID, SELF);

  const byPid = Object.fromEntries(got.map((c) => [c.pid, c.kind]));
  assert.deepStrictEqual(byPid, { 100: 'shell', 200: 'ttyd', 201: 'tmux' },
    `only the orphaned agent shell + our own ttyd/tmux are candidates, got ${JSON.stringify(byPid)}`);
  assert.strictEqual(got.find((c) => c.pid === 100).socket, '', 'a shell candidate holds no socket');
  assert.strictEqual(got.find((c) => c.pid === 200).socket, '/tmp/aos/tmux.sock', 'ttyd socket parsed');
}

// ------------------------------------------------------------- sweep policy
/** A janitor driven off a fixed process table, recording signals instead of sending them. */
function harness(rows, liveSockets = []) {
  const sent = [];
  const j = new ProcessJanitor(() => new Set(liveSockets));
  j.scan = () => parseProcessTable(table(...rows), UID, SELF);
  const realKill = process.kill;
  const run = () => {
    process.kill = (pid, sig) => { sent.push(`${pid}:${sig}`); };
    try { return j.sweep(); } finally { process.kill = realKill; }
  };
  return { run, sent };
}

// An orphaned shell needs TWO sweeps (strike memory), then escalates if it survives.
{
  const h = harness([row(100, 1, spinner)]);
  let r = h.run();
  assert.deepStrictEqual([r.shell, r.pending], [0, 1], 'first sighting is a strike, never a kill');
  assert.deepStrictEqual(h.sent, [], 'no signal on the first sweep');

  r = h.run();
  assert.strictEqual(r.shell, 1, 'second sighting reaps');
  assert.deepStrictEqual(h.sent, ['100:SIGTERM'], 'reaped politely first');

  r = h.run();
  assert.deepStrictEqual(h.sent, ['100:SIGTERM', '100:SIGKILL'], 'a survivor escalates to SIGKILL');
  assert.strictEqual(r.shell, 0, 'an escalation is the same leak — counted once, on the first signal');
}

// The age grace protects a just-orphaned shell (and any pid reused inside a sweep interval).
{
  const h = harness([row(100, 1, spinner, YOUNG)]);
  h.run();
  const r = h.run();
  assert.deepStrictEqual([r.shell, r.pending], [0, 1], 'inside the 10-min grace it is never killed');
  assert.deepStrictEqual(h.sent, [], 'no signal to a young orphan, however many sweeps');
}

// A tool call whose parent is alive is untouchable no matter how long it runs.
{
  const h = harness([row(101, 555, spinner)]);
  h.run();
  const r = h.run();
  assert.deepStrictEqual([r.shell, r.pending], [0, 0], 'a live-parent Bash tool call is not a candidate');
  assert.deepStrictEqual(h.sent, [], 'a 38h build is still just a slow tool call');
}

// Regression: a live tenant's ttyd/tmux survives even though its pid is orphaned and old.
{
  const rows = [
    row(200, 1, '/usr/local/bin/ttyd -p 3011 /opt/aos/terminal/attach.sh /tmp/live/tmux.sock'),
    row(201, 1, 'tmux -S /tmp/live/tmux.sock attach -t aos-1'),
  ];
  const h = harness(rows, ['/tmp/live/tmux.sock']);
  h.run();
  const r = h.run();
  assert.deepStrictEqual([r.ttyd, r.tmux], [0, 0], 'a socket a live runtime declares is never reaped');
  assert.deepStrictEqual(h.sent, [], 'no signal to a live tenant terminal');
}

// A failed `ps` reaps nothing — killing on a guess is the one unsafe move.
{
  const j = new ProcessJanitor(() => new Set());
  j.scan = () => { throw new Error('ps failed'); };
  const realKill = process.kill;
  process.kill = () => { throw new Error('must not signal anything'); };
  try {
    assert.deepStrictEqual(j.sweep(), { ttyd: 0, tmux: 0, shell: 0, pending: 0 }, 'a failed ps is a no-op sweep');
  } finally { process.kill = realKill; }
}

console.log('✓ process janitor: orphaned agent shells reaped; live tenants, other uids and in-flight tool calls untouched');
