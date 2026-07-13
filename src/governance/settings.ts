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
import { Branding, EnrichPattern, MemoryConfig, Recommendation, RuntimeTuning, sanitizeBranding, sanitizeRuntimeTuning } from '../types';

const COMPANY_KEY = 'company_md';
const COMPOSIO_KEY = 'composio_api_key';
const COMPOSIO_WEBHOOK_KEY = 'composio_webhook_secret';
const SLACK_APP_TOKEN_KEY = 'slack_app_token'; // xapp-… (Socket Mode, connections:write)
const SLACK_BOT_TOKEN_KEY = 'slack_bot_token'; // xoxb-… (chat.postMessage, users.info)
const DISCORD_BOT_TOKEN_KEY = 'discord_bot_token'; // Bot … (Gateway connect + post messages)
const IMAGE_OPENROUTER_KEY = 'image_openrouter_key'; // OpenRouter Unified Image API key (default backend)
const IMAGE_ATLAS_KEY = 'image_atlas_key'; // Atlas Cloud key (alt backend; covers video later)
const IMAGE_MODEL_KEY = 'image_default_model'; // workspace default image model id (backend-specific); '' = adapter default
const VIDEO_FAL_KEY = 'video_fal_key'; // fal.ai key (default video backend; queue API)
const VIDEO_MODEL_KEY = 'video_default_model'; // workspace default video model id (backend-specific); '' = adapter default
const MEMORY_KEY = 'memory_config'; // the live memory backend (JSON MemoryConfig; overrides the file default)
const MEMORY_SWITCH_KEY = 'memory_backend_switched_at'; // ts the active external backend became active — the stable orphan horizon for migration
const RUNTIME_DEFAULTS_KEY = 'runtime_defaults'; // workspace-wide model/effort/permission fallback (JSON RuntimeTuning)
const DREAMING_KEY = 'dreaming_every_hours'; // self-learning cadence in hours; 0/unset = off
const GOALS_INJECT_KEY = 'goals_inject'; // whether active goals ride in every agent's prompt (default on)
const GOALS_AUTOPLAN_KEY = 'goals_autoplan'; // whether the scheduler auto-plans stuck goals (default OFF — opt-in)
const DREAMING_STATE_KEY = 'dreaming_state'; // compounding self-learning state (cumulative totals/topics/recent)
const LEARNED_GUIDANCE_KEY = 'learned_guidance'; // distilled imperatives injected into every agent's prompt
const LEARNED_APPLY_KEY = 'learned_guidance_apply'; // 'off' to stop injecting (default on once guidance exists)
const RECOMMENDATIONS_KEY = 'learned_recommendations'; // { open: Recommendation[], dismissed: string[] }
const GOVERNANCE_KEY = 'governance_thresholds'; // numeric caps the never-tier policy rules read (JSON GovernanceThresholds)
const HOST_GOV_KEY = 'host_governance_enabled'; // master switch for Phase 2b host-egress governance ('1'|'0')
const ENRICH_PATTERNS_KEY = 'enrich_patterns'; // operator regex→boolean-fact rules the enricher applies (JSON EnrichPattern[])
const BRANDING_KEY = 'ui_branding'; // per-tenant web-console accent colour + favicon badge (JSON Branding)

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
const CHAT_IDLE_MIN_KEY = 'chat_idle_timeout_min'; // resident (warm) chat session idle-kill, minutes
const KILL_SWITCH_KEY = 'kill_switch'; // workspace-wide emergency stop (JSON KillSwitchState)
const SUPPRESSED_BUILTINS_KEY = 'suppressed_builtins'; // built-in agent ids an admin deleted (JSON string[]); boot won't re-seed them

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

  // ── image generation ─────────────────────────────────────────────────────────────
  // Keys for the `image_generate` capability's backend. OpenRouter (default) reports the real per-
  // request cost in-band; Atlas is the alternative (and the future video lane). Either key present
  // ⇒ the tool is offered to sessions. Backend selection lives in resolveImageBackend (edge/image-gen).

  /** OpenRouter Unified Image API key, or '' when unset. */
  openRouterKey(): string {
    return this.getRow(IMAGE_OPENROUTER_KEY)?.value?.trim() ?? '';
  }
  /** Atlas Cloud key, or '' when unset. */
  atlasKey(): string {
    return this.getRow(IMAGE_ATLAS_KEY)?.value?.trim() ?? '';
  }
  /** Workspace default image model id (backend-specific), or '' to use the adapter's own default. */
  imageDefaultModel(): string {
    return this.getRow(IMAGE_MODEL_KEY)?.value?.trim() ?? '';
  }
  /** At least one backend key present → the tool is exposed. */
  imageGenConfigured(): boolean {
    return !!this.openRouterKey() || !!this.atlasKey();
  }
  /** Which backend a run would use (Atlas is primary when set; else OpenRouter) — for the console + status. */
  imageGenBackend(): 'openrouter' | 'atlas' | null {
    if (this.atlasKey()) return 'atlas';
    if (this.openRouterKey()) return 'openrouter';
    return null;
  }
  /** Whether each image key is set (never returns the secret) + the default model + last editor. */
  imageGenMeta(): { openRouter: boolean; atlas: boolean; backend: 'openrouter' | 'atlas' | null; defaultModel: string; updatedAt?: number; updatedBy?: string } {
    const or = this.getRow(IMAGE_OPENROUTER_KEY);
    const at = this.getRow(IMAGE_ATLAS_KEY);
    const newest = [or, at].filter(Boolean).sort((a, b) => (b!.updated_at ?? 0) - (a!.updated_at ?? 0))[0];
    return {
      openRouter: !!or?.value,
      atlas: !!at?.value,
      backend: this.imageGenBackend(),
      defaultModel: this.imageDefaultModel(),
      updatedAt: newest?.updated_at ?? undefined,
      updatedBy: newest?.updated_by ?? undefined,
    };
  }
  setOpenRouterKey(key: string, by?: string): void {
    this.set(IMAGE_OPENROUTER_KEY, key.trim(), by);
  }
  setAtlasKey(key: string, by?: string): void {
    this.set(IMAGE_ATLAS_KEY, key.trim(), by);
  }
  setImageDefaultModel(model: string, by?: string): void {
    this.set(IMAGE_MODEL_KEY, model.trim(), by);
  }

  // ── video generation ─────────────────────────────────────────────────────────────
  // fal.ai is the default video backend (verified queue contract + catalog); Atlas (the shared image
  // key) is the alternative. Either present ⇒ the `video_generate` tool is offered. OpenRouter does NOT
  // do video, so image being configured doesn't imply video is.

  /** fal.ai API key, or '' when unset. */
  falKey(): string {
    return this.getRow(VIDEO_FAL_KEY)?.value?.trim() ?? '';
  }
  /** Workspace default video model id (backend-specific), or '' to use the adapter's own default. */
  videoDefaultModel(): string {
    return this.getRow(VIDEO_MODEL_KEY)?.value?.trim() ?? '';
  }
  /** A video-capable backend key present (fal, or the shared Atlas key) → the tool is exposed. */
  videoGenConfigured(): boolean {
    return !!this.falKey() || !!this.atlasKey();
  }
  /** Which backend a video run would use (fal wins when both set). */
  videoGenBackend(): 'fal' | 'atlas' | null {
    if (this.falKey()) return 'fal';
    if (this.atlasKey()) return 'atlas';
    return null;
  }
  /** Whether each video key is set (never the secret) + the default model + last editor. */
  videoGenMeta(): { fal: boolean; atlas: boolean; backend: 'fal' | 'atlas' | null; defaultModel: string; updatedAt?: number; updatedBy?: string } {
    const fal = this.getRow(VIDEO_FAL_KEY);
    const at = this.getRow(IMAGE_ATLAS_KEY);
    const newest = [fal, at].filter(Boolean).sort((a, b) => (b!.updated_at ?? 0) - (a!.updated_at ?? 0))[0];
    return {
      fal: !!fal?.value,
      atlas: !!at?.value,
      backend: this.videoGenBackend(),
      defaultModel: this.videoDefaultModel(),
      updatedAt: newest?.updated_at ?? undefined,
      updatedBy: newest?.updated_by ?? undefined,
    };
  }
  setFalKey(key: string, by?: string): void {
    this.set(VIDEO_FAL_KEY, key.trim(), by);
  }
  setVideoDefaultModel(model: string, by?: string): void {
    this.set(VIDEO_MODEL_KEY, model.trim(), by);
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

  /** The timestamp the active external backend became active (set only on a real backend TYPE switch — not
   *  a token/ranking re-save). The stable horizon for identifying "orphan" local rows the migration must
   *  copy up: rows written BEFORE this are from the previous backend and aren't in the current one.
   *  `undefined` → no switch on record (treat the ledger as already consistent). */
  memorySwitchedAt(): number | undefined {
    const n = Number(this.getRow(MEMORY_SWITCH_KEY)?.value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  stampMemorySwitch(ts: number, by?: string): void {
    this.set(MEMORY_SWITCH_KEY, String(ts), by);
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

  // ── UI branding ──────────────────────────────────────────────────────────────────
  // Per-tenant accent colour + favicon badge for the web console, so several tenants running side by
  // side are distinguishable at a glance. Display-only (no secrets) → served unauthenticated via
  // GET /api/branding so the client themes itself even before login. Empty/missing → default look.

  /** The stored branding (accent colour + badge), or `{}` when none saved. */
  branding(): Branding {
    const raw = this.getRow(BRANDING_KEY)?.value;
    if (!raw) return {};
    try {
      return sanitizeBranding(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return {};
    }
  }

  /** Who last changed the branding. */
  brandingMeta(): { updatedAt?: number; updatedBy?: string } {
    const row = this.getRow(BRANDING_KEY);
    return { updatedAt: row?.updated_at, updatedBy: row?.updated_by ?? undefined };
  }

  setBranding(b: Branding, by?: string): Branding {
    this.set(BRANDING_KEY, JSON.stringify(sanitizeBranding(b)), by);
    return this.branding();
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

  /** Whether the active goals ride in every agent's prompt (the "direction" channel). Default true. */
  injectGoals(): boolean {
    return this.getRow(GOALS_INJECT_KEY)?.value !== 'off';
  }
  setInjectGoals(on: boolean, by?: string): void {
    this.set(GOALS_INJECT_KEY, on ? 'on' : 'off', by);
  }
  /** Whether the scheduler auto-plans "stuck" active goals via the strategist. Default OFF (opt-in —
   *  it spawns governed agent sessions, which cost money). */
  autoPlanGoals(): boolean {
    return this.getRow(GOALS_AUTOPLAN_KEY)?.value === 'on';
  }
  setAutoPlanGoals(on: boolean, by?: string): void {
    this.set(GOALS_AUTOPLAN_KEY, on ? 'on' : 'off', by);
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

  // ── host-egress governance master switch (Phase 2b — docs/host-connections-plan.md) ──
  // OFF by default: registering hosts (Phase 2a) is inert until an admin flips this on, so the new
  // gate behaviour (parsing ssh/curl targets, reclassifying to net.connect/ssh.exec) can bake safely.
  hostGovernanceEnabled(): boolean {
    return this.getRow(HOST_GOV_KEY)?.value === '1';
  }

  setHostGovernanceEnabled(on: boolean, by?: string): boolean {
    this.set(HOST_GOV_KEY, on ? '1' : '0', by);
    return on;
  }

  // ── custom governance patterns (operator regex → boolean fact the enricher sets) ──
  // The extension seam that keeps the enricher generic: a workspace declares its OWN dangerous ops as
  // DATA here (a prod-deploy path, a suspend-user CLI), the enricher sets the fact, and policy gates on
  // it — no brand code in `enricher.ts`. Read on every classify (hot; no restart).
  enrichPatterns(): EnrichPattern[] {
    const raw = this.getRow(ENRICH_PATTERNS_KEY)?.value;
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      if (!Array.isArray(v)) return [];
      return v
        .filter((p) => p && typeof p.pattern === 'string' && typeof p.fact === 'string' && p.fact.trim())
        .map((p) => ({
          pattern: String(p.pattern),
          fact: String(p.fact).trim(),
          scope: ['shell', 'connector', 'any'].includes(p.scope) ? p.scope : 'any',
        }));
    } catch {
      return [];
    }
  }

  /** Replace the custom patterns. Rejects an invalid regex so a bad rule can't silently no-op. */
  setEnrichPatterns(patterns: EnrichPattern[], by?: string): EnrichPattern[] {
    const clean: EnrichPattern[] = [];
    for (const p of Array.isArray(patterns) ? patterns : []) {
      if (!p || typeof p.pattern !== 'string' || !p.pattern.trim() || typeof p.fact !== 'string' || !p.fact.trim()) continue;
      try {
        new RegExp(p.pattern, 'i');
      } catch {
        throw new Error(`invalid regex: ${p.pattern}`);
      }
      const scope = ['shell', 'connector', 'any'].includes(p.scope as string) ? (p.scope as EnrichPattern['scope']) : 'any';
      clean.push({ pattern: String(p.pattern), fact: String(p.fact).trim(), scope });
    }
    this.set(ENRICH_PATTERNS_KEY, JSON.stringify(clean), by);
    return clean;
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

  /** How long a resident (warm) Slack/Discord thread session is kept alive after its last turn before
   *  the idle reaper kills it. Default 30 min; clamped to a sane 1 min–24 h. 0 disables residence
   *  (every reply cold-starts) — an escape hatch, not the default. */
  chatIdleTimeoutMinutes(): number {
    const n = Number(this.getRow(CHAT_IDLE_MIN_KEY)?.value);
    if (!Number.isFinite(n)) return 30; // unset → default
    if (n <= 0) return 0;               // explicit 0 → residence off
    return Math.min(Math.max(Math.round(n), 1), 24 * 60);
  }

  setChatIdleTimeoutMinutes(minutes: number, by?: string): number {
    const n = Number(minutes);
    const clamped = !Number.isFinite(n) || n < 0 ? 30 : n === 0 ? 0 : Math.min(Math.max(Math.round(n), 1), 24 * 60);
    this.set(CHAT_IDLE_MIN_KEY, String(clamped), by);
    return this.chatIdleTimeoutMinutes();
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

  // ── suppressed built-in agents (durable removal tombstone) ───────────────────────
  // A built-in agent is seeded from the catalog into the data home on boot, so deleting its folder
  // isn't durable — the next boot restores it. When an admin deletes one we record its id here as a
  // tombstone; `seedBuiltinAgents` skips any id on this list, so the removal sticks. Re-installing the
  // agent from the library clears the tombstone.

  /** The built-in agent ids an admin has deleted (so boot won't re-seed them). */
  suppressedBuiltins(): string[] {
    const raw = this.getRow(SUPPRESSED_BUILTINS_KEY)?.value;
    if (!raw) return [];
    try {
      const v = JSON.parse(raw) as unknown;
      return Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))] : [];
    } catch {
      return [];
    }
  }

  /** Tombstone a built-in id so boot won't re-seed it. Idempotent. */
  suppressBuiltin(id: string, by?: string): string[] {
    const next = [...new Set([...this.suppressedBuiltins(), id])];
    this.set(SUPPRESSED_BUILTINS_KEY, JSON.stringify(next), by);
    return next;
  }

  /** Clear a built-in's tombstone (e.g. on re-install), so boot seeds it again. Idempotent. */
  unsuppressBuiltin(id: string, by?: string): string[] {
    const next = this.suppressedBuiltins().filter((x) => x !== id);
    this.set(SUPPRESSED_BUILTINS_KEY, JSON.stringify(next), by);
    return next;
  }

}
