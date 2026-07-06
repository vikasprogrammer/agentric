/**
 * Workspace settings — instance-wide config that lives in the per-workspace DB.
 *
 * The headline setting is the **Company context**: one shared markdown document (voice, facts,
 * conventions, links — and, if you like, how this workspace uses memory) that every claude-code
 * agent inherits, injected at session launch via `claude --append-system-prompt-file`. Editing it
 * once beats duplicating the same prose across every agent's CLAUDE.md.
 *
 * Backed by a key→value `settings` table (same constructor-takes-Db pattern as the other stores),
 * so adding more instance-level settings later is just another key.
 */
import { Db } from '../state/db';
import { MemoryConfig, Recommendation, RuntimeTuning, sanitizeRuntimeTuning } from '../types';

const COMPANY_KEY = 'company_md';
const COMPOSIO_KEY = 'composio_api_key';
const COMPOSIO_WEBHOOK_KEY = 'composio_webhook_secret';
const SLACK_APP_TOKEN_KEY = 'slack_app_token'; // xapp-… (Socket Mode, connections:write)
const SLACK_BOT_TOKEN_KEY = 'slack_bot_token'; // xoxb-… (chat.postMessage, users.info)
const DISCORD_BOT_TOKEN_KEY = 'discord_bot_token'; // Bot … (Gateway connect + post messages)
const MEMORY_KEY = 'memory_config'; // the live memory backend (JSON MemoryConfig; overrides the file default)
const RUNTIME_DEFAULTS_KEY = 'runtime_defaults'; // workspace-wide model/effort/permission fallback (JSON RuntimeTuning)
const DREAMING_KEY = 'dreaming_every_hours'; // self-learning cadence in hours; 0/unset = off
const DREAMING_STATE_KEY = 'dreaming_state'; // compounding self-learning state (cumulative totals/topics/recent)
const LEARNED_GUIDANCE_KEY = 'learned_guidance'; // distilled imperatives injected into every agent's prompt
const LEARNED_APPLY_KEY = 'learned_guidance_apply'; // 'off' to stop injecting (default on once guidance exists)
const RECOMMENDATIONS_KEY = 'learned_recommendations'; // { open: Recommendation[], dismissed: string[] }
const GOVERNANCE_KEY = 'governance_thresholds'; // numeric caps the never-tier policy rules read (JSON GovernanceThresholds)

/** Numeric governance caps the policy's never-tier rules reference by name (e.g. `$moneyCapUsd`).
 *  Live-editable in Settings → Governance; resolved at classify time by the policy engine. */
export interface GovernanceThresholds {
  /** A single payment/refund at or below this (USD) may be approved; above it is refused outright. */
  moneyCapUsd: number;
  /** A delete of at most this many items may be approved; above it is refused outright. */
  bulkDeleteCount: number;
  /** An email to more than this many EXTERNAL recipients escalates to the red (owner) approval tier. */
  emailBulkCap: number;
}

export const DEFAULT_GOVERNANCE_THRESHOLDS: GovernanceThresholds = { moneyCapUsd: 500, bulkDeleteCount: 25, emailBulkCap: 10 };

const EMAIL_ORG_DOMAINS_KEY = 'email_org_domains'; // internal email domains (JSON string[]); email.send to these is green
const CHAT_ROUTER_KEY = 'chat_router_enabled'; // generic Slack/Discord `/agent` router fallback ('off' disables)
const KILL_SWITCH_KEY = 'kill_switch'; // workspace-wide emergency stop (JSON KillSwitchState)

/** The workspace emergency stop. When engaged, the gate denies EVERY action, fleet-wide, until cleared. */
export interface KillSwitchState {
  engaged: boolean;
  reason?: string;
  updatedAt?: number;
  updatedBy?: string;
}

export interface CompanySettings {
  /** The company-wide markdown context. Empty string when unset. */
  companyMd: string;
  updatedAt?: number;
  updatedBy?: string;
}

interface SettingRow {
  value: string;
  updated_at: number;
  updated_by: string | null;
}

export class SettingsStore {
  constructor(private readonly db: Db) {}

