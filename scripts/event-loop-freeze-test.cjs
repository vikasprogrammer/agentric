#!/usr/bin/env node
/* Event-loop freeze regressions — two synchronous paths that each took a live tenant's server down whole
 * (globex 2026-09-22: /health dead, listen backlog full, no DB write for two hours).
 *
 *   1. A tmux client that never exits. `LocalSessionBackend` calls tmux with `spawnSync`, which holds the
 *      single-threaded process until the child is gone; one hung `send-keys -l` held it for 1h55m. Every
 *      tmux call is now bounded — pinned here with a fake `tmux` that sleeps forever.
 *   2. `planConsolidation` normalised content inside its inner loop (n²/2 regex passes), and one agent's
 *      5.2k vector-less memories pinned the process at 100% CPU for ~5 minutes. Pinned by equivalence
 *      against the original algorithm on random data, plus a wall-clock bound at that live size.
 * No tmux, claude or DB needed. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const { LocalSessionBackend } = require(path.join(ROOT, 'dist/edge/session-backend'));
const { planConsolidation, cosine } = require(path.join(ROOT, 'dist/memory/embedding'));

let pass = 0;
const ok = (name) => { pass++; console.log(`  ✓ ${name}`); };

// ── 1. a hung tmux client is bounded ────────────────────────────────────────────────────────────────
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-freeze-test-'));
fs.writeFileSync(path.join(BIN, 'tmux'), '#!/bin/sh\nexec sleep 600\n', { mode: 0o755 });
const savedPath = process.env.PATH;
process.env.PATH = `${BIN}:${savedPath}`;
try {
  const be = new LocalSessionBackend(path.join(BIN, 'sock'), () => {});
  let t = Date.now();
  const delivered = be.injectText('', 'aos-x', 'hello', false);
  const took = Date.now() - t;
  assert.strictEqual(delivered, false, 'a timed-out send-keys must report not-delivered');
  assert.ok(took < 8_000, `send-keys must be bounded, took ${took}ms`);
  ok(`hung send-keys returns not-delivered in ${took}ms`);

  t = Date.now();
  assert.strictEqual(be.aliveNames(), null, 'a timed-out liveness poll is UNKNOWN, never "no sessions"');
  assert.strictEqual(be.hasClient('', 'aos-x'), null, 'a timed-out client poll is unknown');
  assert.strictEqual(be.capturePane('', 'aos-x'), null, 'a timed-out capture is null');
  assert.ok(Date.now() - t < 20_000);
  ok('hung liveness/client/capture polls read as unknown, not as dead');
} finally {
  process.env.PATH = savedPath;
  fs.rmSync(BIN, { recursive: true, force: true });
}

// ── 2. planConsolidation: same answer, no longer quadratic in regex work ────────────────────────────
// The pre-fix algorithm, verbatim, as the oracle.
function reference(rows, dedupeThreshold) {
  const norm = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const sorted = [...rows].sort((a, b) =>
    (b.importance ?? 0.5) - (a.importance ?? 0.5) || b.recallCount - a.recallCount || b.ts - a.ts);
  const taken = new Set();
  const ops = [];
  for (let i = 0; i < sorted.length; i++) {
    const anchor = sorted[i];
    if (taken.has(anchor.id)) continue;
    const aContent = norm(anchor.content);
    const dups = [];
    for (let j = i + 1; j < sorted.length; j++) {
      const cand = sorted[j];
      if (taken.has(cand.id)) continue;
      const exact = norm(cand.content) === aContent;
      const near = dedupeThreshold != null && !!anchor.vec && !!cand.vec && cosine(anchor.vec, cand.vec) >= dedupeThreshold;
      if (exact || near) { dups.push(cand); taken.add(cand.id); }
    }
    if (dups.length) {
      taken.add(anchor.id);
      ops.push({
        keepId: anchor.id, dropIds: dups.map((d) => d.id),
        importance: Math.max(anchor.importance ?? 0.5, ...dups.map((d) => d.importance ?? 0.5)),
        recallCount: anchor.recallCount + dups.reduce((s, d) => s + d.recallCount, 0),
      });
    }
  }
  return ops;
}

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const vecNear = (base) => Float32Array.from(base, (x) => x + (rnd() - 0.5) * 0.05);
function randomRows(n, vecShare) {
  const bases = Array.from({ length: 6 }, () => Float32Array.from({ length: 8 }, () => rnd() - 0.5));
  const texts = ['Deploy failed on box', 'User asked for refund', '  deploy FAILED   on box ', 'Site name taken', 'unique'];
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    content: rnd() < 0.5 ? texts[Math.floor(rnd() * texts.length)] : `note ${Math.floor(rnd() * n)}`,
    importance: rnd() < 0.3 ? undefined : Math.round(rnd() * 10) / 10,
    recallCount: Math.floor(rnd() * 4),
    ts: Math.floor(rnd() * 1000),
    vec: rnd() < vecShare ? vecNear(bases[Math.floor(rnd() * bases.length)]) : undefined,
  }));
}
for (const [n, share, thr] of [[60, 0, 0.95], [60, 0.5, 0.95], [80, 1, 0.9], [80, 0.7, undefined], [5, 1, 0.99], [0, 0, 0.9]]) {
  for (let k = 0; k < 20; k++) {
    const rows = randomRows(n, share);
    assert.deepStrictEqual(planConsolidation(rows, thr), reference(rows, thr), `n=${n} share=${share} thr=${thr}`);
  }
}
ok('identical merge plans to the original algorithm across 120 random groups (exact, near, mixed, no threshold)');

// Live shape: 5.2k memories, ~1.1KB each, no vectors. Pre-fix this was minutes of solid CPU.
const body = 'x '.repeat(550);
const big = Array.from({ length: 5200 }, (_, i) => ({ id: `b${i}`, content: `${i % 700} ${body}`, recallCount: 0, ts: i }));
const t0 = Date.now();
const ops = planConsolidation(big, 0.95);
const took = Date.now() - t0;
assert.strictEqual(ops.length, 700);
assert.ok(took < 2_000, `5.2k vector-less rows must plan fast, took ${took}ms`);
ok(`5.2k × 1.1KB vector-less rows planned in ${took}ms`);

console.log(`\nevent-loop-freeze-test: ${pass} passed`);
