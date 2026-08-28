/**
 * Setup wizard status — "what still has to be configured before this install is useful?"
 *
 * A fresh `agent-os serve` boots into a console that WORKS but can do nothing interesting: no company
 * context (so every agent runs context-free), possibly no runtime credential (so a session hangs on a
 * login picker), no Composio key (so no connectors), no chat channel, no GitHub App (so every push is
 * authored by whatever credential the box carries), keyword-only memory, no teammates, one seeded agent.
 * Every one of those is already settable somewhere in Settings — the problem is that a new operator has
 * no idea WHICH of them matter or in what order, and nothing tells them when they're done.
 *
 * So this module is deliberately a READ-SIDE roll-up: it writes nothing and owns no new configuration.
 * Each step reports whether it is already satisfied by reading the same stores the Settings pages write,
 * and the wizard UI drives the EXISTING endpoints to fix it. That keeps one source of truth per setting
 * (a step can never disagree with the page that owns it) and means the wizard stays correct when a step
 * is completed some other way — by CLI, by another admin, or by a config file on the box.
 *
 * The one piece of state it does own is `setup_state` (dismissed / per-step "skip"), because "I know,
 * I don't want Slack" is not derivable from any store.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AgentOS } from '../kernel.js';
import { GithubIdentity } from './github-identity.js';

/** Steps, in the order the wizard walks them. Order is the recommendation: credentials first (nothing
 *  runs without them), then context (every run is worse without it), then reach (connectors, chat,
 *  GitHub), then memory (how much of a run survives it), then the people and the fleet. */
export const SETUP_STEP_IDS = ['claude', 'company', 'composio', 'chat', 'github', 'memory', 'team', 'agents'] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

export interface SetupStep {
  id: SetupStepId;
  title: string;
  /** One line on why this matters — shown under the title, not buried in docs. */
  why: string;
  /** `required` steps gate "setup complete"; the rest are recommendations. */
  required: boolean;
  /** `done` = satisfied · `todo` = not configured · `unknown` = can't be proven from here (see detail). */
  status: 'done' | 'todo' | 'unknown';
  /** The evidence behind the status ("2 accounts in the pool", "no key set") — never a secret. */
  detail: string;
  /** The operator said "not now" for this step; it stops blocking the banner. */
  skipped: boolean;
}

export interface SetupStatus {
  steps: SetupStep[];
  /** Steps satisfied (skipped ones do NOT count as done — they count as decided). */
  done: number;
  total: number;
  /** Required steps neither done nor skipped — while >0 the console nags. */
  blocking: number;
  /** Nothing left to decide: every step is done or skipped. */
  complete: boolean;
  /** The operator closed the wizard (epoch ms) — the banner stays quiet even with steps left. */
  dismissedAt: number | null;
  /** Whether the box can drive a runtime sign-in itself (false under uid isolation / missing binary). */
  guidedLogin: boolean;
  /** Why guided login is unavailable, when it is. */
  guidedLoginWhy?: string;
}

/** Mark a step "not now" (or un-skip it). Skipping is a decision, not a completion — the step keeps
 *  reporting its real status, it just stops holding the install back. */
export function skipSetupStep(agentOs: AgentOS, step: SetupStepId, skip: boolean, by?: string): void {
  const cur = agentOs.settings.setupState();
  const set = new Set(cur.skipped);
  if (skip) set.add(step); else set.delete(step);
  agentOs.settings.setSetupState({ ...cur, skipped: [...set] }, by);
}

/** Close the wizard. `dismissed: false` re-opens it (the "run setup again" path from Settings), which
 *  matters because an install that grows a team later wants the checklist back. */
export function dismissSetup(agentOs: AgentOS, dismissed: boolean, by?: string): void {
  const cur = agentOs.settings.setupState();
  const next: { dismissedAt?: number; skipped: string[] } = { skipped: cur.skipped };
  if (dismissed) next.dismissedAt = Date.now();
  agentOs.settings.setSetupState(next, by);
}

/**
 * Can a session actually authenticate a Claude runtime on this box?
 *
 * Deliberately best-effort, and it says so: there is no cheap probe that proves a launch will
 * authenticate, and guessing "not configured" on a box that IS logged in would send the operator
 * through a pointless sign-in. Four sources, in the order the launcher would use them:
 *   1. the rotation pool (an enabled credential-dir account) — the only one the console fully owns,
 *   2. the box's own `~/.claude/.credentials.json`,
 *   3. the macOS Keychain, where `claude login` stores credentials instead of a file (so a Mac that is
 *      signed in has NO credentials file — reporting "todo" off the file check alone is wrong there),
 *   4. `ANTHROPIC_API_KEY` in the server's environment.
 * Nothing found → `todo`, which is the honest answer: no evidence of a credential anywhere.
 */