  private getRow(key: string): SettingRow | undefined {
    return this.db.prepare('SELECT value, updated_at, updated_by FROM settings WHERE key = ?').get<SettingRow>(key);
  }

  set(key: string, value: string, by?: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(key, value, Date.now(), by ?? null);
  }

  /** The Company context document + who last touched it. */
  company(): CompanySettings {
    const row = this.getRow(COMPANY_KEY);
    return { companyMd: row?.value ?? '', updatedAt: row?.updated_at, updatedBy: row?.updated_by ?? undefined };
  }

  setCompany(md: string, by?: string): CompanySettings {
    this.set(COMPANY_KEY, md, by);
    return this.company();
  }

  // ── integration credentials (instance-wide secrets used by connectors/triggers) ──
  // One company Composio key powers every Composio-backed connector; per-member isolation comes from
  // the Tool Router `user_id` (the spawning member's email), not from separate keys. Slack app
  // credentials (signing secret, bot token) will follow the same key→value pattern here.

  /** The workspace Composio API key, or '' when unset. */
  composioApiKey(): string {
    return this.getRow(COMPOSIO_KEY)?.value?.trim() ?? '';
  }

  /** Whether a Composio key is set + who last touched it (never returns the secret itself). */
  composioMeta(): { set: boolean; updatedAt?: number; updatedBy?: string } {
    const row = this.getRow(COMPOSIO_KEY);
    return { set: !!row?.value, updatedAt: row?.updated_at, updatedBy: row?.updated_by ?? undefined };
  }

  setComposioApiKey(key: string, by?: string): void {
    this.set(COMPOSIO_KEY, key.trim(), by);
  }

  /** Signing secret (Svix `whsec_…`) for verifying Composio webhook/trigger deliveries. '' when unset. */
  composioWebhookSecret(): string {
    return this.getRow(COMPOSIO_WEBHOOK_KEY)?.value?.trim() ?? '';
  }
  composioWebhookSet(): boolean {
    return !!this.getRow(COMPOSIO_WEBHOOK_KEY)?.value;
  }
  setComposioWebhookSecret(secret: string, by?: string): void {
    this.set(COMPOSIO_WEBHOOK_KEY, secret.trim(), by);
  }

  // ── native Slack (Socket Mode) ───────────────────────────────────────────────────
  // One company Slack app, configured once here, shared across the whole workspace. The app-level
  // token opens the outbound Socket-Mode WebSocket (no public URL needed); the bot token posts
  // replies + resolves the triggering Slack user's email → an Agent OS member (per-member run-as).

  /** App-level token (`xapp-…`) for Socket Mode, or '' when unset. */
  slackAppToken(): string {
    return this.getRow(SLACK_APP_TOKEN_KEY)?.value?.trim() ?? '';
  }
  /** Bot token (`xoxb-…`) for chat.postMessage / users.info, or '' when unset. */
  slackBotToken(): string {
    return this.getRow(SLACK_BOT_TOKEN_KEY)?.value?.trim() ?? '';
  }
  /** Both tokens present — the minimum to open a Socket-Mode connection and reply. */
  slackConfigured(): boolean {
    return !!this.slackAppToken() && !!this.slackBotToken();
  }
  /** Which Slack tokens are set + who last touched them (never returns the tokens themselves). */
  slackMeta(): { appToken: boolean; botToken: boolean; updatedAt?: number; updatedBy?: string } {
    const app = this.getRow(SLACK_APP_TOKEN_KEY);
    const bot = this.getRow(SLACK_BOT_TOKEN_KEY);
    const updatedAt = Math.max(app?.updated_at ?? 0, bot?.updated_at ?? 0) || undefined;
    const updatedBy = (app?.updated_at ?? 0) >= (bot?.updated_at ?? 0) ? app?.updated_by : bot?.updated_by;
    return { appToken: !!app?.value, botToken: !!bot?.value, updatedAt, updatedBy: updatedBy ?? undefined };
  }
  setSlackAppToken(token: string, by?: string): void {
    this.set(SLACK_APP_TOKEN_KEY, token.trim(), by);
  }
  setSlackBotToken(token: string, by?: string): void {
    this.set(SLACK_BOT_TOKEN_KEY, token.trim(), by);
  }

