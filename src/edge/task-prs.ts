/**
 * Pull requests on a task — **derived, never declared**.
 *
 * "Which PRs came out of this task, and did they land?" is the one question the board couldn't answer,
 * even though the answer was already written down: an agent that ships code pastes the PR URL into its
 * closing note. Measured on the live instapods tenant before this shipped: 94 of 404 tasks already
 * carried a `github.com/<owner>/<repo>/pull/<n>` link in their activity log or Discussion, against 11
 * in the task body. So the link layer is a PARSE of what agents already write, not a new `task_link`
 * tool nobody would call — which also means it works retroactively on every task ever filed, and an
 * agent needs no new instruction, no new capability, and no new way to forget.
 *
 * Two halves, deliberately separated:
 *  - **Refs** (this file's `taskPrRefs`) — pure, synchronous, offline. Scan the task's body, its
 *    `task_events` log and its `task.chat` Discussion for PR URLs, dedupe by `<owner>/<repo>#<n>`,
 *    keep first-seen order. Never touches the network, so the sidebar can render instantly.
 *  - **Status** (`PrCache`) — the open/merged/closed state, fetched from the GitHub API and cached in
 *    `github_prs` with a short TTL. A ref with no cached status still renders (as a plain link); the
 *    status is an enrichment that degrades to nothing when GitHub isn't configured or reachable.
 *
 * Governance posture: read-only, audit-free. This reads public metadata about a PR with a token the
 * workspace already holds (the App's bot token, or the viewing member's own linked token) and writes
 * nothing back to GitHub. Nothing here is an agent-facing effect, so it never touches the gateway.
 */
import { Db } from '../state/db';
import { Task } from '../types';
import { pullRequest, PullRequestInfo } from '../connectors/github';

/** How long a fetched PR status is trusted before a re-fetch (a merged PR is re-checked too — its
 *  title can change, and the cost is one conditional API call per task open at worst). */
export const PR_TTL_MS = 5 * 60_000;
/** Hard ceiling on how many PRs we'll fetch for one task, so a pathological task can't fan out. */
export const PR_FETCH_MAX = 20;

/** Where a PR reference was first seen — the "why is this on my task" answer, shown as a tooltip. */
export type TaskPrSource = 'body' | 'activity' | 'discussion';

/** One PR referenced by a task: the parsed ref, plus whatever status we last managed to fetch. */
export interface TaskPr {
  owner: string;
  repo: string;
  number: number;
  url: string;
  /** Where it first appeared, and when (epoch ms) — first-seen wins on a duplicate. */
  source: TaskPrSource;
  firstSeenAt: number;
  /** Rolled-up state: `merged` is distinguished from a plain `closed` (GitHub reports both as closed). */
  state?: 'open' | 'closed' | 'merged';
  draft?: boolean;
  title?: string;
  author?: string;
  mergedAt?: number;
  updatedAt?: number;
  /** When the status was last fetched (epoch ms); absent = never successfully fetched. */
  fetchedAt?: number;
  /** Why the last fetch failed (404 = the token can't see that repo). Kept so the UI can say so. */
  error?: string;
}

/** A parsed reference before any status is attached. */
export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
  source: TaskPrSource;
  at: number;
}

/** `owner/repo#n`, lowercased — the dedupe + cache key. */
export function prKey(r: { owner: string; repo: string; number: number }): string {
  return `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}#${r.number}`;
}

/** A full PR URL anywhere in free text. Tolerates a trailing `/files`, `#discussion_r…`, `?w=1`, and
 *  the `api.github.com/repos/…/pulls/<n>` form an agent sometimes pastes from a `gh api` call. */
const PR_URL_RE = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)\/pull\/(\d+)/g;
const PR_API_URL_RE = /https?:\/\/api\.github\.com\/repos\/([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)\/pulls\/(\d+)/g;
/**
 * A *bare* PR reference — `PR #313`, `pull request #313`, `PR-313`. Only resolvable when the task has
 * exactly one repo context from a real URL, and deliberately NOT a bare `#313`: agents write numbered
 * lists, issue numbers and version strings, and a wrong repo guess is worse than a missing link.
 */
const PR_BARE_RE = /\b(?:PR|pull request)\s*#?\s*(\d{1,6})\b/gi;

/**
 * Extract PR references from one blob of text. `repoContext`, when given, also resolves bare
 * `PR #<n>` mentions against that repo (see PR_BARE_RE for why it's gated).
 */
export function extractPrRefs(
  text: string | null | undefined,
  repoContext?: { owner: string; repo: string },
): Array<{ owner: string; repo: string; number: number; url: string }> {
  const out: Array<{ owner: string; repo: string; number: number; url: string }> = [];
  const seen = new Set<string>();
  const push = (owner: string, repo: string, n: number, url: string) => {
    const ref = { owner, repo: repo.replace(/\.git$/, ''), number: n, url };
    const k = prKey(ref);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(ref);
  };
  const body = String(text ?? '');
  if (!body) return out;
  for (const re of [PR_URL_RE, PR_API_URL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const [, owner, repo, num] = m;
      const n = Number(num);
      if (!Number.isSafeInteger(n) || n <= 0) continue;
      push(owner, repo, n, `https://github.com/${owner}/${repo.replace(/\.git$/, '')}/pull/${n}`);
    }
  }
  if (repoContext) {
    PR_BARE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PR_BARE_RE.exec(body))) {
      const n = Number(m[1]);
      if (!Number.isSafeInteger(n) || n <= 0) continue;
      push(repoContext.owner, repoContext.repo, n, `https://github.com/${repoContext.owner}/${repoContext.repo}/pull/${n}`);
    }
  }
  return out;
}

