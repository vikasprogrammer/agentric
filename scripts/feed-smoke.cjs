#!/usr/bin/env node
/* Smoke test for the unified feed view — drives FeedStore over an in-memory DB (no live data touched). */
'use strict';
const assert = require('node:assert');
const { openDb } = require('../dist/state/db');
const { FeedStore } = require('../dist/state/feed');

const db = openDb(':memory:'); // migrated schema, ephemeral
const now = Date.now();
const T = (m) => now - m * 60000; // m minutes ago

const run = (sql, ...p) => db.prepare(sql).run(...p);

// --- goal + task (the attribution chain) ---
run(`INSERT INTO goals (id,tenant,title,created_by,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?)`,
  'g1', 'test', 'Clear support backlog', 'm1', T(60), T(60), 'm1');

// --- a finished session (done line), owned by m1 ---
run(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,spawned_by,run_as,created_at,updated_at,report_summary,outcome,rating,cost_usd)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  's_done', 'pod-troubleshooter', 'Redirect fix', 'fix redirects', 'tmux1', 'done', 'm1', 'm1', T(9), T(6), 'Shipped redirect fix', 'success', 'up', 0.42);
run(`INSERT INTO tasks (id,tenant,title,created_by,created_at,updated_at,updated_by,goal_id,last_session_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  't1', 'test', 'Fix redirects', 'm1', T(9), T(6), 'm1', 'g1', 's_done');

// resolved approval on that session
run(`INSERT INTO approvals (id,run_id,tenant,level,capability,args,reason,status,resolved_by,resolved_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  'a_res', 's_done', 'test', 'owner', 'payments.refund', JSON.stringify({ amount_usd: 180 }), 'Refund $180 to #8802', 'approved', 'm1', T(5), T(8));

// --- a running session, owned by m1 ---
run(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,spawned_by,run_as,created_at,busy_since)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  's_run', 'support-triage', 'Answering #4402', 'answer ticket', 'tmux2', 'running', 'm1', 'm1', T(5), T(4));
// pending approval + question on it (the two "needs you" decisions)
run(`INSERT INTO approvals (id,run_id,tenant,level,capability,args,reason,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  'a_pend', 's_run', 'test', 'owner', 'payments.refund', JSON.stringify({ amount_usd: 240, customer_id: '8821' }), 'Refund $240 to #8821', 'pending', T(3));
run(`INSERT INTO questions (id,run_id,tenant,agent,prompt,status,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  'q_pend', 's_run', 'test', 'billing-agent', 'Move globex to Scale or Pro?', 'pending', T(2));

// --- trail material for s_done (append-only logs) ---
run(`INSERT INTO audit_events (ts,run_id,tenant,type,principal,data) VALUES (?,?,?,?,?,?)`,
  T(8), 's_done', 'test', 'approval.requested', 'agent:pod-troubleshooter', JSON.stringify({ capability: 'payments.refund' }));
run(`INSERT INTO audit_events (ts,run_id,tenant,type,principal,data) VALUES (?,?,?,?,?,?)`,
  T(5), 's_done', 'test', 'approval.decided', 'm1', JSON.stringify({ approved: true }));
run(`INSERT INTO task_events (id,task_id,kind,body,author,session_id,created_at) VALUES (?,?,?,?,?,?,?)`,
  'te1', 't1', 'status', 'doing→done', 'agent:pod-troubleshooter', 's_done', T(4));

// --- folded message rows (notification/update class) ---
// a session-less notification addressed to member m1 (aud_member scope)
run(`INSERT INTO messages (id,type,session_id,agent,title,body,status,audience_kind,audience_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  'n1', 'notification', '', 'system', 'Heads up', 'Nightly backup finished', 'open', 'member', 'm1', T(12));
// an agent 'update' note on the running session (sessionOwner audience → scopes via the session)
run(`INSERT INTO messages (id,type,session_id,agent,title,body,status,audience_kind,audience_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  'u1', 'update', 's_run', 'support-triage', 'Task Update', 'Progress: 3 of 5 tickets done', 'open', 'sessionOwner', 's_run', T(15));
// a 'task' card: session_id encodes the real task (task:T9), body carries the task title
run(`INSERT INTO messages (id,type,session_id,agent,title,body,status,audience_kind,audience_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  'tk1', 'task', 'task:T9', 'docs-writer', 'Task done', 'Write the API reference', 'open', 'member', 'm1', T(11));
// excluded: an 'approval' mirror (its own branch) and a 'completed' card (dupes session.done)
run(`INSERT INTO messages (id,type,session_id,agent,title,body,status,created_at) VALUES (?,?,?,?,?,?,?,?)`,
  'x1', 'approval', 's_run', 'support-triage', 'Approval', '...', 'pending', T(13));
run(`INSERT INTO messages (id,type,session_id,agent,title,body,status,created_at) VALUES (?,?,?,?,?,?,?,?)`,
  'x2', 'completed', 's_done', 'pod-troubleshooter', 'Done', '...', 'open', T(14));
// excluded: a dismissed notification (a human hid it)
run(`INSERT INTO messages (id,type,session_id,agent,title,body,status,audience_kind,audience_id,dismissed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  'd1', 'notification', '', 'system', 'Old', '...', 'open', 'member', 'm1', T(1), T(16));

db.prepare(`UPDATE term_sessions SET input_tokens=?, output_tokens=? WHERE id='s_done'`).run(1200, 800);

const feed = new FeedStore(db);
const admin = { id: 'boss', isAdmin: true };
const m1 = { id: 'm1', isAdmin: false };
const m2 = { id: 'm2', isAdmin: false };

// 1) admin sees the 5 core items + 3 folded messages (n1, u1, tk1); the 3 excluded ones never appear
const all = feed.list({ viewer: admin });
assert.strictEqual(all.items.length, 8, `expected 8 items, got ${all.items.length}`);
assert.deepStrictEqual(all.items.slice(0, 5).map((i) => i.uid), ['question:q_pend', 'approval:a_pend', 'session:s_run', 'approval:a_res', 'session:s_done'], 'core ordering changed');
const uids = new Set(all.items.map((i) => i.uid));
assert.ok(uids.has('message:n1') && uids.has('message:u1') && uids.has('message:tk1'), 'folded notification/update/task missing');
assert.ok(!uids.has('message:x1') && !uids.has('message:x2') && !uids.has('message:d1'), 'excluded/dismissed message leaked into feed');
// folded rows carry the info state + their content as the title
const n1 = all.items.find((i) => i.uid === 'message:n1');
assert.strictEqual(n1.state, 'info');
assert.strictEqual(n1.title, 'Nightly backup finished');
// a task card connects to its real task (target) and names it (event — task title)
const tk1 = all.items.find((i) => i.uid === 'message:tk1');
assert.deepStrictEqual(tk1.target, { kind: 'task', id: 'T9' }, `task target=${JSON.stringify(tk1.target)}`);
assert.strictEqual(tk1.title, 'Task done — Write the API reference');
// core lines target their session
assert.deepStrictEqual(all.items.find((i) => i.uid === 'session:s_run').target, { kind: 'session', id: 's_run' });

// 1b) time window prunes old DONE/info history but NEVER hides a live session or an open decision
const recent = feed.list({ viewer: admin, since: T(4) }); // only the last 4 min of history
const rUids = new Set(recent.items.map((i) => i.uid));
assert.ok(rUids.has('session:s_run'), 'running session must survive the window');
assert.ok(rUids.has('approval:a_pend') && rUids.has('question:q_pend'), 'open decisions must survive the window');
assert.ok(!rUids.has('session:s_done') && !rUids.has('approval:a_res'), 'old done/resolved history should be pruned');
assert.ok(!rUids.has('message:u1') && !rUids.has('message:n1'), 'old info/notifications should be pruned');

// 2) attribution + goal tag resolved on the done session
const doneItem = all.items.find((i) => i.uid === 'session:s_done');
assert.strictEqual(doneItem.state, 'done');
assert.strictEqual(doneItem.agent, 'pod-troubleshooter');
assert.strictEqual(doneItem.runAs, 'm1');
assert.ok(doneItem.goal && doneItem.goal.title === 'Clear support backlog', 'goal tag not joined');
assert.strictEqual(doneItem.title, 'Shipped redirect fix');
assert.strictEqual(doneItem.hasTrail, true);
assert.strictEqual(doneItem.tokens, 2000, `tokens=${doneItem.tokens}`); // 1200 in + 800 out

// 3) decision args parsed from JSON
const pend = all.items.find((i) => i.uid === 'approval:a_pend');
assert.strictEqual(pend.state, 'decision');
assert.strictEqual(pend.args.amount_usd, 240);
assert.strictEqual(pend.level, 'owner');

// 4) counts
const counts = feed.counts(admin, new Date(new Date().setHours(0, 0, 0, 0)).getTime());
assert.strictEqual(counts.needsYou, 2, `needsYou=${counts.needsYou}`);
assert.strictEqual(counts.running, 1, `running=${counts.running}`);
assert.strictEqual(counts.doneToday, 1, `doneToday=${counts.doneToday}`);

// 5) filters
assert.strictEqual(feed.list({ viewer: admin, filter: 'needsYou' }).items.length, 2);
assert.strictEqual(feed.list({ viewer: admin, filter: 'running' }).items.length, 1);
assert.strictEqual(feed.list({ viewer: admin, filter: 'done' }).items.length, 2);

// 6) goal lens — both the session AND its approval inherit the goal via the session→task join
const g1 = feed.list({ viewer: admin, goalId: 'g1' });
assert.strictEqual(g1.items.length, 2, `goal filter items=${g1.items.length}`);
assert.deepStrictEqual(g1.items.map((i) => i.uid).sort(), ['approval:a_res', 'session:s_done']);

// 7) scoping — m1 owns everything + is the audience of n1/u1 (7); m2 owns nothing and is addressed by nothing (0)
assert.strictEqual(feed.list({ viewer: m1 }).items.length, 8, 'owner/addressee should see own rows + member-audience cards');
assert.strictEqual(feed.list({ viewer: m2 }).items.length, 0, 'a stranger should see nothing (incl. member-audience cards for others)');
assert.strictEqual(feed.counts(m2, 0).needsYou, 0, 'stranger needsYou must be 0');

// 8) keyset pagination
const p1 = feed.list({ viewer: admin, limit: 2 });
assert.strictEqual(p1.items.length, 2);
assert.ok(p1.nextCursor, 'expected a nextCursor');
const p2 = feed.list({ viewer: admin, limit: 2, cursor: p1.nextCursor });
assert.strictEqual(p2.items.length, 2);
assert.strictEqual(p2.items[0].uid, 'session:s_run', 'page 2 should continue after page 1');
assert.ok(!p1.items.some((a) => p2.items.some((b) => b.uid === a.uid)), 'pages must not overlap');

// 9) trail — 3 steps, oldest first, audit data parsed
const steps = feed.trail('s_done');
assert.strictEqual(steps.length, 3, `trail steps=${steps.length}`);
assert.ok(steps[0].ts <= steps[1].ts && steps[1].ts <= steps[2].ts, 'trail not sorted ascending');
assert.strictEqual(steps[0].kind, 'approval.requested');
assert.strictEqual(steps[2].kind, 'task.status');
assert.strictEqual(steps[1].detail.approved, true, 'audit detail should be parsed JSON');

console.log('✓ feed smoke: 9 groups passed (incl. folded message rows + audience scope)');
