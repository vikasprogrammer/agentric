/**
 * The **daily digest** — a tenant-wide "what got done today" standup.
 *
 * Two halves in one artifact:
 *  1. **📋 Today** — the per-session changelog, grouped by agent. The lines are already written for us:
 *     every session end stores an **episode** (`TerminalManager.writeEpisode` → `composeEpisode`), a
 *     deterministic "what this session did" summary graded by `episodeSalience`. The digest just reads
 *     today's episodes/sessions and rolls them up — no LLM, no new capture. The body thresholds on that
 *     salience score so a busy day of low-value test runs doesn't drown the real work (header keeps the
 *     full tally).
 *  2. **🧠 Learned** — the Dreaming pass's distilled `learnedGuidance` + open recommendations. Dreaming
 *     already produces these; the digest is the delivery they never had.
 *
 * Delivery, all sharing existing seams: a dated KB journal page (`operations/daily/<date>`, browsable +
 * revisioned) and one combined post to every configured chat platform (Slack and/or Discord) at end of
 * day. The render is pure + on-demand (the console "today" view and the KB page rebuild live); only the
 * chat post is time-gated — once per server-local
 * day past `digestHour`, guarded by a `digest.posted` audit. See docs/daily-digest-plan.md.
 */
import type { AgentOS } from '../kernel';
import { postMessage as slackPost, lookupChannelByName, joinChannel } from '../connectors/slack';
import { postMessage as discordPost } from '../connectors/discord';

const SECTION = 'operations';
const SALIENCE = 0.5;          // episodes at/above this importance make the body; the rest count in the tally only
const PER_AGENT = 6;           // cap body lines per agent (overflow → "+N more")
const MAX_POST_ATTEMPTS = 3;   // scheduled EOD post retries per day before giving up (M3 — bound outage churn)

export interface DigestModel {
  iso: string;                 // YYYY-MM-DD (server-local)
  label: string;               // e.g. "Wed Jul 13"
  total: number;
  buckets: { success: number; partial: number; failure: number; stopped: number; running: number; other: number };
  byAgent: { agent: string; lines: { title: string; outcome: string; importance: number; count?: number }[]; more: number }[];
  signals: { tasksCreated: number; tasksCompleted: number; approvals: number; rejected: number; errors: number; budgetStops: number };
  guidance: string[];          // a few distilled Dreaming imperatives
  recommendations: string[];   // open recommendation titles
}

interface SessionRow { id: string; agent: string; status: string; title: string; spawned_by: string | null; report: string | null; importance: number | null; outcome: string | null }
interface DigestLine { title: string; outcome: string; importance: number; count?: number }
interface AuditRow { type: string; data: string }

/** Server-local day bounds + labels for `now`. Time is the deploy box's tz (single-box deployment). */
export function localDayBounds(now = new Date()): { start: number; end: number; iso: string; label: string } {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  const start = d.getTime();
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return { start, end: start + 24 * 3_600_000, iso, label };
}