export function claudeAuthEvidence(
  agentOs: AgentOS,
  /** Seams for tests: a maintainer's Mac IS signed in, so without these the "no credential" branch is
   *  unassertable there and would only ever be exercised in CI. */
  probes: { configDir?: string; keychain?: () => boolean } = {},
): { status: 'done' | 'todo' | 'unknown'; detail: string } {
  const pool = agentOs.runtimeAccounts.list().filter((a) => a.runtime === 'claude-code' && a.enabled && a.kind === 'oauth' && a.checkOk !== false);
  if (pool.length) return { status: 'done', detail: `${pool.length} account${pool.length === 1 ? '' : 's'} in the rotation pool (${pool.map((a) => a.name).join(', ')})` };

  const boxCreds = path.join(probes.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  if (fs.existsSync(boxCreds)) return { status: 'done', detail: `this box is signed in (${boxCreds})` };

  const keychain = probes.keychain ?? (() => process.platform === 'darwin' && keychainHasClaude());
  if (keychain()) {
    return { status: 'done', detail: 'this box is signed in (macOS Keychain — “Claude Code-credentials”)' };
  }

  if ((process.env.ANTHROPIC_API_KEY || '').trim()) {
    return { status: 'unknown', detail: 'ANTHROPIC_API_KEY is set in the server environment — usage-billed, and the interactive TUI may still ask for a subscription login' };
  }

  return { status: 'todo', detail: 'no credential found — sessions will hang on the runtime’s login screen' };
}

/** `security find-generic-password -s "Claude Code-credentials"` — presence only, never the value.
 *  Short timeout: this runs inside a console request, and a locked keychain can block on a prompt. */
function keychainHasClaude(): boolean {
  try {
    const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'] });
    return r.status === 0;
  } catch { return false; }
}

/**
 * GitHub: is there an App this workspace can act through?
 *
 * Two independent halves, and a workspace usefully has either:
 *   • the OAuth pair (client id + secret) — lets each MEMBER link their own account, so a run-as session
 *     commits and opens PRs as the actual human (`injectMemberGithub`);
 *   • the App credentials (App id + private key) — mint installation tokens so the company BOT can push
 *     on every installed repo when the run-as human hasn't linked (or there is none).
 * Neither present → the box's ambient git credential is whatever happens to be lying around, which is
 * how "the bot authored it" and "git push: permission denied" both happen.
 */
export function githubEvidence(agentOs: AgentOS): { status: 'done' | 'todo'; detail: string } {
  const gh = new GithubIdentity(agentOs);
  const oauth = gh.configured();
  const bot = gh.botConfigured();
  if (!oauth && !bot) return { status: 'todo', detail: 'no GitHub App — agents push with whatever credential the box happens to have' };
  const slug = gh.appSlug();
  const parts = [
    oauth ? 'per-member sign-in ready' : 'no OAuth pair — members cannot link their own account',
    bot ? 'company-bot token available' : 'no bot fallback — a session with no linked human cannot push',
  ];
  return { status: 'done', detail: `${slug ? `App “${slug}”` : 'App credentials set'} · ${parts.join(' · ')}` };
}

/**
 * Memory: can agents recall anything they didn't just do?
 *
 * The default sqlite backend is keyword-only (FTS5 bm25) — it finds a memory when the words match and
 * misses it when they don't, which is most of the time. So this step is satisfied by either upgrade:
 * add an embedder to sqlite (hybrid keyword + cosine, one API key, zero new services), or point the
 * plane at a real vector store (automem — graph + vectors, and the one we recommend — or libSQL).
 * Read from the SAME setting Settings → Memory writes; a config-file default is deliberately not
 * counted, because the wizard's job is to get the DB layer configured.
 */
export function memoryEvidence(agentOs: AgentOS): { status: 'done' | 'todo'; detail: string } {
  const cfg = agentOs.settings.memoryConfig();
  const backend = cfg?.backend ?? 'sqlite';
  if (backend === 'automem') {
    const ep = cfg?.automem?.endpoint ?? '';
    return ep
      ? { status: 'done', detail: `AutoMem at ${hostOf(ep)} — graph + vector recall` }
      : { status: 'todo', detail: 'AutoMem selected but no endpoint set — recall falls back to keywords' };
  }
  if (backend === 'libsql') {
    const emb = cfg?.libsql?.embeddings;
    return { status: 'done', detail: emb ? `libSQL vectors + ${emb.provider} embeddings (${emb.model})` : 'libSQL store — lexical only, no embedder set' };
  }
  const emb = cfg?.sqlite?.embeddings;
  if (emb?.url && emb?.model) return { status: 'done', detail: `hybrid recall — sqlite + ${emb.provider} embeddings (${emb.model})` };
  return { status: 'todo', detail: 'keyword-only recall — an agent misses its own past work whenever it words it differently' };
}

/** Host of a URL for display, or the raw string when it isn't parseable. Never shows a token. */
function hostOf(u: string): string {
  try { return new URL(u).host; } catch { return u; }
}

export interface SetupInputs {
  /** Agents in the fleet, excluding the ones every install is seeded with — a seeded `agent-author`
   *  is not evidence that anybody built a team. */
  ownAgents: number;
  /** Whether `RuntimeLoginManager.supported('claude-code')` says the console can drive a sign-in here. */
  guidedLogin: { ok: boolean; why?: string };
  /** Credential-probe seams, forwarded to `claudeAuthEvidence` (tests only — see there). */
  probes?: { configDir?: string; keychain?: () => boolean };
}

export function buildSetupStatus(agentOs: AgentOS, inputs: SetupInputs): SetupStatus {
  const state = agentOs.settings.setupState();
  const skipped = new Set(state.skipped);

  const company = agentOs.settings.company().companyMd.trim();
  const composio = agentOs.settings.composioMeta();
  const slack = agentOs.settings.slackConfigured();
  const discord = agentOs.settings.discordConfigured();
  const telegram = agentOs.settings.telegramConfigured();
  const members = agentOs.team.listMembers();
  const claude = claudeAuthEvidence(agentOs, inputs.probes);
  const github = githubEvidence(agentOs);
  const memory = memoryEvidence(agentOs);

  const chatOn = [slack && 'Slack', discord && 'Discord', telegram && 'Telegram'].filter(Boolean) as string[];

  const steps: SetupStep[] = [
    {
      id: 'claude',
      title: 'Connect a coding runtime',
      why: 'Agents are Claude Code / Codex sessions. Without a credential a spawned session sits on the login screen and never runs.',
      required: true,
      status: claude.status,
      detail: claude.detail,
      skipped: skipped.has('claude'),
    },
    {
      id: 'company',
      title: 'Describe your company',
      why: 'This text is appended to every agent’s system prompt. It is the difference between an agent that knows your product, stack and customers and one that guesses.',
      required: true,
      status: company ? 'done' : 'todo',
      detail: company ? `${company.length.toLocaleString()} characters set` : 'not set — every agent runs without context about who you are',
      skipped: skipped.has('company'),
    },
    {
      id: 'composio',
      title: 'Add a Composio API key',
      why: 'Composio is the hosted OAuth layer behind ~1000 app connectors (Gmail, Slack, Notion, Linear…). One workspace key, then each member connects their own accounts.',
      required: false,
      status: composio.set ? 'done' : 'todo',
      detail: composio.set ? 'key set' : 'no key — connectors are limited to self-hosted MCP servers',
      skipped: skipped.has('composio'),
    },
    {
      id: 'chat',
      title: 'Connect a chat channel',
      why: 'Slack / Discord / Telegram is how people reach the fleet without opening the console — and how approvals and questions reach a human.',
      required: false,
      status: chatOn.length ? 'done' : 'todo',
      detail: chatOn.length ? `${chatOn.join(' + ')} connected` : 'none connected — the console is the only way in',
      skipped: skipped.has('chat'),
    },
    {
      id: 'github',
      title: 'Connect GitHub',
      why: 'Coding agents live on git. The App lets each member link their own account — so a PR is authored by the human the run acts as — and gives every other session a company-bot token to push with.',
      required: false,
      status: github.status,
      detail: github.detail,
      skipped: skipped.has('github'),
    },
    {
      id: 'memory',
      title: 'Set up the memory layer',
      why: 'Out of the box recall is keyword-only, so agents re-learn the same things forever. Add an OpenAI key for hybrid recall on the built-in store, or point it at AutoMem for real graph + vector memory.',
      required: false,
      status: memory.status,
      detail: memory.detail,
      skipped: skipped.has('memory'),
    },
    {
      id: 'team',
      title: 'Invite your team',
      why: 'Roles decide who can approve what. An owner alone means every approval waits on you.',
      required: false,
      status: members.length > 1 ? 'done' : 'todo',
      detail: members.length > 1 ? `${members.length} members` : 'you are the only member',
      skipped: skipped.has('team'),
    },
    {
      id: 'agents',
      title: 'Add your first agent',
      why: 'Install one from the catalog or have the agent-author build one for your workflow.',
      required: true,
      status: inputs.ownAgents > 0 ? 'done' : 'todo',
      detail: inputs.ownAgents > 0 ? `${inputs.ownAgents} agent${inputs.ownAgents === 1 ? '' : 's'} in the fleet` : 'only the built-in agents are installed',
      skipped: skipped.has('agents'),
    },
  ];

  // `unknown` counts as satisfied for progress: it means "there is evidence of a credential, we just
  // can't prove the launch path" — nagging about it forever would train people to ignore the banner.
  const isSettled = (s: SetupStep) => s.status === 'done' || s.status === 'unknown' || s.skipped;
  const done = steps.filter((s) => s.status === 'done' || s.status === 'unknown').length;
  const blocking = steps.filter((s) => s.required && !isSettled(s)).length;

  return {
    steps,
    done,
    total: steps.length,
    blocking,
    complete: steps.every(isSettled),
    dismissedAt: state.dismissedAt ?? null,
    guidedLogin: inputs.guidedLogin.ok,
    guidedLoginWhy: inputs.guidedLogin.why,
  };
}
