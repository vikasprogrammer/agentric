#!/usr/bin/env node
// fleet-insights collector — read-only, zero-dependency (node:sqlite only).
//
// Emits ONE JSON bundle (stdout) of quantitative aggregates + qualitative samples
// for a single tenant's agent-os.db. Progress/warnings go to stderr so the JSON
// stays clean for `ssh ... > tenant.json`.
//
// Usage:  node collect.mjs <db-path> <tenant-label> [sinceDays=30]
//
// SAFETY: opens read-only and runs SELECT/PRAGMA only. It never writes, so it is
// safe against a LIVE database (a second reader sees committed WAL state). The db
// may be on a different agent-os version than this repo — every query is guarded
// by table/column existence so an older/newer schema degrades gracefully instead
// of throwing.

import { DatabaseSync } from 'node:sqlite';

const [dbPath, tenant, sinceDaysRaw] = process.argv.slice(2);
if (!dbPath || !tenant) {
  console.error('usage: node collect.mjs <db-path> <tenant-label> [sinceDays=30]');
  process.exit(2);
}
const sinceDays = Number(sinceDaysRaw ?? 30) || 30;
const windowStart = Date.now() - sinceDays * 86_400_000;

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch (e) {
  // Older node:sqlite without the readOnly option — fall back (still SELECT-only).
  try { db = new DatabaseSync(dbPath); }
  catch (e2) { console.error(`cannot open ${dbPath}: ${e2.message}`); process.exit(1); }
}

const warn = (m) => console.error(`[${tenant}] ${m}`);
const trunc = (s, n = 400) => (s == null ? null : String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

function hasTable(t) {
  try { return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t) != null; }
  catch { return false; }
}
function cols(t) {
  try { return new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name)); }
  catch { return new Set(); }
}
// Run a query, swallow schema errors into a warning + fallback value.
function safe(label, fn, fallback = null) {
  try { return fn(); }
  catch (e) { warn(`${label}: ${e.message}`); return fallback; }
}
function all(sql, ...p) { return db.prepare(sql).all(...p); }
function get(sql, ...p) { return db.prepare(sql).get(...p); }

const out = {
  tenant,
  dbPath,
  generatedAt: new Date().toISOString(),
  sinceDays,
  windowStartMs: windowStart,
  tables: safe('tables', () => all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name), []),
  warnings: [],
};

// ---- term_sessions ---------------------------------------------------------
if (hasTable('term_sessions')) {
  const c = cols('term_sessions');
  const createdCol = c.has('created_at') ? 'created_at' : null;
  const win = createdCol ? `WHERE ${createdCol} >= ${windowStart}` : '';
  out.sessions = {
    total: safe('sessions.total', () => get(`SELECT COUNT(*) n FROM term_sessions ${win}`)?.n ?? 0, 0),
    byStatus: safe('sessions.byStatus', () => all(`SELECT status, COUNT(*) n FROM term_sessions ${win} GROUP BY status ORDER BY n DESC`), []),
    byAgent: safe('sessions.byAgent', () => all(
      `SELECT agent, COUNT(*) n,
              SUM(CASE WHEN status='crashed' THEN 1 ELSE 0 END) crashed,
              SUM(CASE WHEN status='stopped' THEN 1 ELSE 0 END) stopped
       FROM term_sessions ${win} GROUP BY agent ORDER BY n DESC LIMIT 40`), []),
  };
  // Provenance buckets (member vs automation vs task vs chat).
  if (c.has('spawned_by')) {
    out.sessions.provenance = safe('sessions.provenance', () => {
      const rows = all(`SELECT spawned_by FROM term_sessions ${win}`);
      const b = { member: 0, automation: 0, task: 0, chat: 0, none: 0 };
      for (const r of rows) {
        const s = r.spawned_by;
        if (!s) b.none++;
        else if (s.startsWith('automation:')) b.automation++;
        else if (s.startsWith('task:')) b.task++;
        else if (s.startsWith('chat:')) b.chat++;
        else b.member++;
      }
      return b;
    }, null);
  }
  // Failed/stopped sessions — the friction roster for deep-dive.
  const taskCol = c.has('task') ? 'task' : "''";
  out.failedSessions = safe('failedSessions', () => all(
    `SELECT id, agent, title, ${taskCol} task, status, ${createdCol || 0} created_at
     FROM term_sessions ${win ? win + " AND" : "WHERE"} status IN ('crashed','stopped')
     ORDER BY ${createdCol || 'rowid'} DESC LIMIT 40`).map((r) => ({ ...r, task: trunc(r.task, 300) })), []);
  // Recent session tasks — clustering fodder for "recurring workflows".
  out.recentTasks = safe('recentTasks', () => all(
    `SELECT id, agent, title, ${taskCol} task, status, ${createdCol || 0} created_at
     FROM term_sessions ${win} ORDER BY ${createdCol || 'rowid'} DESC LIMIT 200`)
    .map((r) => ({ id: r.id, agent: r.agent, title: r.title, status: r.status, task: trunc(r.task, 240) })), []);
}