/** Read today's sessions + episodes + audit signals into a structured model. Pure over the DB. */
export function buildDigest(os: AgentOS, now = new Date()): DigestModel {
  const { start, end, iso, label } = localDayBounds(now);
  const db = os.db;

  // Each session ⋈ its end-of-session episode (importance + outcome) + the agent's own `report` summary
  // (the richest line source — vs the 72-char title). One episode per session in practice.
  const rows = db.prepare(
    `SELECT s.id, s.agent, s.status, s.title, s.spawned_by,
            (SELECT body FROM messages WHERE session_id = s.id AND type = 'completed' ORDER BY created_at DESC LIMIT 1) AS report,
            MAX(m.importance) AS importance,
            MAX(json_extract(m.metadata,'$.outcome')) AS outcome
       FROM term_sessions s
       LEFT JOIN memories m
         ON m.tags LIKE '%"episode"%' AND json_extract(m.metadata,'$.sessionId') = s.id
      WHERE s.created_at >= ? AND s.created_at < ?
      GROUP BY s.id`,
  ).all<SessionRow>(start, end);

  const buckets = { success: 0, partial: 0, failure: 0, stopped: 0, running: 0, other: 0 };
  const perAgent = new Map<string, DigestLine[]>();
  for (const r of rows) {
    const outcome = (r.outcome || (r.status === 'done' ? 'success' : r.status) || 'unknown').toLowerCase();
    if (outcome in buckets) (buckets as Record<string, number>)[outcome]++; else buckets.other++;
    const importance = r.importance ?? 0;
    // Fix 1: the line is the first sentence(s) of the agent's REPORT (rich), not the clipped title.
    const hasReport = isRealReport(r.report);
    const line = digestLine(r.report, r.title);
    // Fix 3: drop lines that describe the TASK rather than the result — a session with no report falls
    // back to its incoming task ("Task: …"), and inter-agent `ask` sessions ("Ask ← foo") aren't work.
    const askSession = (r.spawned_by ?? '').startsWith('ask:');
    const taskish = /^(task:|ask ←|ask\b)/i.test(line);
    // Drop generic end-card text and stubs — a no-report session whose title is also generic must not leak.
    const placeholder = line.length < 5 || /^(test|teste|untitled)$/i.test(line) || !isRealReport(line);
    // Drop agent SELF-MAINTENANCE — a report about editing its OWN prompt ("Rewrote my CLAUDE.md rev 5")
    // isn't fleet work. Detected on the reported LINE (not the audit event, which also fires when a session
    // did real work AND incidentally touched its config — dropping those would lose the real work).
    const selfMaint = /\b(my|its|their|own)\s+(claude\.?md|system prompt|starter prompts?|instructions?)\b/i.test(line);
    const include = !placeholder && !askSession && !taskish && !selfMaint && (hasReport || importance >= SALIENCE || r.status === 'done');
    if (include) {
      const list = perAgent.get(r.agent) ?? [];
      // A real report ranks at/above the salience line; a done-with-no-report just under it.
      list.push({ title: line, outcome, importance: importance || (hasReport ? SALIENCE : (r.status === 'done' ? SALIENCE - 0.01 : 0)) });
      perAgent.set(r.agent, list);
    }
  }

  const byAgent = [...perAgent.entries()]
    .map(([agent, all]) => {
      // Fix 2: collapse near-identical routine runs (e.g. 3× "fleet sweep — all healthy") into one ×N line.
      const deduped = dedupeLines(all).sort((a, b) => b.importance - a.importance);
      return { agent, lines: deduped.slice(0, PER_AGENT), more: Math.max(0, deduped.length - PER_AGENT) };
    })
    .sort((a, b) => b.lines.length - a.lines.length || a.agent.localeCompare(b.agent));

  // Governance / throughput signals from the audit stream.
  const signals = { tasksCreated: 0, tasksCompleted: 0, approvals: 0, rejected: 0, errors: 0, budgetStops: 0 };
  const audit = db.prepare(
    // `session.error` = a real run error; `episode.error` (a memory-STORE failure) is deliberately excluded
    // so a flaky memory backend doesn't inflate the header with "N errors" that aren't the fleet's doing.
    `SELECT type, data FROM audit_events WHERE ts >= ? AND ts < ?
       AND type IN ('task.created','task.completed','approval.auto_approved','approval.resolved','budget.exceeded','session.error')`,
  ).all<AuditRow>(start, end);
  for (const a of audit) {
    switch (a.type) {
      case 'task.created': signals.tasksCreated++; break;
      case 'task.completed': signals.tasksCompleted++; break;
      case 'approval.auto_approved': signals.approvals++; break;
      case 'approval.resolved': { let approved = true; try { approved = (JSON.parse(a.data) as { approved?: boolean }).approved !== false; } catch { /* keep default */ } approved ? signals.approvals++ : signals.rejected++; break; }
      case 'budget.exceeded': signals.budgetStops++; break;
      case 'session.error': signals.errors++; break;
    }
  }

  // The Dreaming half — distilled imperatives + open recommendation titles (already persisted).
  const guidance = os.settings.learnedGuidance()
    .split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).slice(0, 3);
  const recommendations = os.settings.recommendations().open.map((r) => r.title).slice(0, 3);

  return { iso, label, total: rows.length, buckets, byAgent, signals, guidance, recommendations };
}

