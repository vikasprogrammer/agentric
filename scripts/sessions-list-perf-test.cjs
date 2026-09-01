#!/usr/bin/env node
/* The two server-side halves of the `/api/sessions` cost fix (see the perf autopsy in the PR).
 *
 * MEASURED on the live instawp tenant (3,951 unarchived rows, 5.03 MB payload, v0.410.3): `GET
 * /api/sessions` burned 654 s of handler time in a 51-minute window — 21% of a single-threaded event
 * loop — at ~74 calls/min. Two items in that budget were defects rather than the cost of the answer:
 *
 *  1. `zlib.gzipSync` over the 5.03 MB body, 38 ms, ON THE MAIN THREAD. The GZIP_CACHE is keyed by the
 *     ETag, and the ETag covers derived fields (`alive`/`working`/`blocked`) that move every tick on a
 *     tenant with live runs — so nearly every poll was a cache miss that stalled the loop. It surfaced
 *     as a 1.66 s `maxStallMs` on `/health` and every other route, which is exactly the misattribution
 *     `request-metrics` exists to prevent. Now `zlib.gzip` (threadpool).
 *  2. `backfillCosts` re-probing transcripts that do not exist. 25 rows on that tenant were `cost_usd
 *     IS NULL` with a `claude_session_id` and no `.jsonl` on disk — runs that crashed before their
 *     runtime opened one. The self-healing "stamp zeros" branch only fired when `cost_usd != null`, so
 *     those rows consumed the whole 20-parse budget on EVERY poll, forever, and `findTranscript`
 *     readdirs every project dir under every transcript root on each miss.
 *
 * Pins, in order: the response is byte-intact through the async path; a 304 still short-circuits BEFORE
 * compression; a client that doesn't advertise gzip is untouched (the gate hook + MCP loopback case);
 * concurrent requests all land; a settled no-transcript row heals exactly once; and a JUST-ended row is
 * still given time to flush rather than being stamped a premature zero.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-list-perf-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 250) : ''}`));

const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));

const HOUR = 3600_000;

(async () => {
  const registry = new TenantRegistry(ROOT, 0);
  registry.bootAll();
  const { os: aos, tm } = registry.get('testco');
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // ── 1. the async compression path ────────────────────────────────────────────────────────────────
  // `/health` is public, so this exercises sendBody without standing up a login.
  const r1 = await fetch(`${base}/health`);
  const j1 = await r1.json();
  assert(r1.status === 200 && typeof j1.version === 'string', 'a JSON response is intact through the async write path', j1);

  const etag = r1.headers.get('etag');
  assert(!!etag, 'the response still carries an ETag');
  const r304 = await fetch(`${base}/health`, { headers: { 'if-none-match': etag } });
  assert(r304.status === 304, 'a matching If-None-Match still 304s (before any compression runs)');

  // The gate hook and every MCP loopback call send no accept-encoding. They must get identity bytes.
  const plain = await fetch(`${base}/health`, { headers: { 'accept-encoding': 'identity' } });
  assert(!plain.headers.get('content-encoding'), 'a client that does not advertise gzip gets identity bytes');
  assert(typeof (await plain.json()).version === 'string', 'the identity body is intact');

  // A body over COMPRESS_MIN must actually come back gzip-encoded, and decode to the same bytes. The
  // SPA index is served through sendFile → sendBody, so it covers the cached-asset path too.
  // A body over COMPRESS_MIN, on the very route this change is about. Deliberately NOT a built console
  // asset: `web/dist` is a separate build step that CI does not run, and depending on it made this test
  // pass locally and fail on the runner.
  aos.agents.set('engineer', { id: 'engineer', name: 'Engineer', runtime: 'claude-code', dir: HOME });
  const insert = aos.db.prepare(
    "INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,secret,claude_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const NOW = Date.now();
  for (let i = 0; i < 300; i++) {
    const id = `ses_bulk${String(i).padStart(4, '0')}`;
    // Padded so the list comfortably clears COMPRESS_MIN, and NOT uniform — a body of identical rows
    // would compress to almost nothing and stop exercising the path realistically.
    insert.run(id, 'engineer', `run ${i} ${'t'.repeat(40)}`, `task ${i} ${String(i).repeat(60)}`, 'aos-' + id, 'done', 1, 0, 'sec-' + id, null, NOW - i * 1000, NOW - i * 1000);
  }
  const owner = aos.team.listMembers().find((m) => m.role === 'owner');
  const cookie = `aos_sid=${aos.team.createSession(owner.id)}`;

  const big = await fetch(`${base}/api/sessions`, { headers: { cookie, 'accept-encoding': 'gzip' } });
  assert(big.status === 200, 'the sessions list is served through the async gzip path');
  assert(big.headers.get('content-encoding') === 'gzip', 'the compressed branch actually ran', big.headers.get('content-encoding'));
  // `fetch` transparently inflates, so this is the DECODED body. An async write that handed back the
  // wrong buffer would still have a plausible length — parse it and check the rows survived intact.
  const listed = await big.json();
  assert(Array.isArray(listed) && listed.length >= 300, 'the compressed response decodes to the full list', listed.length);
  assert(listed.some((r) => r.id === 'ses_bulk0000') && listed.some((r) => r.id === 'ses_bulk0299'), 'first and last rows both survive the round trip');
  const declared = Number(big.headers.get('content-length'));
  const rawLen = Buffer.byteLength(JSON.stringify(listed));
  assert(declared > 0 && declared < rawLen, 'content-length is the ENCODED length, set from the bytes written', { declared, rawLen });

  // The same list without gzip must be byte-identical once decoded — the encoding is transport only.
  const identity = await fetch(`${base}/api/sessions`, { headers: { cookie, 'accept-encoding': 'identity' } });
  assert(!identity.headers.get('content-encoding'), 'the same route serves identity bytes to a client that asks for them');
  assert((await identity.json()).length === listed.length, 'both encodings carry the same rows');

  // Nothing may be dropped when many responses compress at once on the threadpool.
  const many = await Promise.all(Array.from({ length: 50 }, () =>
    fetch(`${base}/health`, { headers: { 'accept-encoding': 'gzip' } }).then((r) => r.json().then((b) => b.version)),
  ));
  assert(many.length === 50 && many.every((v) => v === j1.version), '50 concurrent responses all complete and match');

  // ── 2. backfillCosts stops re-probing a transcript that is never coming ──────────────────────────
  const row = (id, updatedAt) => aos.db.prepare(
    "INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,secret,claude_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(id, 'engineer', id, 'work', 'aos-' + id, 'done', 1, 0, 'sec-' + id, `00000000-0000-4000-8000-${id.slice(-12).padStart(12, '0')}`, updatedAt, updatedAt);

  // A run that went terminal long ago and never wrote a transcript — the live instawp shape.
  row('ses_settled', Date.now() - 3 * HOUR);
  // A run that ended seconds ago: its transcript may simply not be flushed yet.
  row('ses_fresh', Date.now());

  const cost = (id) => aos.db.prepare('SELECT cost_usd, active_ms, turns, tool_calls FROM term_sessions WHERE id = ?').get(id);
  assert(cost('ses_settled').cost_usd === null, 'the settled row starts unpriced');

  tm.listSessions();

  const settled = cost('ses_settled');
  assert(settled.cost_usd === 0 && settled.active_ms === 0 && settled.turns === 0 && settled.tool_calls === 0,
    'a no-transcript row past the settle window is stamped zero, so it stops being re-probed', settled);

  const fresh = cost('ses_fresh');
  assert(fresh.cost_usd === null && fresh.active_ms === null,
    'a JUST-ended row is left alone — its transcript may still be flushing', fresh);

  // The heal must be idempotent, and must not re-enter the parse budget on the next poll.
  tm.listSessions();
  const again = cost('ses_settled');
  assert(again.cost_usd === 0 && again.active_ms === 0, 'the stamp is stable across a second poll', again);

  server.close();
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
