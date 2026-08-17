#!/usr/bin/env node
/* Task ↔ pull-request linking test (src/edge/task-prs.ts).
 *
 * The whole feature rests on ONE bet: agents already write the PR URL into the task, so the link layer
 * can be a parse rather than a new tool nobody calls. That bet is only as good as the parser, and its
 * failure modes are silent — a missed link reads as "this task shipped nothing", a wrongly-attributed
 * one points a human at another project's PR, and a merged PR rendered as `closed` reads as abandoned.
 * These assertions pin all three, plus the collection order across the three surfaces a task owns
 * (description / activity log / Discussion) and the merged-vs-closed distinction in the status cache.
 * Isolated home; no network — the GitHub half is exercised through the cache, not a live fetch.
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-task-prs-test-'));
process.env.AGENT_OS_HOME = HOME; process.env.AGENT_OS_TENANT = 'testco'; process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;
let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { extractPrRefs, taskPrRefs, prKey, PrCache, prSummary } = require(path.join(ROOT, 'dist/edge/task-prs.js'));
const aos = loadAgentOS();

console.log('\n\x1b[1m1) the parser finds what agents actually write\x1b[0m');
const keys = (t, ctx) => extractPrRefs(t, ctx).map(prKey);
assert(
  keys('Fixed + PR opened: https://github.com/InstaPods/instapods/pull/319 (branch fix/x).')[0] === 'instapods/instapods#319',
  'a plain PR URL in a closing note',
);
assert(keys('see https://github.com/acme/web/pull/12/files#discussion_r99 please')[0] === 'acme/web#12', 'a deep link (…/files, anchor) still resolves to the PR');
assert(keys('https://api.github.com/repos/acme/web/pulls/12')[0] === 'acme/web#12', 'the api.github.com form an agent pastes from `gh api`');
assert(keys('https://github.com/acme/web.git/pull/12')[0] === 'acme/web#12', 'a .git suffix is stripped from the repo');
assert(keys('https://github.com/acme/web/pull/12 and again https://github.com/ACME/Web/pull/12').length === 1, 'the same PR twice, in different case, is one link');
assert(keys('https://github.com/acme/web/issues/12').length === 0, 'an ISSUE url is not a PR');
assert(keys('https://github.com/acme/web/commit/abc123').length === 0, 'a commit url is not a PR');
// The dangerous direction: inventing a link. A bare `#12` is a numbered list, an issue, a version — a
// guess there would point a human at an unrelated PR, which is worse than showing nothing.
assert(keys('step #12 of the plan', { owner: 'acme', repo: 'web' }).length === 0, 'a BARE #12 is never a PR, even with a repo context');
assert(keys('landed in PR #12', { owner: 'acme', repo: 'web' })[0] === 'acme/web#12', 'but "PR #12" resolves against a known repo');
assert(keys('landed in PR #12').length === 0, 'and "PR #12" alone, with no repo context, resolves to nothing');

console.log('\n\x1b[1m2) collection spans the three surfaces a task owns, first-mention order\x1b[0m');
const t = aos.tasks.create({ tenant: aos.tenant, title: 'ship the thing', body: 'plan: see https://github.com/acme/web/pull/1', createdBy: 'm_alice' });
// An activity-log comment (the shape 94 of 404 live instapods tasks already had).
aos.tasks.update(t.id, { note: 'Fix implemented + PR opened: https://github.com/acme/web/pull/2', by: 'agent:engineer' });
// A Discussion message (`task.chat` on the `task:<id>` sentinel session).
aos.db.prepare(`INSERT INTO messages (id, type, session_id, agent, title, body, status, created_at)
                 VALUES (?, 'task.chat', ?, 'engineer', '', ?, 'open', ?)`)
  .run('m_pr3', `task:${t.id}`, 'follow-up in https://github.com/acme/web/pull/3 — and PR #2 is still open', Date.now() + 5_000);

const refs = taskPrRefs(aos.db, t.id, aos.tasks.get(t.id));
assert(refs.map((r) => r.number).join(',') === '1,2,3', 'all three surfaces contribute, ordered by first mention', refs.map((r) => r.number).join(','));
assert(refs[0].source === 'body' && refs[1].source === 'discussion' && refs[2].source === 'discussion', 'each ref records WHERE it was first seen');
assert(refs.filter((r) => r.number === 2).length === 1, 'a later "PR #2" re-mention does not duplicate the earlier link');

// Bare-number resolution is gated on the task agreeing on ONE repo — two repos and we must not guess.
const t2 = aos.tasks.create({ tenant: aos.tenant, title: 'two repos', body: 'https://github.com/acme/web/pull/1 and https://github.com/acme/api/pull/9 — also PR #77', createdBy: 'm_alice' });
assert(taskPrRefs(aos.db, t2.id, aos.tasks.get(t2.id)).length === 2, 'with two repos in play, a bare "PR #77" is dropped rather than mis-attributed');

const t3 = aos.tasks.create({ tenant: aos.tenant, title: 'no links', body: 'nothing shipped yet', createdBy: 'm_alice' });
assert(taskPrRefs(aos.db, t3.id, aos.tasks.get(t3.id)).length === 0, 'a task with no PR mention has no PRs (the section stays hidden)');

console.log('\n\x1b[1m3) the status cache keeps merged distinct from closed\x1b[0m');
const cache = new PrCache(aos.db, aos.tenant);
const cold = cache.hydrate(refs);
assert(cold.length === 3 && cold.every((p) => p.state === undefined), 'an un-fetched ref carries NO state (never a guessed one)');
assert(cache.stale(cold).length === 3, 'and every un-fetched ref is stale, so the refresh picks it up');

const now = Date.now();
const row = (n, o) => aos.db.prepare(`INSERT INTO github_prs (id, tenant, owner, repo, number, url, state, draft, merged, title, author, merged_at, updated_at, fetched_at, error)
    VALUES (@id, @tenant, 'acme', 'web', @number, @url, @state, @draft, @merged, @title, 'someone', @merged_at, @now, @fetched_at, NULL)`)
  .run({ id: `acme/web#${n}`, tenant: aos.tenant, number: n, url: `https://github.com/acme/web/pull/${n}`, title: `PR ${n}`, now, draft: 0, merged: 0, merged_at: null, state: 'open', fetched_at: now, ...o });
row(1, { state: 'closed', merged: 1, merged_at: now - 1000 });
row(2, { state: 'open' });
row(3, { state: 'closed', merged: 0 });

const warm = cache.hydrate(refs);
assert(warm[0].state === 'merged', 'GitHub reports a merged PR as `closed` + merged:true — we must show MERGED', warm[0].state);
assert(warm[1].state === 'open' && warm[2].state === 'closed', 'open stays open, an unmerged close stays closed');
assert(warm[0].title === 'PR 1', 'the cached title rides along for the list');
assert(cache.stale(warm).length === 0, 'a freshly-fetched PR is not re-fetched on the next page open');
assert(cache.stale(warm, true).length === 3, 'but an explicit refresh forces every one');
const older = cache.hydrate(refs).map((p) => ({ ...p, fetchedAt: now - 60 * 60_000 }));
assert(cache.stale(older).length === 3, 'and a status older than the TTL goes stale on its own');

const sum = prSummary(warm);
assert(sum.total === 3 && sum.merged === 1 && sum.open === 1 && sum.closed === 1, 'the summary counts each state once', JSON.stringify(sum));

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