const LINE_MAX = 200; // digest lines can breathe — Slack/Discord/KB all handle it (vs the 72-char title)
const DEDUP_STOP = new Set(['task', 'with', 'this', 'that', 'from', 'into', 'have', 'been', 'were', 'they', 'will', 'just', 'also', 'done', 'made', 'make', 'need', 'some', 'more', 'than', 'only', 'each', 'both', 'over', 'when', 'then', 'sent', 'added', 'set', 'the', 'and', 'for']);

/** Whether a `completed`-card body is the agent's own summary vs a GENERIC end card — the launcher writes
 *  "The session ended.", "The session ended unexpectedly (the process died).", or "(no summary)" when the
 *  agent never `report`ed. Those carry no signal and must NOT become a digest line / count as a report. */
export function isRealReport(body: string | null | undefined): boolean {
  const b = (body ?? '').trim();
  return !!b && !/^\(no summary\)$/i.test(b) && !/^the session ended\b/i.test(b) && !/^session ended\.?$/i.test(b);
}

/** The digest line for a session — the first sentence(s) of the agent's REPORT (rich), else the title.
 *  Clipped to a sentence/word boundary near LINE_MAX so we never chop mid-outcome the way the 72-char
 *  title did ("…root cause was…"). */
function digestLine(report: string | null, title: string): string {
  const src = isRealReport(report) ? (report as string).trim() : (title || '');
  const firstLine = src.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= LINE_MAX) return collapsed;
  const cut = collapsed.slice(0, LINE_MAX);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence > LINE_MAX * 0.5) return cut.slice(0, sentence + 1).trim();
  const space = cut.lastIndexOf(' ');
  return `${(space > LINE_MAX * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Significant-word set of a line (for similarity clustering). */
function tokenSet(s: string): Set<string> {
  // 3+ chars so short-but-meaningful acronyms count (gsc, ssh, api, ppu) — they anchor routine repeats.
  return new Set((s.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []).filter((w) => !DEDUP_STOP.has(w)));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Collapse near-identical routine runs within one agent into a single line with a `count`. Two lines
 *  cluster if they share a strong content overlap (Jaccard ≥ 0.55) OR the same leading 3 significant
 *  words (catches "Daily GSC report …" repeats whose bodies differ). Keeps the highest-importance rep. */
function dedupeLines(lines: DigestLine[]): DigestLine[] {
  const clusters: { rep: DigestLine; tokens: Set<string>; prefix: string; count: number }[] = [];
  for (const l of lines) {
    const tokens = tokenSet(l.title);
    const prefix = [...tokens].slice(0, 3).join(' ');
    const hit = clusters.find((c) => (!!prefix && c.prefix === prefix) || jaccard(c.tokens, tokens) >= 0.55);
    if (hit) {
      hit.count++;
      if (l.importance > hit.rep.importance) hit.rep = l; // keep the strongest exemplar
    } else {
      clusters.push({ rep: l, tokens, prefix, count: 1 });
    }
  }
  return clusters.map((c) => (c.count > 1 ? { ...c.rep, count: c.count } : c.rep));
}

/** Compact tally line — "18 sessions · 7 ✓ · 1 partial · 1 ✗ · 9 stopped". */
function tally(m: DigestModel): string {
  const b = m.buckets;
  const parts: string[] = [`${m.total} session${m.total === 1 ? '' : 's'}`];
  if (b.success) parts.push(`${b.success} ✓`);
  if (b.partial) parts.push(`${b.partial} partial`);
  if (b.failure) parts.push(`${b.failure} ✗`);
  if (b.stopped) parts.push(`${b.stopped} stopped`);
  if (b.running) parts.push(`${b.running} running`);
  return parts.join(' · ');
}

const MARK: Record<string, string> = { success: '✓', partial: '◐', failure: '✗', stopped: '·', running: '…' };

function signalLine(m: DigestModel): string {
  const s = m.signals;
  const parts: string[] = [];
  if (s.tasksCreated || s.tasksCompleted) parts.push(`${s.tasksCompleted}/${s.tasksCreated} tasks done`);
  if (s.approvals) parts.push(`${s.approvals} approved`);
  if (s.rejected) parts.push(`${s.rejected} rejected`);
  if (s.budgetStops) parts.push(`${s.budgetStops} budget stops`);
  if (s.errors) parts.push(`${s.errors} errors`);
  return parts.join(' · ');
}

/** Slack mrkdwn (`*bold*`, `_italic_`, `<url|text>` links). One combined message: 📋 Today + 🧠 Learned.
 *  `origin` (the tenant's public console URL) turns agent names into links + adds a footer to the full
 *  report; omitted → plain text (still valid). */
export function renderSlack(os: AgentOS, m: DigestModel, origin?: string): string {
  const name = os.tenant.charAt(0).toUpperCase() + os.tenant.slice(1);
  const link = (path: string, text: string) => (origin ? `<${origin}/#/${path}|${text}>` : text);
  const out: string[] = [`*📋 ${link('insights', `${name} — ${m.label}`)}*`, `_${tally(m)}_`];
  const sig = signalLine(m);
  if (sig) out.push(`_${sig}_`);
  out.push('');
  if (!m.byAgent.length) out.push('_No notable sessions today._');
  for (const a of m.byAgent) {
    out.push(`*${link(`agents/${a.agent}`, a.agent)}*`);
    for (const l of a.lines) out.push(`• ${l.title}${l.count ? ` (×${l.count})` : ''} ${MARK[l.outcome] ?? ''}`.trimEnd());
    if (a.more) out.push(`• _+${a.more} more_`);
    out.push(''); // breathing room between agents
  }
  if (m.guidance.length || m.recommendations.length) {
    out.push('*🧠 Learned*');
    for (const g of m.guidance) out.push(`• ${g}`);
    for (const r of m.recommendations) out.push(`⚠️ _Recommend:_ ${r}`);
    out.push('');
  }
  out.push(`_${link('insights', 'Open the full report in Agent OS →')}_`);
  return out.join('\n');
}