  // ── native Discord (Gateway) ───────────────────────────────────────────────────
  // One company Discord bot, configured once here, shared across the whole workspace. The single bot
  // token both opens the outbound Gateway WebSocket (no public URL needed) and posts replies. Unlike
  // Slack there is no separate app-level token — Discord uses one bot token for both.

  /** Bot token (`Bot …`) for the Gateway + posting messages, or '' when unset. */
  discordBotToken(): string {
    return this.getRow(DISCORD_BOT_TOKEN_KEY)?.value?.trim() ?? '';
  }
  /** The bot token present — the minimum to open a Gateway connection and reply. */
  discordConfigured(): boolean {
    return !!this.discordBotToken();
  }
  /** Whether the Discord token is set + who last touched it (never returns the token itself). */
  discordMeta(): { botToken: boolean; updatedAt?: number; updatedBy?: string } {
    const bot = this.getRow(DISCORD_BOT_TOKEN_KEY);
    return { botToken: !!bot?.value, updatedAt: bot?.updated_at ?? undefined, updatedBy: bot?.updated_by ?? undefined };
  }
  setDiscordBotToken(token: string, by?: string): void {
    this.set(DISCORD_BOT_TOKEN_KEY, token.trim(), by);
  }

  // ── memory backend ───────────────────────────────────────────────────────────────
  // The live memory backend (sqlite / libsql / automem), editable from Settings → Memory and
  // applied without a restart. Stored here as the full MemoryConfig JSON (secrets included, like
  // the Slack tokens above) so it survives a restart and overrides the file default. The server
  // redacts secrets before sending the config to the console; this returns the full object for the
  // kernel to rebuild the provider.