/** One scannable text belonging to a task, with when it was written and which surface it came from. */
interface Scrap {
  text: string;
  at: number;
  source: TaskPrSource;
}

/** Every text a task owns, oldest first: its description, its activity log, its Discussion. */
function taskScraps(db: Db, taskId: string, task: Task | undefined): Scrap[] {
  const scraps: Scrap[] = [];
  // Title first, then body — both count as the task's "description" for provenance; a human filing
  // follow-up work titles it "Merge PR #314 …" often enough to be worth the scan.
  if (task?.title) scraps.push({ text: task.title, at: task.createdAt, source: 'body' });
  if (task?.body) scraps.push({ text: task.body, at: task.createdAt, source: 'body' });
  for (const r of db
    .prepare('SELECT kind, body, created_at FROM task_events WHERE task_id = ? AND body IS NOT NULL')
    .all<{ kind: string; body: string; created_at: number }>(taskId)) {
    // A legacy `comment` event renders in the Discussion, everything else in the activity log — the
    // same split `discussionTimeline` makes, so a link's stated origin matches where the reader sees it.
    scraps.push({ text: r.body, at: r.created_at, source: r.kind === 'comment' ? 'discussion' : 'activity' });
  }
  for (const r of db
    .prepare("SELECT body, created_at FROM messages WHERE session_id = ? AND type IN ('task.chat','task','task.mention')")
    .all<{ body: string; created_at: number }>(`task:${taskId}`)) {
    scraps.push({ text: r.body, at: r.created_at, source: 'discussion' });
  }
  return scraps.sort((a, b) => a.at - b.at);
}

/**
 * All PRs referenced by a task, first-mention order. Pure read of the task's own text — no network,
 * no writes. A duplicate keeps its EARLIEST sighting (the note that first announced the PR), because
 * "when did this task produce a PR" is the question the ordering answers.
 */
export function taskPrRefs(db: Db, taskId: string, task: Task | undefined): PrRef[] {
  const scraps = taskScraps(db, taskId, task);
  const byKey = new Map<string, PrRef>();
  // Scraps are oldest-first, so the first sighting of a key wins and later repeats are ignored.
  const add = (r: { owner: string; repo: string; number: number; url: string }, s: Scrap) => {
    const k = prKey(r);
    if (byKey.has(k)) return;
    byKey.set(k, { ...r, source: s.source, at: s.at });
  };
  for (const s of scraps) for (const r of extractPrRefs(s.text)) add(r, s);

  // Second pass for bare `PR #<n>`: only when the URLs agree on exactly ONE repo, so the number can't
  // be attributed to the wrong project. On the live fleet this is the common shape — an agent links the
  // PR once and then refers to it by number in later notes — and it's worth ~2× the mention recall.
  const repos = new Set([...byKey.values()].map((r) => `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`));
  if (repos.size === 1) {
    const first = [...byKey.values()][0];
    const ctx = { owner: first.owner, repo: first.repo };
    for (const s of scraps) for (const r of extractPrRefs(s.text, ctx)) add(r, s);
  }
  return [...byKey.values()].sort((a, b) => a.at - b.at || a.number - b.number);
}

// ── status cache ────────────────────────────────────────────────────────────────────────────────────
// The GitHub half. `github_prs` is a per-tenant CACHE, not a system of record: every row is
// reconstructible from GitHub, so it can be deleted at any time and only costs a re-fetch. It exists
// because the sidebar renders synchronously and the console opens the same task repeatedly.

interface PrRow {
  id: string; tenant: string; owner: string; repo: string; number: number; url: string;
  state: string | null; draft: number | null; merged: number | null; title: string | null;
  author: string | null; merged_at: number | null; updated_at: number | null;
  fetched_at: number | null; error: string | null;
}

/** A GitHub token to try, in order — the viewing member's own, then the workspace bot. */
export interface PrToken {
  token: string;
  kind: 'member' | 'bot';
}

export class PrCache {
  constructor(private readonly db: Db, private readonly tenant: string) {}

