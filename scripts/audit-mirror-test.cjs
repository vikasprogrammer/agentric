#!/usr/bin/env node
/**
 * Falsifier for the audit MIRROR bounds (see CHANGELOG 0.363.0).
 *
 * The mirror (`audit_events` in SQLite) had no size or age bound, so it grew with a tenant's whole lifetime:
 * instawp reached 337k rows / 195 MB of a 336 MB DB in 45 days (~3 MB/day), with single `gate.attempt` rows
 * up to 120 KB. Both bounds are only SAFE because `JsonlAuditSink` keeps every event forever, per run — the
 * table is a queryable copy, not the record.
 *
 * What this pins:
 *   1. Clipping preserves KEYS and STRUCTURE. Every reader indexes into `data` by name; a size guard that
 *      dropped or reshaped fields would silently break the Audit page, Insights, agent-stats and the digest.
 *   2. Clipping actually clips — and leaves short values byte-identical.
 *   3. The JSONL sink is NOT clipped. If this ever inverts, retention starts destroying evidence.
 *   4. Retention deletes only rows older than the window, and `0` keeps everything.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-audit-test-'));
const { clipForMirror, CLIP_MARK, pruneAuditMirror, SqliteAuditSink, JsonlAuditSink } = require('../dist/governance/audit');
const { openDb } = require('../dist/state/db');

// ── 1 + 2: clipping shape and behaviour ────────────────────────────────────────────────────────────────
const long = 'x'.repeat(9_000);
const event = {
  capability: 'shell.exec',
  args: { command: long, cwd: '/srv/app', amountUsd: 12.5, destructive: false, hosts: ['a.example.com', long] },
  decision: { effect: 'approve', level: 'head', reason: 'writes outside the workdir' },
  nested: { deep: { deeper: { note: long } } },
  nothing: null,
};
const clipped = clipForMirror(event, 2_000);

assert.deepStrictEqual(Object.keys(clipped), Object.keys(event), 'top-level keys must survive clipping');
assert.deepStrictEqual(Object.keys(clipped.args), Object.keys(event.args), 'nested keys must survive clipping');
assert.deepStrictEqual(clipped.decision, event.decision, 'a small object must pass through byte-identical');
assert.strictEqual(clipped.args.cwd, '/srv/app', 'short strings are untouched');
assert.strictEqual(clipped.args.amountUsd, 12.5, 'numbers keep their type (not stringified)');
assert.strictEqual(clipped.args.destructive, false, 'booleans keep their type');
assert.strictEqual(clipped.nothing, null, 'null survives as null');
assert.ok(Array.isArray(clipped.args.hosts), 'arrays stay arrays');
assert.strictEqual(clipped.args.hosts[0], 'a.example.com', 'short array members untouched');
assert.ok(clipped.args.command.endsWith(CLIP_MARK), 'a clipped leaf is marked as clipped');
assert.ok(clipped.args.command.length < 2_200, `clipped leaf should be ~2KB, got ${clipped.args.command.length}`);
assert.ok(clipped.nested.deep.deeper.note.endsWith(CLIP_MARK), 'clipping reaches arbitrary depth');
assert.ok(JSON.parse(JSON.stringify(clipped)), 'the clipped payload is still valid JSON');

// The mirror row is bounded in practice, not just in theory.
const db = openDb(path.join(tmp, 'test.db'));
const sink = new SqliteAuditSink(db);
const base = { ts: Date.now(), runId: 'ses_test', tenant: 't', principal: 'p' };
sink.append({ ...base, type: 'gate.attempt', data: event });
const stored = db.prepare('SELECT length(data) AS n, data FROM audit_events').get();
assert.ok(stored.n < 8_000, `mirror row should be bounded, got ${stored.n} bytes`);
assert.strictEqual(JSON.parse(stored.data).args.cwd, '/srv/app', 'a stored row is still readable by key');

// ── 3: the JSONL system-of-record keeps the FULL value ─────────────────────────────────────────────────
const jsonlDir = path.join(tmp, 'audit');
new JsonlAuditSink(jsonlDir).append({ ...base, type: 'gate.attempt', data: event });
const line = fs.readFileSync(path.join(jsonlDir, 't', 'ses_test.jsonl'), 'utf8');
assert.strictEqual(JSON.parse(line).data.args.command.length, 9_000, 'JSONL must keep the value WHOLE — retention depends on it');
assert.ok(!line.includes(CLIP_MARK), 'the durable sink must never clip');

// ── 4: retention deletes by age only ───────────────────────────────────────────────────────────────────
const now = Date.now();
const day = 86_400_000;
db.prepare('DELETE FROM audit_events').run();
const ins = db.prepare('INSERT INTO audit_events (ts, run_id, tenant, type, principal, data) VALUES (?, ?, ?, ?, ?, ?)');
for (const ageDays of [1, 10, 89, 91, 200]) ins.run(now - ageDays * day, 'ses_x', 't', 'gate.attempt', 'p', '{}');
const count = () => db.prepare('SELECT count(*) AS n FROM audit_events').get().n;
assert.strictEqual(count(), 5);
assert.strictEqual(pruneAuditMirror(db, 0, now), 0, '0 days must mean keep everything');
assert.strictEqual(count(), 5, 'a disabled window deletes nothing');
assert.strictEqual(pruneAuditMirror(db, 90, now), 2, 'exactly the two rows past 90 days');
assert.strictEqual(count(), 3);
const ages = db.prepare('SELECT ts FROM audit_events ORDER BY ts').all().map((r) => Math.round((now - r.ts) / day));
assert.deepStrictEqual(ages, [89, 10, 1].sort((a, b) => b - a), 'survivors are exactly the in-window rows');
// Batching must not change WHICH rows go, only how many per call.
for (const ageDays of [150, 160, 170]) ins.run(now - ageDays * day, 'ses_x', 't', 'gate.attempt', 'p', '{}');
assert.strictEqual(pruneAuditMirror(db, 90, now, 2), 2, 'the batch limit caps rows per call');
assert.strictEqual(pruneAuditMirror(db, 90, now, 2), 1, 'the backlog drains on the next pass');
assert.strictEqual(count(), 3, 'and only the in-window rows remain');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('audit-mirror-test: ok (structure preserved, mirror bounded, JSONL unclipped, retention by age + batched)');