/** GitHub-flavoured markdown for the dated KB journal page. */
export function renderMarkdown(os: AgentOS, m: DigestModel): string {
  const out: string[] = [
    `_Fleet daily digest — auto-generated from today's session episodes + the self-learning pass. Rebuilds on demand._`,
    ``,
    `**${m.label}** · ${tally(m)}`,
  ];
  const sig = signalLine(m);
  if (sig) out.push(``, `_${sig}_`);
  out.push(``, `## What got done`);
  if (!m.byAgent.length) out.push(`- (no notable sessions today)`);
  for (const a of m.byAgent) {
    out.push(``, `### [${a.agent}](#/agents/${a.agent})`);
    for (const l of a.lines) out.push(`- ${MARK[l.outcome] ?? ''} ${l.title}${l.count ? ` (×${l.count})` : ''}`.replace('  ', ' '));
    if (a.more) out.push(`- _+${a.more} more_`);
  }
  if (m.guidance.length || m.recommendations.length) {
    out.push(``, `## Learned (Dreaming)`);
    for (const g of m.guidance) out.push(`- ${g}`);
    for (const r of m.recommendations) out.push(`- ⚠️ **Recommend:** ${r}`);
  }
  return out.join('\n');
}

/** Discord message content — standard markdown (`**bold**`), same two sections as Slack. Discord hard-
 *  caps a message at 2000 chars, so the body is trimmed with a "…more in the daily page" tail if long. */
