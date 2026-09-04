#!/usr/bin/env node
/* Memory upkeep + learning-state round-trip test.
 *
 * Two defects found by reading the live instapods + instawp stores on 2026-08-27, each pinned here:
 *
 *  A. Upkeep on an EXTERNAL backend pruned only the local mirror. `MirroredMemoryProvider.maintain`
 *     assumed "the backend self-maintains (automem)" — it does not remove exact duplicates (one live
 *     tenant carried the SAME episode 177 times, 7% of its whole store, and it ranked in recall probes)
 *     — and it returned the BACKEND's counts, so the API reported `pruned: 0` while rows really did
 *     vanish from the mirror. Enabling upkeep therefore made the two stores diverge: agents kept
 *     recalling exactly what the console had been told was pruned.
 *
 *  B. `normalizeState` dropped `topicsVersion`, so dreaming's extractor-version check was true on every
 *     load and the CUMULATIVE topic map was wiped at the start of every pass (instapods reset on 29 of
 *     46 passes, instawp on 31 of 41; 666 and 1760 topic counts discarded). With MIN_TOPIC_COUNT = 3 the
 *     smaller tenant never once emitted its "the fleet frequently works on …" guidance line.
 *
 * Pure over an isolated home + a fake backend; no network, no tmux, no claude. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-upkeep-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { SqliteMemoryProvider } = require(path.join(ROOT, 'dist/memory/sqlite-provider.js'));
const { MirroredMemoryProvider } = require(path.join(ROOT, 'dist/memory/mirror.js'));
const { normalizeState } = require(path.join(ROOT, 'dist/edge/dreaming.js'));

const aos = loadAgentOS();

/** Stands in for automem: stores what it is given, has NO maintain() of its own, and records deletes. */
class FakeBackend {
  constructor() { this.rows = new Map(); this.deletes = []; this.failOn = new Set(); }
  async store(input) {
    const rec = { id: `bk_${this.rows.size + 1}`, tenant: input.tenant, agentId: input.agentId, content: input.content, tags: input.tags ?? [], type: input.type, importance: input.importance, ts: Date.now(), scope: input.scope ?? 'agent' };
    this.rows.set(rec.id, rec);
    return rec;
  }
  async recall() { return []; }
  async update() { return null; }
  async delete(input) {
    this.deletes.push(input);
    if (this.failOn.has(input.id)) return false;
    return this.rows.delete(input.id);
  }
  async health() { return { ok: true, backend: 'fake' }; }
}

const mirrorTable = () => aos.db.prepare('SELECT id, content FROM memories ORDER BY created_at').all();
const setAge = (id, days) => aos.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(Date.now() - days * 86_400_000, id);