  /** The stored memory config, or null when none has been saved (→ fall back to the file default). */
  memoryConfig(): MemoryConfig | null {
    const raw = this.getRow(MEMORY_KEY)?.value;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as MemoryConfig;
    } catch {
      return null;
    }
  }

  /** Who last changed the memory backend (never returns secrets — the config itself stays server-side). */
  memoryMeta(): { updatedAt?: number; updatedBy?: string } {
    const row = this.getRow(MEMORY_KEY);
    return { updatedAt: row?.updated_at, updatedBy: row?.updated_by ?? undefined };
  }

  setMemoryConfig(cfg: MemoryConfig, by?: string): void {
    this.set(MEMORY_KEY, JSON.stringify(cfg), by);
  }

  // ── runtime defaults ───────────────────────────────────────────────────────────
  // The workspace-wide model / effort applied to every claude-code agent that
  // doesn't override the field in its own manifest. One place to retune the whole fleet (e.g. drop
  // everyone to a cheaper model, or raise effort) without editing each agent.json. An empty/missing
  // setting means "no workspace default" → each unset field falls through to the claude CLI's own default.

  /** The stored runtime defaults (model/effort/permission), or `{}` when none saved. */
  runtimeDefaults(): RuntimeTuning {
    const raw = this.getRow(RUNTIME_DEFAULTS_KEY)?.value;
    if (!raw) return {};
    try {
      return sanitizeRuntimeTuning(JSON.parse(raw) as Record<string, unknown>).tuning;
    } catch {
      return {};
    }
  }

  /** Who last changed the runtime defaults. */
  runtimeDefaultsMeta(): { updatedAt?: number; updatedBy?: string } {
    const row = this.getRow(RUNTIME_DEFAULTS_KEY);
    return { updatedAt: row?.updated_at, updatedBy: row?.updated_by ?? undefined };
  }

  setRuntimeDefaults(tuning: RuntimeTuning, by?: string): RuntimeTuning {
    this.set(RUNTIME_DEFAULTS_KEY, JSON.stringify(tuning), by);
    return this.runtimeDefaults();
  }

  // ── self-learning (Dreaming) cadence ─────────────────────────────────────────────
  // How often the periodic reflection pass runs, in hours. 0 / unset → off (manual "run now" only).
  /** Hours between automatic self-learning passes; 0 when disabled. */
  dreamingEveryHours(): number {
    const n = Number(this.getRow(DREAMING_KEY)?.value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  setDreamingEveryHours(hours: number, by?: string): void {
    this.set(DREAMING_KEY, String(Number.isFinite(hours) && hours > 0 ? Math.floor(hours) : 0), by);
  }

  /** The compounding self-learning state (cumulative totals/topics/recent), or null on first run. The
   *  dreamer reads it, folds the new window in, and writes it back — so the KB page is a pure render of
   *  this state and even survives a page delete. */
  dreamingState(): Record<string, unknown> | null {
    const raw = this.getRow(DREAMING_STATE_KEY)?.value;
    if (!raw) return null;
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  }
  setDreamingState(state: Record<string, unknown>, by?: string): void {
    this.set(DREAMING_STATE_KEY, JSON.stringify(state), by);
  }

  // ── learned guidance (the closed loop) ───────────────────────────────────────────
  // The Dreamer distils its cumulative learnings into a few actionable imperatives, stored here and
  // injected into every claude-code agent's system prompt at launch (so the fleet's experience shapes
  // future behavior). Visible + toggleable — it's prompting, not auto-rewriting policy/budgets.

  /** The distilled guidance block injected into every agent's prompt; '' when none yet. */
  learnedGuidance(): string {
    return this.getRow(LEARNED_GUIDANCE_KEY)?.value ?? '';
  }
  setLearnedGuidance(text: string, by?: string): void {
    this.set(LEARNED_GUIDANCE_KEY, text, by);
  }
  /** Whether learned guidance is injected into agent prompts. Default true (off only if explicitly set). */
  applyLearnings(): boolean {
    return this.getRow(LEARNED_APPLY_KEY)?.value !== 'off';
  }
  setApplyLearnings(on: boolean, by?: string): void {
    this.set(LEARNED_APPLY_KEY, on ? 'on' : 'off', by);
  }

  /** Open config recommendations + dismissed ids. The dreamer regenerates `open` each pass (minus the
   *  dismissed); a human Applies or Dismisses each — nothing auto-applies. */
  recommendations(): { open: Recommendation[]; dismissed: string[] } {
    const raw = this.getRow(RECOMMENDATIONS_KEY)?.value;
    if (!raw) return { open: [], dismissed: [] };
    try {
      const v = JSON.parse(raw) as { open?: Recommendation[]; dismissed?: string[] };
      return { open: v.open ?? [], dismissed: v.dismissed ?? [] };
    } catch {
      return { open: [], dismissed: [] };
    }
  }
  setRecommendations(value: { open: Recommendation[]; dismissed: string[] }, by?: string): void {
    this.set(RECOMMENDATIONS_KEY, JSON.stringify(value), by);
  }

  // ── governance thresholds ────────────────────────────────────────────────────────
  // Numeric caps the never-tier policy rules reference by name ($moneyCapUsd / $bulkDeleteCount).
  // Kept here (not hard-coded in the policy JSON) so an owner can retune the caps live without
  // editing rules; the policy engine resolves them at classify time. Unset → DEFAULT_*.

  /** The live governance caps, merged over the defaults so a partial save can't drop a field. */
  governanceThresholds(): GovernanceThresholds {
    const raw = this.getRow(GOVERNANCE_KEY)?.value;
    if (!raw) return { ...DEFAULT_GOVERNANCE_THRESHOLDS };
    try {
      const v = JSON.parse(raw) as Partial<GovernanceThresholds>;
      return {
        moneyCapUsd: Number.isFinite(v.moneyCapUsd) ? Number(v.moneyCapUsd) : DEFAULT_GOVERNANCE_THRESHOLDS.moneyCapUsd,
        bulkDeleteCount: Number.isFinite(v.bulkDeleteCount) ? Number(v.bulkDeleteCount) : DEFAULT_GOVERNANCE_THRESHOLDS.bulkDeleteCount,
        emailBulkCap: Number.isFinite(v.emailBulkCap) ? Number(v.emailBulkCap) : DEFAULT_GOVERNANCE_THRESHOLDS.emailBulkCap,
      };
    } catch {
      return { ...DEFAULT_GOVERNANCE_THRESHOLDS };
    }
  }

  governanceMeta(): { updatedAt?: number; updatedBy?: string } {
    const row = this.getRow(GOVERNANCE_KEY);
    return { updatedAt: row?.updated_at, updatedBy: row?.updated_by ?? undefined };
  }

  /** Persist new caps (clamped to non-negative integers) and return the resolved set. */
  setGovernanceThresholds(t: Partial<GovernanceThresholds>, by?: string): GovernanceThresholds {
    const cur = this.governanceThresholds();
    const clamp = (n: unknown, fallback: number) => {
      const v = Number(n);
      return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
    };
    const next: GovernanceThresholds = {
      moneyCapUsd: clamp(t.moneyCapUsd, cur.moneyCapUsd),
      bulkDeleteCount: clamp(t.bulkDeleteCount, cur.bulkDeleteCount),
      emailBulkCap: clamp(t.emailBulkCap, cur.emailBulkCap),
    };
    this.set(GOVERNANCE_KEY, JSON.stringify(next), by);
    return next;
  }

  // ── email org domains (internal recipients for the email.send policy tier) ───────
  // The workspace's own email domains. An `email.send` to one of these classifies internal (green);
  // anything else is external (yellow — needs approval). Explicit config wins; when unset the gate
  // derives a sensible default from members' own (non-public) email domains. `@` and case ignored.

  /** The configured internal domains (may be empty → the gate falls back to member-derived domains). */
  emailOrgDomains(): string[] {
    const raw = this.getRow(EMAIL_ORG_DOMAINS_KEY)?.value;
    if (!raw) return [];
    try {
      const v = JSON.parse(raw) as unknown;
      return Array.isArray(v) ? this.normalizeDomains(v.map(String)) : [];
    } catch {
      return [];
    }
  }

  emailOrgDomainsMeta(): { updatedAt?: number; updatedBy?: string } {
    const row = this.getRow(EMAIL_ORG_DOMAINS_KEY);
    return { updatedAt: row?.updated_at, updatedBy: row?.updated_by ?? undefined };
  }

  /** Persist the internal-domain list (deduped, lowercased, `@`/whitespace stripped). */
  setEmailOrgDomains(domains: string[], by?: string): string[] {
    const clean = this.normalizeDomains(domains);
    this.set(EMAIL_ORG_DOMAINS_KEY, JSON.stringify(clean), by);
    return clean;
  }

  private normalizeDomains(domains: string[]): string[] {
    return [...new Set(domains.map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  }

  // ── chat router (generic Slack/Discord front door) ───────────────────────────────
  // When ON (default), a Slack/Discord message that matches NO automation falls back to the generic
  // `/agent` router: the sender addresses any claude-code agent by name; an unaddressed/unknown name
  // gets a help list. Lets the whole fleet be reachable without a per-agent automation.

  /** Whether the generic `/agent` chat router handles unmatched Slack/Discord messages (default true). */
  chatRouterEnabled(): boolean {
    return this.getRow(CHAT_ROUTER_KEY)?.value !== 'off';
  }

  setChatRouterEnabled(on: boolean, by?: string): boolean {
    this.set(CHAT_ROUTER_KEY, on ? 'on' : 'off', by);
    return this.chatRouterEnabled();
  }

  // ── kill switch (workspace emergency stop) ───────────────────────────────────────
  // A single boolean that, when engaged, makes the gate deny EVERY action across the whole workspace
  // (governance-model.md — the operational control we lacked). Reversible: clear it and agents resume.

  /** Current emergency-stop state (defaults to disengaged). */
  killSwitch(): KillSwitchState {
    const row = this.getRow(KILL_SWITCH_KEY);
    if (!row?.value) return { engaged: false };
    try {
      const v = JSON.parse(row.value) as { engaged?: boolean; reason?: string };
      return { engaged: !!v.engaged, reason: v.reason, updatedAt: row.updated_at, updatedBy: row.updated_by ?? undefined };
    } catch {
      return { engaged: false, updatedAt: row.updated_at, updatedBy: row.updated_by ?? undefined };
    }
  }

  /** Engage or release the emergency stop. */
  setKillSwitch(engaged: boolean, reason: string | undefined, by?: string): KillSwitchState {
    this.set(KILL_SWITCH_KEY, JSON.stringify({ engaged: !!engaged, reason: reason?.trim() || undefined }), by);
    return this.killSwitch();
  }

}