export function renderDiscord(os: AgentOS, m: DigestModel, origin?: string): string {
  const name = os.tenant.charAt(0).toUpperCase() + os.tenant.slice(1);
  const link = (path: string, text: string) => (origin ? `[${text}](${origin}/#/${path})` : text);
  const out: string[] = [`**📋 ${name} — ${m.label}**`, tally(m)];
  const sig = signalLine(m);
  if (sig) out.push(sig);
  out.push('');
  if (!m.byAgent.length) out.push('_No notable sessions today._');
  for (const a of m.byAgent) {
    out.push(`**${link(`agents/${a.agent}`, a.agent)}**`);
    for (const l of a.lines) out.push(`• ${l.title}${l.count ? ` (×${l.count})` : ''} ${MARK[l.outcome] ?? ''}`.trimEnd());
    if (a.more) out.push(`• _+${a.more} more_`);
    out.push('');
  }
  if (m.guidance.length || m.recommendations.length) {
    out.push('**🧠 Learned**');
    for (const g of m.guidance) out.push(`• ${g}`);
    for (const r of m.recommendations) out.push(`⚠️ **Recommend:** ${r}`);
    out.push('');
  }
  out.push(link('insights', 'Open the full report in Agent OS →'));
  const text = out.join('\n');
  if (text.length <= 2000) return text;
  return text.slice(0, 1900).replace(/\n[^\n]*$/, '') + `\n… ${link('kb', 'full digest in Knowledge')}`;
}

export interface PostResult { posted: boolean; reason?: string; error?: string; channel?: string; total: number; iso: string; platforms?: PlatformPost[] }
export interface PlatformPost { platform: 'slack' | 'discord'; posted: boolean; channel: string; error?: string }

export class Digest {
  constructor(private readonly os: AgentOS) {}

  /** Today's model — the console/dashboard read path. */
  today(now = new Date()): DigestModel {
    return buildDigest(this.os, now);
  }