// ---- audit_events ----------------------------------------------------------
if (hasTable('audit_events')) {
  const c = cols('audit_events');
  const tsCol = c.has('ts') ? 'ts' : null;
  const win = tsCol ? `WHERE ${tsCol} >= ${windowStart}` : '';
  out.audit = {
    byType: safe('audit.byType', () => all(`SELECT type, COUNT(*) n FROM audit_events ${win} GROUP BY type ORDER BY n DESC LIMIT 80`), []),
  };
  // One raw `data` sample per type — lets the analyst see the real JSON shape
  // without this script hardcoding field names that vary across versions.
  out.audit.sampleByType = safe('audit.sampleByType', () => {
    const types = (out.audit.byType || []).slice(0, 25).map((r) => r.type);
    const m = {};
    for (const t of types) {
      const row = get(`SELECT data FROM audit_events WHERE type=? ${tsCol ? `AND ${tsCol}>=${windowStart}` : ''} ORDER BY ${c.has('id') ? 'id' : 'rowid'} DESC LIMIT 1`, t);
      if (row) m[t] = trunc(row.data, 500);
    }
    return m;
  }, {});
  // Gate decisions grouped by capability + effect. `data.decision` is a nested
  // object ({effect, level, riskClass, reason}); pull `.effect` for a clean
  // allow/approve/deny split, with a null fallback if the shape differs.
  out.audit.gateDecisions = safe('audit.gateDecisions', () => all(
    `SELECT json_extract(data,'$.capability') capability,
            COALESCE(json_extract(data,'$.decision.effect'), json_extract(data,'$.decision')) effect,
            COUNT(*) n
     FROM audit_events WHERE type='gate.decision' ${tsCol ? `AND ${tsCol}>=${windowStart}` : ''}
     GROUP BY capability, effect ORDER BY n DESC LIMIT 80`), []);
  // Errors + friction signal types.
  out.audit.friction = safe('audit.friction', () => all(
    `SELECT type, COUNT(*) n FROM audit_events
     WHERE type IN ('episode.error','session.error','budget.exceeded','gate.killswitch','approval.resolved','question.asked')
     ${tsCol ? `AND ${tsCol}>=${windowStart}` : ''} GROUP BY type ORDER BY n DESC`), []);
}

// ---- approvals (via messages, version-stable) ------------------------------
if (hasTable('messages')) {
  const c = cols('messages');
  const createdCol = c.has('created_at') ? 'created_at' : null;
  const win = createdCol ? `AND ${createdCol} >= ${windowStart}` : '';
  out.approvals = safe('approvals', () => ({
    byCapabilityStatus: c.has('capability') ? all(
      `SELECT capability, status, COUNT(*) n FROM messages
       WHERE type='approval' ${win} GROUP BY capability, status ORDER BY n DESC LIMIT 60`) : [],
    total: get(`SELECT COUNT(*) n FROM messages WHERE type='approval' ${win}`)?.n ?? 0,
  }), null);
  // Questions agents asked humans (recurring asks = missing product context).
  out.questions = safe('questions', () => ({
    byStatus: all(`SELECT status, COUNT(*) n FROM messages WHERE type='question' ${win} GROUP BY status ORDER BY n DESC`),
    sample: all(`SELECT agent, title, body, status FROM messages WHERE type='question' ${win} ORDER BY ${createdCol || 'rowid'} DESC LIMIT 40`)
      .map((r) => ({ agent: r.agent, status: r.status, title: trunc(r.title, 160), body: trunc(r.body, 300) })),
  }), null);
  // Completion outcomes.
  if (c.has('outcome')) {
    out.outcomes = safe('outcomes', () => all(
      `SELECT outcome, COUNT(*) n FROM messages WHERE type='completed' ${win} GROUP BY outcome ORDER BY n DESC`), []);
  }
}

// ---- episodes + memory health (self-learning signal) -----------------------
if (hasTable('memories')) {
  const c = cols('memories');
  const createdCol = c.has('created_at') ? 'created_at' : null;
  const win = createdCol ? `WHERE ${createdCol} >= ${windowStart}` : '';
  out.memoryHealth = safe('memoryHealth', () => {
    const recallCol = c.has('recall_count') ? 'recall_count' : null;
    return {
      total: get('SELECT COUNT(*) n FROM memories')?.n ?? 0,
      neverRecalled: recallCol ? (get(`SELECT COUNT(*) n FROM memories WHERE ${recallCol} IS NULL OR ${recallCol}=0`)?.n ?? null) : null,
      avgRecall: recallCol ? (get(`SELECT AVG(${recallCol}) a FROM memories`)?.a ?? null) : null,
    };
  }, null);
  // Top episodes by importance = highest-friction/effort runs. Content + metadata
  // (salience, outcome, sessionId) are the qualitative core of the analysis.
  const impCol = c.has('importance') ? 'importance' : null;
  const metaCol = c.has('metadata') ? 'metadata' : null;
  const agentCol = c.has('agent_id') ? 'agent_id' : (c.has('agent') ? 'agent' : "''");
  out.topEpisodes = safe('topEpisodes', () => all(
    `SELECT ${agentCol} agent, content, ${impCol || 0} importance, ${metaCol || "''"} metadata, ${createdCol || 0} created_at
     FROM memories ${win ? win + " AND" : "WHERE"} tags LIKE '%"episode"%'
     ORDER BY ${impCol || 'rowid'} DESC LIMIT 40`).map((r) => {
      let meta = null; try { meta = r.metadata ? JSON.parse(r.metadata) : null; } catch {}
      return {
        agent: r.agent, importance: r.importance,
        outcome: meta?.outcome ?? null, sessionId: meta?.sessionId ?? null,
        salience: meta?.salience ?? null, content: trunc(r.content, 700),
      };
    }), []);
  // Deliberate lessons agents recorded via report().
  out.topLessons = safe('topLessons', () => all(
    `SELECT ${agentCol} agent, content, ${createdCol || 0} created_at
     FROM memories ${win ? win + " AND" : "WHERE"} tags LIKE '%"lesson"%'
     ORDER BY ${createdCol || 'rowid'} DESC LIMIT 30`).map((r) => ({ agent: r.agent, content: trunc(r.content, 500) })), []);
}

db.close();
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
warn(`collected: ${out.sessions?.total ?? 0} sessions, ${(out.audit?.byType || []).reduce((a, r) => a + r.n, 0)} audit events, ${(out.topEpisodes || []).length} episodes`);