(async () => {
  console.log('\nmemory upkeep — the mirror and the backend prune together\n');

  const backend = new FakeBackend();
  const mirror = new SqliteMemoryProvider(aos.db, aos.tenant);
  const provider = new MirroredMemoryProvider(backend, mirror);

  // three stale, never-recalled, low-importance memories + one that must survive on each ground
  const stale = [];
  for (let i = 0; i < 3; i++) {
    stale.push(await provider.store({ tenant: aos.tenant, agentId: 'engineer', content: `disposable note ${i}`, tags: [], type: 'Insight', importance: 0.3 }));
  }
  const important = await provider.store({ tenant: aos.tenant, agentId: 'engineer', content: 'load-bearing runbook', tags: [], type: 'Pattern', importance: 0.9 });
  const fresh = await provider.store({ tenant: aos.tenant, agentId: 'engineer', content: 'stored today', tags: [], type: 'Insight', importance: 0.3 });
  for (const r of [...stale, important]) setAge(r.id, 90);

  assert(mirrorTable().length === 5 && backend.rows.size === 5, 'a write lands in BOTH the backend and the mirror');

  const res = await provider.maintain({ pruneAfterDays: 30, keepImportance: 0.5 });
  const left = mirrorTable().map((r) => r.id);

  assert(res.pruned === 3, 'the result reports what the MIRROR pruned, not the backend\'s zero', `got ${res.pruned}`);
  assert(left.length === 2, 'the three stale, never-recalled, unimportant rows leave the mirror');
  assert(left.includes(important.id), 'an important memory survives the age cutoff');
  assert(left.includes(fresh.id), 'a recent memory survives');
  assert(backend.rows.size === 2, 'the BACKEND lost the same three — the two stores stay in step', `backend has ${backend.rows.size}`);
  assert(backend.deletes.every((d) => d.admin === true), 'backend deletes are admin-scoped (housekeeping, not one agent reaching into another)');
  assert(backend.deletes.every((d) => d.tenant === aos.tenant && d.agentId === 'engineer'), 'each delete carries the record\'s own tenant + author');
  assert((res.removed ?? []).length === 3, 'the result names what it removed');
  assert(res.backendFailures === 0, 'a clean run reports no divergence');

  // ── a backend that refuses a delete is REPORTED, not swallowed ──────────────────────────────────
  const b2 = new FakeBackend();
  const p2 = new MirroredMemoryProvider(b2, mirror);
  const doomed = await p2.store({ tenant: aos.tenant, agentId: 'qa', content: 'backend will refuse this', tags: [], type: 'Insight', importance: 0.2 });
  setAge(doomed.id, 90);
  b2.failOn.add(doomed.id);
  const res2 = await p2.maintain({ pruneAfterDays: 30, keepImportance: 0.5 });
  assert(res2.backendFailures === 1, 'a refused backend delete is counted as divergence', `got ${res2.backendFailures}`);

  // ── exact duplicates are consolidated on both grounds ───────────────────────────────────────────
  const b3 = new FakeBackend();
  const p3 = new MirroredMemoryProvider(b3, mirror);
  const dupA = await p3.store({ tenant: aos.tenant, agentId: 'cronbot', content: 'the identical nightly episode', tags: [], type: 'Insight', importance: 0.7 });
  const dupB = await p3.store({ tenant: aos.tenant, agentId: 'cronbot', content: 'the identical nightly episode', tags: [], type: 'Insight', importance: 0.7 });
  const res3 = await p3.maintain({ dedupeThreshold: 0.95 });
  const cronRows = aos.db.prepare("SELECT id FROM memories WHERE agent_id = 'cronbot'").all();
  assert(cronRows.length === 1, 'an exact-content duplicate is merged away in the mirror', `got ${cronRows.length}`);
  assert(res3.merged >= 1, 'the merge is reported');
  assert(b3.rows.size === 1, 'the duplicate is deleted from the backend too — automem does NOT dedupe these itself');
  void dupA; void dupB;

  // ── B2. an upkeep pass says it ran, even when it changed nothing ────────────────────────────────
  console.log('\nupkeep is observable — a quiet pass is not a silent one\n');
  {
    // `runMemoryMaintenance` used to audit only `if (res.pruned || res.merged)`, which made "upkeep is
    // running and finding nothing" indistinguishable from "upkeep is not running at all". A live instawp
    // check read five days of silence as a broken scheduler; the store was simply clean.
    aos.db.prepare('DELETE FROM memories').run();
    aos.db.prepare("DELETE FROM audit_events WHERE type = 'memory.maintained'").run();
    aos.settings.setMemoryConfig({ ...(aos.settings.memoryConfig() ?? { backend: 'sqlite' }), maintenance: { pruneAfterDays: 90, keepImportance: 0.6, dedupeThreshold: 0.95 } }, 'test');

    await aos.runMemoryMaintenance('scheduler');
    const quiet = aos.db.prepare("SELECT data FROM audit_events WHERE type = 'memory.maintained' ORDER BY ts DESC LIMIT 1").get();
    assert(!!quiet, 'a pass that deleted nothing still records that it ran');
    const qd = quiet ? JSON.parse(quiet.data) : {};
    assert(qd.noop === true, '…and flags itself a no-op, so a quiet pass is legible at a glance', JSON.stringify(qd));
    assert(qd.removed === undefined, 'the id list is left out of the audit row — it would bloat every pass');

    // …and a pass that DID delete says so, with the counts.
    // Inserted straight into the table: this section only exercises the AUDIT of a pass, and going through
    // a provider here would drag in whichever embedder the config above happens to have wired.
    aos.db.prepare("INSERT INTO memories (id, tenant, agent_id, content, tags, type, importance, created_at, recall_count) VALUES (?,?,?,?,'[]','Insight',0.2,?,0)")
      .run('mem_prunable', aos.tenant, 'engineer', 'prunable note', Date.now() - 200 * 86_400_000);
    await aos.runMemoryMaintenance('scheduler');
    const busy = JSON.parse(aos.db.prepare("SELECT data FROM audit_events WHERE type = 'memory.maintained' ORDER BY ts DESC LIMIT 1").get().data);
    assert(busy.noop === false && busy.pruned === 1, 'a pass that pruned reports the count and is not a no-op', JSON.stringify(busy));
  }

  // ── C. recall serves the agent's OWN text, whatever the backend did to it ───────────────────────
  console.log('\nrecall fidelity — the backend ranks, the mirror is the record\n');

  /** A backend that rewrites on ingest, exactly as automem does over MEMORY_CONTENT_SOFT_LIMIT. */
  class RewritingBackend extends FakeBackend {
    async store(input) {
      const rec = await super.store(input);
      const short = { ...rec, content: `Summary of: ${input.content.slice(0, 20)}…` };
      this.rows.set(rec.id, short);
      return rec; // the mirror is handed the record with the ORIGINAL content, as automem's POST returns
    }
    async recall() { return [...this.rows.values()]; }
  }

  const b4 = new RewritingBackend();
  const p4 = new MirroredMemoryProvider(b4, mirror);
  const original = 'Bunny edge-rule QA cannot be done on a *.instawp.site sandbox — it resolves to the PPU/OVH origin and never traverses the edge, so every probe returns 200.';
  const stored = await p4.store({ tenant: aos.tenant, agentId: 'qa', content: original, tags: [], type: 'Pattern', importance: 0.8 });
  const got = await p4.recall({ tenant: aos.tenant, agentId: 'qa', query: 'bunny edge rule', limit: 5 });
  const hit = got.find((r) => r.id === stored.id);
  assert(!!hit, 'the backend still decides what comes back and in what order');
  assert(hit.content === original, 'recall returns the agent\'s OWN text, not the backend\'s rewrite', `got: ${hit && hit.content}`);
  assert(b4.rows.get(stored.id).content.startsWith('Summary of:'), 'the backend really did hold a rewritten copy — the test would pass vacuously otherwise');

  // a row the mirror has never seen keeps whatever the backend holds — this can only add fidelity
  b4.rows.set('bk_orphan', { id: 'bk_orphan', tenant: aos.tenant, agentId: 'qa', content: 'only the backend knows this', tags: [], type: 'Insight', ts: Date.now(), scope: 'agent' });
  const got2 = await p4.recall({ tenant: aos.tenant, agentId: 'qa', query: 'orphan', limit: 5 });
  assert(got2.some((r) => r.id === 'bk_orphan' && r.content === 'only the backend knows this'), 'a record the mirror does not hold is passed through untouched');

  // ── B. the learning state's extractor version survives a load ───────────────────────────────────
  console.log('\ndreaming — the topic accumulator is not wiped on every load\n');
  const roundTripped = normalizeState({ firstPass: 1, passes: 9, totals: {}, topics: { freescout: { count: 30, lastSeen: 2 } }, recent: [], watermark: 5, topicsVersion: 3 });
  assert(roundTripped.topicsVersion === 3, 'topicsVersion survives normalizeState — the version check no longer fires every pass', `got ${roundTripped.topicsVersion}`);
  assert(roundTripped.topics.freescout.count === 30, 'the cumulative topic counts come back intact');
  const legacy = normalizeState({ firstPass: 1, passes: 2, totals: {}, topics: { old: { count: 4, lastSeen: 1 } }, recent: [] });
  assert(legacy.topicsVersion === undefined, 'a state written before the field still reports no version, so its stale map IS retired once');

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