  /** Write (or refresh) today's dated KB journal page from the current model. No Slack. Best-effort. */
  refresh(by = 'scheduler', now = new Date()): DigestModel {
    const m = buildDigest(this.os, now);
    try {
      const page = this.os.kb.write({
        tenant: this.os.tenant, section: SECTION, slug: `daily/${m.iso}`,
        title: `Daily digest — ${m.label}`, body: renderMarkdown(this.os, m),
        tags: ['digest', 'operations'], summary: `${m.total} sessions`, author: by,
      });
      this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: by, type: 'kb.written', data: { id: page.id, section: page.section, slug: page.slug, rev: page.rev } });
    } catch { /* KB write is a nicety — never throw */ }
    return m;
  }

  /** The "posted today" floor: the later of midnight and the last **clear** for today. A clear resets the
   *  once-per-day post guard + the retry counter, so a "Clear & refresh" lets the scheduled post re-fire. */
  private postFloor(now = new Date()): number {
    const { start } = localDayBounds(now);
    const cleared = this.os.db.prepare("SELECT MAX(ts) AS t FROM audit_events WHERE type = 'digest.cleared' AND ts >= ?").get<{ t: number | null }>(start);
    return Math.max(start, cleared?.t ?? 0);
  }

  /** Manually **clear & refresh** today's digest: mark it cleared (append-only — resets the post guard so
   *  the EOD post re-fires) and re-render the dated KB page from the current data. Returns the fresh model
   *  (for the console preview). Useful after tuning the digest, or to regenerate a stale day. */
  clearAndRefresh(by = 'system', now = new Date()): DigestModel {
    this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: by, type: 'digest.cleared', data: { iso: localDayBounds(now).iso } });
    return this.refresh(by, now);
  }

  /** Whether at least one chat platform is set up to receive the digest (a bot token + a channel). */
  hasTarget(): boolean {
    const s = this.os.settings;
    return (!!s.slackBotToken() && !!s.digestChannel()) || (!!s.discordBotToken() && !!s.digestDiscordChannel());
  }

  /** Render today, refresh the KB page, and post the combined digest to EVERY configured chat platform
   *  (Slack and/or Discord — whichever has a bot token + a channel). Ignores the hour/once-per-day gate
   *  (that's `maybePostEod`'s job) — this is the manual "post now" path too. Empty day → refresh the KB
   *  page but skip the posts (no channel noise on a quiet day). */
  async postNow(by = 'scheduler', now = new Date(), origin?: string): Promise<PostResult> {
    const m = this.refresh(by, now);
    const base = { total: m.total, iso: m.iso };
    if (m.total === 0) return { ...base, posted: false, reason: 'no sessions today' };
    if (!this.hasTarget()) return { ...base, posted: false, error: 'no chat platform configured (set a Slack or Discord channel)' };

    const platforms: PlatformPost[] = [];
    const s = this.os.settings;
    if (s.slackBotToken() && s.digestChannel()) platforms.push(await this.postSlack(m, origin));
    if (s.discordBotToken() && s.digestDiscordChannel()) platforms.push(await this.postDiscord(m, origin));

    const posted = platforms.some((p) => p.posted);
    for (const p of platforms.filter((p) => !p.posted)) {
      this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: by, type: 'digest.error', data: { platform: p.platform, channel: p.channel, error: p.error } });
    }
    if (posted) {
      this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: by, type: 'digest.posted', data: { total: m.total, iso: m.iso, platforms: platforms.filter((p) => p.posted).map((p) => ({ platform: p.platform, channel: p.channel })) } });
    }
    return { ...base, posted, platforms, error: posted ? undefined : platforms[0]?.error };
  }

  /** Post to Slack: resolve the channel (id or name), best-effort join, send the mrkdwn render. */
  private async postSlack(m: DigestModel, origin?: string): Promise<PlatformPost> {
    const token = this.os.settings.slackBotToken();
    const ref = this.os.settings.digestChannel();
    let channelId = ref;
    if (!/^[CGD][A-Z0-9]{6,}$/.test(ref)) {
      const found = await lookupChannelByName(token, ref);
      if ('error' in found) return { platform: 'slack', posted: false, channel: ref, error: `channel "${ref}": ${found.error}` };
      channelId = found.channel;
    }
    await joinChannel(token, channelId).catch(() => undefined); // best-effort (public channels)
    const r = await slackPost(token, channelId, renderSlack(this.os, m, origin));
    return 'error' in r ? { platform: 'slack', posted: false, channel: ref, error: r.error } : { platform: 'slack', posted: true, channel: ref };
  }

  /** Post to Discord: send the markdown render to the configured channel id (Discord has no name lookup). */
  private async postDiscord(m: DigestModel, origin?: string): Promise<PlatformPost> {
    const token = this.os.settings.discordBotToken();
    const channel = this.os.settings.digestDiscordChannel();
    const r = await discordPost(token, channel, renderDiscord(this.os, m, origin));
    return 'error' in r ? { platform: 'discord', posted: false, channel, error: r.error } : { platform: 'discord', posted: true, channel };
  }

  /** The scheduled EOD hook (called from the hourly upkeep tick). Posts once per server-local day, only
   *  when enabled, at least one chat platform is configured, the hour has arrived, and today hasn't been
   *  posted yet. */
  async maybePostEod(now = new Date(), origin?: string): Promise<PostResult | null> {
    const s = this.os.settings;
    if (!s.digestEnabled() || !this.hasTarget()) return null;
    if (now.getHours() < s.digestHour()) return null;
    const { iso } = localDayBounds(now);
    // The "today" floor is the later of midnight and the last **clear** — so a "Clear & refresh today"
    // resets the once-per-day guard AND the retry counter, letting the EOD post re-fire cleanly.
    const floor = this.postFloor(now);
    const last = this.os.db.prepare("SELECT MAX(ts) AS t FROM audit_events WHERE type = 'digest.posted'").get<{ t: number | null }>();
    if (last?.t && last.t >= floor) return null; // already posted since the floor
    // M3: cap retries on a platform outage. `digest.posted` is only written on success, so without this a
    // day-long Slack/Discord outage would re-render + re-attempt every hour until midnight, flooding audit
    // with `digest.error` rows and rewriting the KB page hourly. Give up after MAX_POST_ATTEMPTS today.
    const fails = this.os.db.prepare("SELECT count(*) AS n FROM audit_events WHERE type = 'digest.error' AND ts >= ?").get<{ n: number }>(floor);
    if ((fails?.n ?? 0) >= MAX_POST_ATTEMPTS) return null;
    return this.postNow('scheduler', now, origin).catch((e) => ({ posted: false, error: e instanceof Error ? e.message : String(e), total: 0, iso }));
  }
}
