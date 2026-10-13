/**
 * SESSION SEARCH — the pure half of `session_history`'s keyword search (the SQL lives in
 * TerminalManager.searchSessions / indexSessionText; the schema in state/db.ts).
 *
 * Why it exists: `session_history` used to be a single `LIKE '%q%'` over a run's title and seed task.
 * That cannot find a run whose title describes its FIRST job when the thing you remember came later —
 * the common shape for a long interactive session a human keeps returning to. Asked to find one such
 * run, an agent on a live tenant gave up on the tool, opened the tenant DB with `node:sqlite` from
 * Bash and grepped other agents' transcripts, then handed the human a link it had assembled itself
 * (`#/sessions/ses_…`) that the console didn't route. Both halves are fixed here: the search reaches
 * what was said in the run, and every result carries the console URL so nobody composes one.
 */
import type { ChatTurn } from './conversation';
import { consolePage } from '../governance/chat-links';

/** Upper bound on one conversation's indexed text. Most runs are far below it; a days-long session is
 *  not, and indexing its whole transcript would make the FTS table the largest thing in the DB. */
export const SESSION_TEXT_CAP = 32 * 1024;
/** Over the cap, a human prompt keeps this much and the agent's words/actions this much each. */
const USER_PIECE = 400;
const OTHER_PIECE = 160;

/**
 * The searchable text of a conversation: what the human asked, what the agent said, and the short hint
 * of each action (a file name, a URL, a query) — the identifiers people actually search by. Tool RESULTS
 * are left out: they are mostly file contents and command output, and would drown every real match.
 *
 * Under the cap, everything goes in. Over it, never a head or tail cut — the thing being searched for is
 * as likely to be the LAST topic of a long run as the first. Instead every human prompt goes in first
 * (they are where a run changes subject), then the agent's side is sampled evenly across the whole run
 * into what's left. Output keeps the run's order.
 */
export function digestConversation(turns: ChatTurn[], cap = SESSION_TEXT_CAP): string {
  const pieces: { text: string; user: boolean }[] = [];
  for (const t of turns) {
    if (t.kind === 'user' || t.kind === 'assistant') {
      const s = t.text.replace(/\s+/g, ' ').trim();
      if (s) pieces.push({ text: s, user: t.kind === 'user' });
    } else if (t.kind === 'activity') {
      const s = [t.label, t.detail].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (s) pieces.push({ text: s.slice(0, 200), user: false });
    }
  }
  const total = pieces.reduce((n, p) => n + p.text.length + 1, 0);
  if (total <= cap) return pieces.map((p) => p.text).join('\n');

  const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const keep = new Map<number, string>();
  let used = 0;
  const users = pieces.map((p, i) => ({ p, i })).filter((x) => x.p.user);
  const userCost = users.reduce((n, x) => n + Math.min(x.p.text.length, USER_PIECE) + 1, 0);
  const userBudget = Math.floor(cap * 0.6);
  const userPick = userCost <= userBudget ? users : sampleEvenly(users, Math.floor(userBudget / (USER_PIECE + 1)));
  for (const { p, i } of userPick) {
    const s = clip(p.text, USER_PIECE);
    keep.set(i, s);
    used += s.length + 1;
  }
  const others = pieces.map((p, i) => ({ p, i })).filter((x) => !x.p.user);
  for (const { p, i } of sampleEvenly(others, Math.floor((cap - used) / (OTHER_PIECE + 1)))) {
    const s = clip(p.text, OTHER_PIECE);
    if (used + s.length + 1 > cap) break;
    keep.set(i, s);
    used += s.length + 1;
  }
  return [...keep.entries()].sort((x, y) => x[0] - y[0]).map(([, s]) => s).join('\n');
}

/** `k` items spread evenly across `arr`, always including the first and the last. */
function sampleEvenly<T>(arr: T[], k: number): T[] {
  if (k <= 0) return [];
  if (k >= arr.length) return arr;
  if (k === 1) return [arr[arr.length - 1]];
  const out: T[] = [];
  for (let j = 0; j < k; j++) out.push(arr[Math.round((j * (arr.length - 1)) / (k - 1))]);
  return out;
}

/**
 * Free text → an FTS5 MATCH expression. Every word is quoted (so `-`, `:` and `*` in what an agent types
 * can't become operators). `any` ORs them — nothing comes back empty because one word was off; `all`
 * ANDs them, which the search runs FIRST so a run matching every word is never outranked by one that
 * merely repeats a single word. '' when the query has no searchable word — the caller lists by recency.
 */
export function toSessionFtsQuery(query?: string, mode: 'any' | 'all' = 'any'): string {
  if (!query) return '';
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens) return '';
  const words = [...new Set(tokens)].filter((t) => t.length > 1 || /\d/.test(t)).slice(0, 12);
  return words.map((t) => `"${t}"`).join(mode === 'all' ? ' AND ' : ' OR ');
}

/**
 * Accept whatever an agent passes as a session reference and return the session id: the bare id
 * (`ses_…`), the console's tmux-named detail (`aos-ses_…`), or a whole console URL. Agents copy all
 * three around; failing on two of them sends the agent back to guessing.
 */
export function normalizeSessionRef(ref: string): string {
  let s = String(ref ?? '').trim();
  const m = s.match(/#\/sessions\/([^?#\s]+)/);
  if (m) s = decodeURIComponent(m[1]);
  return s.replace(/^aos-/, '');
}

/** The console deep-link for a session. The sessions route's detail segment is the tmux NAME
 *  (`aos-<id>`), not the bare id — the single place that encodes that. */
export function sessionConsoleUrl(origin: string, id: string): string {
  return consolePage(origin, 'sessions', `aos-${id}`);
}