  /** Merge parsed refs with whatever status is cached. Offline — the sidebar's first paint. */
  hydrate(refs: PrRef[]): TaskPr[] {
    if (!refs.length) return [];
    const keys = refs.map(prKey);
    const rows = this.db
      .prepare(`SELECT * FROM github_prs WHERE tenant = ? AND id IN (${keys.map(() => '?').join(',')})`)
      .all<PrRow>(this.tenant, ...keys);
    const byKey = new Map(rows.map((r) => [r.id, r]));
    return refs.map((r) => toTaskPr(r, byKey.get(prKey(r))));
  }

  /** Which of these need a (re)fetch — never fetched, or older than the TTL. `force` takes everything. */
  stale(prs: TaskPr[], force = false, nowMs: number = Date.now()): TaskPr[] {
    return prs.filter((p) => force || !p.fetchedAt || nowMs - p.fetchedAt > PR_TTL_MS).slice(0, PR_FETCH_MAX);
  }

  /**
   * Fetch the given PRs' status and cache it. `tokens` are tried in order per PR and the first
   * non-404 answer wins — a member's own token sees repos the App isn't installed on, the bot token
   * sees the org's installed repos, and neither is guaranteed to cover the other. With NO tokens we
   * still try anonymously, which answers for a public repo; a private one records a 404 and the ref
   * degrades to a plain link.
   */
  async refresh(prs: TaskPr[], tokens: PrToken[], nowMs: number = Date.now()): Promise<void> {
    if (!prs.length) return;
    const attempts: Array<PrToken | { token: undefined; kind: 'anonymous' }> = tokens.length ? tokens : [{ token: undefined, kind: 'anonymous' }];
    await Promise.all(prs.map(async (p) => {
      let last: { error: string } | undefined;
      for (const t of attempts) {
        const info = await pullRequest(t.token, p.owner, p.repo, p.number);
        if (!('error' in info)) return this.store(p, info, nowMs);
        last = info;
        // Anything but "this token can't see it" is a real failure — don't burn the next token on it.
        if (!/\b40[34]\b/.test(info.error)) break;
      }
      this.storeError(p, last?.error ?? 'lookup failed', nowMs);
    }));
  }

  private store(ref: PrRef | TaskPr, info: PullRequestInfo, nowMs: number): void {
    this.db
      .prepare(`INSERT INTO github_prs (id, tenant, owner, repo, number, url, state, draft, merged, title, author, merged_at, updated_at, fetched_at, error)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                 ON CONFLICT(id) DO UPDATE SET url = excluded.url, state = excluded.state, draft = excluded.draft,
                   merged = excluded.merged, title = excluded.title, author = excluded.author,
                   merged_at = excluded.merged_at, updated_at = excluded.updated_at,
                   fetched_at = excluded.fetched_at, error = NULL`)
      .run(
        prKey(ref), this.tenant, ref.owner, ref.repo, ref.number, info.htmlUrl || ref.url,
        info.state, info.draft ? 1 : 0, info.merged ? 1 : 0, info.title, info.author,
        info.mergedAt ?? null, info.updatedAt ?? null, nowMs,
      );
  }

  /** Record a failed lookup so the UI can say "no access" instead of silently showing a bare link —
   *  and so a repeatedly-404ing ref still honours the TTL instead of re-fetching on every page open. */
  private storeError(ref: PrRef | TaskPr, error: string, nowMs: number): void {
    this.db
      .prepare(`INSERT INTO github_prs (id, tenant, owner, repo, number, url, fetched_at, error)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, error = excluded.error`)
      .run(prKey(ref), this.tenant, ref.owner, ref.repo, ref.number, ref.url, nowMs, error.slice(0, 300));
  }
}

function toTaskPr(ref: PrRef, row?: PrRow): TaskPr {
  const base: TaskPr = { owner: ref.owner, repo: ref.repo, number: ref.number, url: ref.url, source: ref.source, firstSeenAt: ref.at };
  if (!row) return base;
  return {
    ...base,
    url: row.url || base.url,
    state: row.merged ? 'merged' : (row.state === 'open' || row.state === 'closed' ? row.state : undefined),
    draft: row.draft === 1 || undefined,
    title: row.title ?? undefined,
    author: row.author ?? undefined,
    mergedAt: row.merged_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
    fetchedAt: row.fetched_at ?? undefined,
    error: row.error ?? undefined,
  };
}

/** Roll a task's PRs into the one-line summary the board/sidebar header shows. */
export function prSummary(prs: TaskPr[]): { total: number; merged: number; open: number; closed: number; draft: number } {
  const out = { total: prs.length, merged: 0, open: 0, closed: 0, draft: 0 };
  for (const p of prs) {
    if (p.state === 'merged') out.merged++;
    else if (p.state === 'closed') out.closed++;
    else if (p.state === 'open') { out.open++; if (p.draft) out.draft++; }
  }
  return out;
}
