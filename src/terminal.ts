/**
 * Terminal-native sessions. Each agent session is a real tmux shell on the box (attachable
 * in the browser via ttyd). Every side effect the session takes is routed through the SAME
 * Agent OS gateway as the console — so even a raw shell can't act on anything risky without
 * a human approving it in the inbox.
 *
 * Governance over a real terminal = the agent-runner / Claude PreToolUse hook calls
 * POST /api/gate before each effect; risky ones become inbox approval cards and BLOCK.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AgentOS } from './kernel';
import { Db } from './state/db';
import { containedPath, mimeOf } from './state/artifacts';
import { mintToolRouterSession, COMPOSIO_KEY_HEADER, serviceUserId } from './connectors/composio';
import { ActionAttempt, ApprovalLevel, AuditEvent, Decision, Member, RiskClass, Role, RunContext, canApprove, resolveRuntimeTuning, riskClassForLevel } from './types';
import { enrichArgs, autoClearsApproval } from './governance/enricher';
import { hostGovernanceDecision, stricterDecision } from './governance/host-match';
import { Audience, approvalAudience, resolveRecipients } from './governance/recipients';
import { ChatPlatform, chatLink, consolePage } from './governance/chat-links';
import { SkillSummary, CatalogSkill } from './governance/skills';
import { browseRepo, RemoteCatalog } from './governance/skill-registry';
import { claudeSupportsReloadSkills } from './edge/claude-cli';
import { DEFAULT_IMAGE_COST_USD, resolveImageBackend } from './edge/image-gen';
import { DEFAULT_VIDEO_COST_PER_SEC_USD, DEFAULT_VIDEO_DURATION_SEC, resolveVideoBackend, videoBackend, VideoBackend } from './edge/video-gen';
import { understandMedia } from './edge/media-understand';

// Video render tuning: a submitted job renders async. The in-call path polls briefly for the fast case;
// the tick poller finishes the rest, bounded by a TTL + a poll ceiling so a stuck render can't linger.
const VIDEO_MAX_DURATION_SEC = 60;         // clamp the requested clip length
const VIDEO_JOB_TTL_MS = 20 * 60_000;      // give up on a render after 20 minutes
const VIDEO_MAX_POLLS = 200;               // poll-attempt ceiling (belt-and-suspenders with the TTL)
const VIDEO_INCALL_POLLS = 3;              // brief in-call polls to catch a fast render before returning
const VIDEO_INCALL_POLL_MS = 10_000;       // …10s apart (~30s max block, within tool tolerance)
import { LauncherClient } from './edge/launcher';
import { parseSecretRef } from './edge/secrets';
import { GithubIdentity } from './edge/github-identity';
import { LauncherSessionBackend, LocalSessionBackend, SessionBackend, SpawnErrorSink } from './edge/session-backend';

/** OS-owned operating notes appended to every claude system prompt (after the user's Company context).
 *  Kept terse — it rides in every session's context. */
// Appended to every claude-code agent's system prompt (after the workspace Company context). This is
// the agent's orientation: it is otherwise a stock `claude` dropped into a folder, blind to the OS it
// runs inside. Keep it tight — it costs tokens on every session. Describe the environment and how to
// operate well in it; don't restate what the MCP tool descriptions already say.
export const AGENT_OS_OPERATING_NOTES = `# You are running inside Agent OS

You are an autonomous agent operating inside **Agent OS**, a governed runtime. You are not a chat
assistant in a sandbox — your actions can touch real systems (shells, connected apps, money), and the
OS mediates them. Operate accordingly.

## Governance — your actions are mediated
Every side effect you take (shell commands, connector/app calls) passes through a policy gateway before
it runs. An action may be **allowed**, **denied**, or **suspended for human approval**. So:
- A blocked or hanging action is usually **not an error** — it means a human must approve it first, and
  your request is waiting in their Inbox. Don't retry it in a loop or treat it as a hard failure; wait,
  or move on to unblocked work.
- Before non-trivial or risky work, use \`list_capabilities\` / \`policy_check\` to learn your boundaries
  up front, so you can plan around approvals instead of getting stopped mid-task.

## Memory — it persists across sessions, but you must use it
You have durable memory scoped to **you, this agent**, spanning all your past runs. It is NOT loaded
into this prompt — you must reach for it:
- \`recall\` **at the start of non-trivial work** to pull past decisions, fixes, and gotchas, so you
  don't re-derive facts or repeat mistakes a previous run already solved.
- \`remember\` at the **moments worth encoding** — when a result **surprised** you (it behaved
  differently than expected), when something took real **effort** to work out, when you made a
  **decision** future runs will reuse, or when you hit a **gotcha / constraint / root cause**. One
  self-contained fact per memory; skip routine steps and run-specific trivia — remembering everything
  is as useless as remembering nothing.

## Talking to the human — use the Inbox, not just the terminal
Your terminal output may not be read. The operator lives in the Inbox:
- \`ask\` when you're blocked on a judgement only the human can make — it waits for their reply. Prefer
  asking over guessing on anything risky or ambiguous.
- \`report\` exactly once when you finish, with the outcome and a one-line summary, so the result is
  visible without anyone reading the terminal. If the task taught you something durable, pass it in
  \`lessons\` — it's saved to your memory as a note to your future self.
- \`publish\` real deliverables (a document, PDF, image, chart) to the Library — not scratch
  files.

## You are one agent in a fleet — don't work alone
Other agents run in this workspace and you share state with them. You are a node, not a silo:
- **Tasks** (\`task_*\`) are the shared work queue and the hand-off path. If work belongs to a specialist
  agent or is too big for this run, \`task_create\` and assign it — an agent-assigned task spawns that
  agent as a governed run under the same accountable human. Prefer delegating specialised work over
  doing it poorly yourself; \`task_list\` / \`task_claim\` to pull shared work.
- **Knowledge Base** (\`kb_*\`) is the fleet's shared, living wiki. \`kb_search\` before assuming a fact
  isn't already written down; \`kb_write\` durable facts, runbooks, and conventions that help *other*
  agents and humans. (Memory is for facts only *you* reuse; the KB is for the whole fleet.)
- **Shared memory**: \`remember\` with \`shared: true\` publishes a fact fleet-wide instead of only to
  your own recall — use it for things the whole team should know.
- **Skills** (\`skill_propose\`): when you work out HOW to do something repeatable and non-obvious — a
  multi-step procedure another agent could follow verbatim — propose it as a skill. That's *procedural*
  memory (a reusable playbook), distinct from a *fact* (\`remember\`/\`report\` lessons) or a wiki page
  (\`kb_write\`). Your proposal is a draft a human reviews before it goes live; don't propose one-offs or
  things a plain fact already covers.
- **The team**: \`directory_lookup\` finds who's on the team and how to reach them (Slack/Discord/email).

## Improve yourself — a fact (memory) vs. your standing instructions (CLAUDE.md)
You can edit your OWN definition, so keep it current instead of repeating the same mistakes. Know which
lever to pull:
- \`remember\` (or \`report\` \`lessons\`) captures a **fact** for your future runs — a gotcha, a root
  cause, a decision. Reach for it constantly, for the specific things a task teaches you.
- \`agent_update\` rewrites **your own CLAUDE.md** (your system prompt / standing instructions), plus
  your description and tuning — your durable **identity and how you always work**. Reach for it when you
  notice a recurring gap in your own setup: a step you always have to redo, a convention you should
  always follow, a better description of what you do. It takes effect next session and every edit is
  reversible (\`agent_history\` / \`agent_revert\`).
- Often you want **both**: \`remember\` the one-off fact now, AND — if it reveals a standing rule you'll
  need on every run — fold that rule into your CLAUDE.md with \`agent_update\`. Rule of thumb: a fact
  about THIS task → memory; a change to how you ALWAYS operate → your CLAUDE.md.

## Environment notes
- Links aren't clickable in this terminal: always print any URL the user must open or copy
  (OAuth/connect links etc.) in full as plain text, not only as a markdown label.`;

/**
 * Session lifecycle. `running` (tmux alive) resolves into exactly one terminal state:
 *  - `done`    — the agent reported completion (`report`) OR the process exited gracefully (`markEnded`).
 *  - `stopped` — a human halted it (`stopSession`).
 *  - `crashed` — the pane died with no end signal at all (kill/OOM/reboot), caught by the liveness sweep.
 * A terminal row can go back to `running` via `markResumed` when the browser reattaches and resumes.
 */
export type SessionStatus = 'running' | 'done' | 'stopped' | 'crashed';

/**
 * Every distinct way a session gets initiated, normalized for the console's origin badge. Resolved
 * server-side by `sourceKind()` — the automation family (`cron`/`webhook`/`slack`/`discord`/`composio`/
 * `scheduled`) is split by joining the triggering automation's `type`, which the raw `spawnedBy`
 * (`automation:<id>`) can't tell the client. `manual` = a console member spawned it directly; `task` =
 * the Tasks dispatcher; `chat` = the `/agent` chat router; `system` = an internal principal with no
 * member (e.g. the consolidation gardener).
 */
export type SessionSourceKind =
  | 'manual' | 'cron' | 'webhook' | 'slack' | 'discord' | 'composio' | 'scheduled' | 'task' | 'chat' | 'system';

export interface Session {
  id: string;
  agent: string;
  title: string;
  task: string;
  tmux: string;
  status: SessionStatus;
  /**
   * Whether the tmux pane is alive RIGHT NOW, independent of the stored lifecycle `status`. An
   * interactive session that reported `done` (or whose browser detached) keeps a live, attachable
   * pane — so `status` reads `done` while `alive` stays true. `undefined` when liveness is unknown
   * (launcher backend, or the tmux poll failed): consumers then fall back to `status`.
   */
  alive?: boolean;
  /**
   * Whether this session can be resurrected in place via `claude --resume` when its terminal is
   * re-opened (the ttyd attach wrapper sources its persisted `session-<id>.env`). True only for
   * interactive claude-code sessions — headless automation runs write no env file, so they're never
   * resumable. Independent of `status`: a running session is also "resumable", but the console only
   * offers a Resume affordance once it's no longer live.
   */
  resumable?: boolean;
  /** Raw provenance: member id, or `automation:<id>`/`task:<id>`/`chat:<name>` when a trigger spawned it. */
  spawnedBy?: string;
  /** Human-readable provenance for the console (member name/email, or the automation's name). */
  spawnedByLabel?: string;
  /** Normalized origin category — every distinct WAY a session gets initiated, resolved server-side
   *  (the automation sub-types below need a join the raw `spawnedBy` can't give the client). Drives the
   *  console's origin icon/badge. `manual` = a console member started it; the automation family splits by
   *  trigger; `task`/`chat` = the dispatcher/chat-router; `system` = an internal principal (e.g. the
   *  consolidation gardener). */
  sourceKind?: SessionSourceKind;
  /** True when the run launched unattended (an automation/cron/task run). These now run as an attachable
   *  interactive TUI (not `claude -p`) that a human can take over live; the console badges them as
   *  unattended vs. a member's own interactive session. */
  headless?: boolean;
  /** The member id who "took over" (claimed) this unattended run to watch/steer it — set makes the
   *  session sticky (never auto-reaped at turn-end). Undefined = nobody has claimed it. */
  claimedBy?: string;
  /** The member id this session ACTS AS (run_as) — distinct from `spawnedBy` provenance. A task- or
   *  chat-triggered run is spawned by `task:`/`automation:` but runs as (and is owned by) a member,
   *  so the console keys "my sessions" off this too. */
  runAs?: string;
  /** Human-readable owner: the run-as member's name/email. Undefined when the session has no run-as
   *  identity (e.g. a company-identity automation run). Drives the sessions-list Owner filter. */
  runAsLabel?: string;
  createdAt: number;
  /** Last time the session's status changed (report/end/stop/resume/crash); = createdAt until the
   *  first transition. Lets the sessions list sort by recent activity, not just creation. */
  updatedAt: number;
  /** Human verdict on the finished run — a person who oversaw it saying it did ('up') / didn't ('down')
   *  do what they wanted. The ground-truth signal for the agent maturity score. Undefined = unrated. */
  rating?: 'up' | 'down';
  /** The member id / display name who gave the verdict (for the byline). */
  ratedBy?: string;
  ratedByLabel?: string;
  ratedAt?: number;
}

export interface FeedMessage {
  id: string;
  type: 'task' | 'update' | 'approval' | 'question' | 'completed' | 'artifact' | 'notification' | 'skill.proposed' | 'goal.proposed' | 'skill.request' | 'host.proposed';
  sessionId: string;
  agent: string;
  title: string;
  body: string;
  status: 'open' | 'pending' | 'approved' | 'rejected' | 'answered' | 'cancelled';
  approvalId?: string;
  capability?: string;
  args?: unknown;
  level?: string;
  /** For 'approval' messages: the explicit risk bucket (yellow = admin, red = owner) — the legible
   *  severity signal the card badges. Derived from `level` on read. */
  riskClass?: RiskClass;
  /** Who/what spawned the session (member id | `automation:<id>`) — for 'task' provenance. */
  source?: string;
  /** Links a 'question' message to its row; the answer derives live from it. */
  questionId?: string;
  answer?: string;
  /** For 'completed' messages: success | failure | partial | unknown. */
  outcome?: string;
  /** For 'approval' messages: the policy's reason this action needs sign-off (why, vs the agent's
   *  own `body` reasoning of what it's doing). Derived live from the approvals table. */
  policyReason?: string;
  /** Who resolved an 'approval' / answered a 'question' (email) — for the resolved-card byline. */
  resolvedBy?: string;
  answeredBy?: string;
  /** The session's live display title (joined live from term_sessions) — the inbox's primary heading. */
  sessionTitle?: string;
  /** Whether the requesting viewer has marked this read (per-member; absent on the agent's own feed). */
  read?: boolean;
  /** Explicit recipient routing: when set, visibility is governed by this Audience rather than the
   *  card's session provenance (the path a session-less card — e.g. a Tasks notification — reaches the
   *  right person). `audienceId` holds the member id / approval level, per `audienceKind`. */
  audienceKind?: Audience['kind'];
  audienceId?: string;
  createdAt: number;
}

type GateStatus = 'pending' | 'allow' | 'deny';
type GateResult = { decision: 'allow' | 'deny' | 'pending'; gateId?: string };

interface SessionRow {
  id: string;
  agent: string;
  title: string;
  task: string;
  tmux: string;
  status: SessionStatus;
  spawned_by: string | null;
  run_as: string | null;
  headless: number | null;
  claimed_by: string | null;
  claimed_at: number | null;
  created_at: number;
  updated_at: number;
  rating: string | null;
  rated_by: string | null;
  rated_at: number | null;
}
interface MessageRow {
  id: string;
  type: FeedMessage['type'];
  session_id: string;
  agent: string;
  title: string;
  body: string;
  status: FeedMessage['status'];
  approval_id: string | null;
  capability: string | null;
  args: string | null;
  level: string | null;
  source: string | null;
  question_id: string | null;
  outcome: string | null;
  created_at: number;
  approval_status: FeedMessage['status'] | null;
  approval_reason: string | null;
  approval_resolved_by: string | null;
  question_status: FeedMessage['status'] | null;
  question_answer: string | null;
  question_answered_by: string | null;
  /** The spawning member/automation of this message's session — for per-member inbox scoping. */
  session_spawned_by?: string | null;
  /** The run-as member of this message's session (P2) — also grants that member inbox visibility. */
  session_run_as?: string | null;
  /** The session's live display title (AI-renamed on report, else the task / automation name) — the
   *  inbox leads with this as the primary heading, with the agent as a secondary line. */
  session_title?: string | null;
  /** Per-viewer inbox state, joined from message_state for the requesting member (console feed only).
   *  Absent (key not selected) on the agent's own session inbox. */
  state_read_at?: number | null;
  /** Explicit-audience routing columns (NULL = fall back to session visibility). */
  audience_kind?: string | null;
  audience_id?: string | null;
}

/** What the approval-notifier sink receives when a risky action lands an approval card. */
export interface ApprovalNotice {
  sessionId: string;
  agent: string;
  capability: string;
  level: ApprovalLevel;
  riskClass: 'yellow' | 'red';
  reason?: string;
}

/** What the question-notifier sink receives when an agent asks the human a question — so an out-of-band
 *  channel (Slack/Discord DM) can ping the person the run acts for, the way approvals already ping
 *  approvers. Without it a blocking `ask` sits unseen in the console until it times out. */
export interface QuestionNotice {
  sessionId: string;
  agent: string;
  prompt: string;
  /** Resolved member id when the agent `ask`ed a SPECIFIC teammate (not the run's operator); the
   *  registry DMs them instead of the sessionOwner. Undefined = the default sessionOwner routing. */
  to?: string;
}

/** What the member-notifier sink receives when an agent deliberately notifies a specific teammate via
 *  the `notify` tool — the explicit "this task needs someone else to know" escape hatch from the
 *  session-owner-scoped default. `to` is the resolved member id; the registry DMs them out-of-band. */
export interface MemberNotice {
  sessionId: string;
  agent: string;
  to: string;
  message: string;
  important: boolean;
}

/** What the session-event notifier sink receives when one of a member's own sessions changes state —
 *  it started waiting on them, finished, or crashed. The registry DMs the run's owner (its `run_as`,
 *  else the console member who spawned it) on Slack/Discord IF that member opted into `dm` notifications.
 *  The inbox card is written inline regardless; this is only the out-of-band push, gated on preference so
 *  it doesn't flood. Approvals/questions have their own (always-on) notifiers — this covers the newer
 *  complete/waiting/crashed events the console added a bell for. */
export interface SessionEventNotice {
  sessionId: string;
  agent: string;
  kind: 'waiting' | 'completed' | 'crashed';
  title: string;
  message: string;
}

export class TerminalManager {
  /** Scripted demo runner — for `runtime: mock` agents. */
  private readonly runner = path.resolve(__dirname, '../terminal/agent-runner.sh');
  /** Real-Claude launcher — for `runtime: claude-code` agents. Opens claude in the agent's folder. */
  private readonly launcher = path.resolve(__dirname, '../terminal/claude-launch.sh');
  /** PreToolUse gate hook the launched claude is wired to. */
  private readonly hook = path.resolve(__dirname, '../terminal/gate-hook.sh');
  /** OS-owned memory MCP server (compiled JS), injected into every claude-code session. */
  private readonly memoryMcp = path.resolve(__dirname, 'memory/memory-mcp.js');
  private readonly db: Db;
  /** Where sessions actually run: the shared local socket (default) or per-member uids via the
   *  launcher when AOS_UID_ISOLATION=1 (Phase A). Selected once at construction. */
  private readonly backend: SessionBackend;
  /** Phase A flag — when on, per-session files are handed to the launcher (written in the member
   *  home) rather than the app dir, and resurrect/.env (a local-ttyd feature) is skipped. */
  private readonly uidIsolation = process.env.AOS_UID_ISOLATION === '1';
  /** Idle grace before a member's uid/ttyd is reclaimed once they have no running sessions (A5). */
  private readonly idleGraceMs = Number(process.env.AOS_IDLE_GRACE_MS) || 15 * 60_000;
  /** Optional sink notified when an approval card lands, so an out-of-band channel (Slack/Discord DM)
   *  can ping the approver. Set by the registry once the chat sockets exist; absent = no notifications. */
  private approvalNotifier?: (notice: ApprovalNotice) => void;
  setApprovalNotifier(fn: (notice: ApprovalNotice) => void): void { this.approvalNotifier = fn; }
  /** Optional sink notified when an agent asks the human a question — mirrors the approval notifier so
   *  a blocking `ask` pings the run-as member out-of-band instead of sitting unseen. */
  private questionNotifier?: (notice: QuestionNotice) => void;
  setQuestionNotifier(fn: (notice: QuestionNotice) => void): void { this.questionNotifier = fn; }
  /** Optional sink that mirrors an inbox-worthy event (completion, question, approval) back to the
   *  Slack/Discord thread a chat-triggered session is bound to, so the human who pinged the agent in
   *  chat sees the outcome there instead of having to switch to the console. No-op for non-chat runs
   *  (the sink resolves no bound thread). Set by the registry once the chat sockets exist. */
  private chatMirror?: (sessionId: string, text: string | ((platform: ChatPlatform) => string)) => void;
  setChatMirror(fn: (sessionId: string, text: string | ((platform: ChatPlatform) => string)) => void): void { this.chatMirror = fn; }
  /** Optional sink notified when an agent uses the `notify` tool to ping a specific teammate — the
   *  registry DMs the target member on their linked Slack/Discord (the inbox card is written inline). */
  private memberNotifier?: (notice: MemberNotice) => void;
  setMemberNotifier(fn: (notice: MemberNotice) => void): void { this.memberNotifier = fn; }
  /** Optional sink notified when one of a member's sessions starts waiting / finishes / crashes, so the
   *  registry can DM the run's owner out-of-band (gated on their `dm` preference). Set by the registry
   *  once the chat sockets exist; absent = no push (the inbox card is always written regardless). */
  private sessionEventNotifier?: (notice: SessionEventNotice) => void;
  setSessionEventNotifier(fn: (notice: SessionEventNotice) => void): void { this.sessionEventNotifier = fn; }
  private fireSessionEvent(sessionId: string, agent: string, kind: SessionEventNotice['kind'], title: string, message: string): void {
    try { this.sessionEventNotifier?.({ sessionId, agent, kind, title, message }); } catch { /* advisory — never let a push wedge the caller */ }
  }

  constructor(
    private readonly os: AgentOS,
    private readonly baseUrl: string,
    private readonly tmuxSocket: string,
    /** The console's public origin (`scheme://host`) — the base for deep-links mirrored into chat
     *  threads. Optional so test/demo call sites can omit it; links fall back to a bare console path. */
    private readonly publicOrigin = '',
  ) {
    this.db = os.db;
    const onError: SpawnErrorSink = (sessionId, agent, error) => this.audit(sessionId, agent, 'session.error', { error });
    this.backend = process.env.AOS_UID_ISOLATION === '1'
      ? new LauncherSessionBackend(new LauncherClient(process.env.AOS_LAUNCHER_SOCK || '/run/aos/launcher.sock'), onError)
      : new LocalSessionBackend(this.tmuxSocket, onError);
  }

  /** The launcher "space" (member-uid identity) a session runs in: the spawning member, or a shared
   *  `automations` space for system/automation spawns. The local backend ignores it. */
  private spaceFor(spawnedBy?: string | null): string {
    // System spawns with no run-as member (an automation or an ownerless task) share the `automations`
    // space rather than minting a per-provenance uid — a `task:<id>` is unique per task, so bucketing
    // by it would leak a space per ownerless task. A task WITH an owner passes run_as here (→ the member).
    if (!spawnedBy || spawnedBy.startsWith('automation:') || spawnedBy.startsWith('task:')) return 'automations';
    return spawnedBy;
  }

  /**
   * Idle GC (A5): reclaim a member's uid + ttyd once they have no running session and none was started
   * within the grace window. Their home (creds, agent working copies) persists on disk — only the live
   * uid/ttyd/slice are freed. No-op under the local backend (managedSpaces() is empty). Run periodically.
   */
  reapIdleSpaces(): void {
    const spaces = this.backend.managedSpaces();
    if (!spaces.length) return;
    const rows = this.db.prepare('SELECT spawned_by, run_as, status, created_at FROM term_sessions').all<{ spawned_by: string | null; run_as: string | null; status: string; created_at: number }>();
    const now = Date.now();
    for (const space of spaces) {
      const inSpace = rows.filter((r) => this.spaceFor(r.run_as ?? r.spawned_by) === space);
      if (inSpace.some((r) => r.status === 'running')) continue; // still active
      const latest = inSpace.reduce((m, r) => Math.max(m, r.created_at), 0);
      if (latest && now - latest < this.idleGraceMs) continue; // keep warm — recent activity
      this.backend.release(space);
      this.audit('-', 'launcher', 'space.released', { space, reason: 'idle' });
    }
  }

  /**
   * Sessions visible to `viewer`. owner/admin (or an omitted viewer — internal callers) see all; a
   * regular member sees only sessions they spawned, plus sessions fired by an automation they created.
   */
  listSessions(viewer?: Member): Session[] {
    const rows = this.db.prepare('SELECT * FROM term_sessions ORDER BY created_at DESC').all<SessionRow>();
    // Lazy liveness: a row stays 'running' until its tmux session is gone. A running row whose pane
    // vanished with NO end signal (no `report`/`markEnded`/`stopSession`) died abruptly — kill/OOM/
    // reboot — so it's a `crashed`, not a clean end. Grace-period new rows (tmux may not have finished
    // spawning when the first poll lands). `aliveNames()` returns null when the poll couldn't run — we
    // then reap nothing, so a transient tmux hiccup can't falsely crash every live session.
    // Poll true tmux liveness once for the whole list (null: launcher backend, or the poll failed →
    // liveness unknown, so we neither reap nor claim it). We compute it whenever there are rows — not
    // only when something is 'running' — because a terminal-state row (a `done` interactive session)
    // can still have a live, attachable pane, and the UI colours the dot green off that.
    const alive = rows.length ? this.backend.aliveNames() : null;
    if (alive) {
      const cutoff = Date.now() - 10_000;
      for (const r of rows) {
        if (r.status === 'running' && !alive.has(r.tmux) && r.created_at < cutoff) {
          const crashedAt = Date.now();
          this.db.prepare("UPDATE term_sessions SET status = 'crashed', updated_at = ? WHERE id = ?").run(crashedAt, r.id);
          r.status = 'crashed';
          r.updated_at = crashedAt; // keep the in-memory row in sync so this same response isn't stale
          // A crash fires no end signal (no `report`/`markEnded`/`stopSession`), so this sweep is the
          // only place to capture what the run did before it died. Outcome 'crashed'; idempotent, so
          // repeated polls won't write twice; skipped if the session did no real work.
          this.writeEpisode(r.id, r.agent, 'crashed');
          // A crashed agent can't answer or act — retire its open questions + approvals like a clean stop.
          this.cancelPendingQuestions(r.id, 'system');
          this.cancelPendingApprovals(r.id, 'system');
          // Surface the crash to the owner: a 'completed' card (outcome 'crashed') is the only feed entry a
          // crash produces, since it fires no clean end signal. Guarded on hasCompleted so a run that had
          // already reported before its pane died isn't double-carded; the status flip makes it once-only.
          if (!this.hasCompleted(r.id)) {
            const title = `Crashed — ${r.agent}`;
            const body = 'The session ended unexpectedly (the process died).';
            this.addMessage({ type: 'completed', sessionId: r.id, agent: r.agent, title, body, status: 'open', outcome: 'crashed', audienceKind: 'sessionOwner', audienceId: r.id });
            this.fireSessionEvent(r.id, r.agent, 'crashed', title, body);
          }
        }
      }
    }
    const visible = viewer ? rows.filter((r) => this.canViewRow(r.spawned_by, r.run_as, viewer)) : rows;
    const resumable = this.resumableIds();
    return visible.map((r) => ({
      ...toSession(r),
      alive: alive ? alive.has(r.tmux) : undefined,
      resumable: resumable.has(r.id),
      spawnedByLabel: this.spawnedByLabel(r.spawned_by, r.run_as),
      sourceKind: this.sourceKind(r.spawned_by),
      runAsLabel: this.runAsLabel(r.run_as),
      ratedByLabel: this.runAsLabel(r.rated_by),
    }));
  }

  /**
   * The runs a given trigger spawned — every session whose provenance is `spawnedBy` (e.g.
   * `automation:<id>`), newest first. Reuses `listSessions` so each run carries live status /
   * resumable / label and the SAME per-viewer visibility rules: owner/admin see all, a member sees
   * only runs of automations they can view (via `canViewRow`).
   */
  listRunsFor(spawnedBy: string, viewer?: Member): Session[] {
    return this.listSessions(viewer).filter((s) => s.spawnedBy === spawnedBy);
  }

  /**
   * Session ids that have a persisted launch env (`session-<id>.env`) — i.e. an interactive session
   * the ttyd attach wrapper can resurrect via `claude --resume` (see `writeEnvFile`/`terminal/attach.sh`).
   * Headless runs write no env file, so they're absent (and correctly report `resumable:false`). One
   * readdir serves the whole list; no data home (demo/tests) → nothing resumable.
   */
  private resumableIds(): Set<string> {
    const ids = new Set<string>();
    if (!this.os.paths) return ids;
    try {
      for (const f of fs.readdirSync(this.os.paths.connectors)) {
        const m = /^session-(.+)\.env$/.exec(f);
        if (m) ids.add(m[1]);
      }
    } catch {
      /* connectors dir may not exist yet — nothing resumable */
    }
    return ids;
  }

  /**
   * The per-member inbox visibility rule. owner/admin see everything; a member sees what THEY
   * spawned, plus sessions an automation they created fired. Used to scope the sessions list, the
   * inbox feed, and the approvals list so a member never sees another member's tasks or data.
   */
  canViewSpawn(spawnedBy: string | null, viewer: Member): boolean {
    if (viewer.role === 'owner' || viewer.role === 'admin') return true;
    if (!spawnedBy) return false;
    if (spawnedBy === viewer.id) return true;
    if (spawnedBy.startsWith('automation:')) {
      const a = this.db.prepare('SELECT created_by FROM automations WHERE id = ?').get<{ created_by: string | null }>(spawnedBy.slice('automation:'.length));
      return !!a?.created_by && a.created_by === viewer.id;
    }
    return false;
  }

  /**
   * The full visibility rule including run-as (P2): a session is visible to the member it ACTED AS
   * (`run_as`), on top of the provenance rule (`canViewSpawn`). So a chat-triggered session — whose
   * `spawned_by` is the automation — still lands in the inbox of the person it ran as.
   */
  private canViewRow(spawnedBy: string | null, runAs: string | null, viewer: Member): boolean {
    if (runAs && runAs === viewer.id) return true;
    return this.canViewSpawn(spawnedBy, viewer);
  }

  /**
   * Whether `viewer` may see a message ROW. A card with an explicit `audience_kind` is routed by that
   * Audience (the pull face of {@link resolveRecipients} — one definition of "receiver" for push and
   * pull); otherwise it falls back to the card's session provenance (`canViewRow`). Owner/admin see all
   * either way, keeping parity with `canViewSpawn`.
   */
  private canViewMessageRow(r: MessageRow, viewer: Member): boolean {
    return this.canViewMsg(r.audience_kind ?? null, r.audience_id ?? null, r.session_spawned_by ?? null, r.session_run_as ?? null, viewer);
  }

  /**
   * Role-NEUTRAL session ownership: is `viewer` the human this session acts for — its `run_as`, or the
   * member who spawned it directly (a prefixed `automation:`/`task:`/`chat:` provenance has no human
   * owner here)? Unlike {@link canViewRow} this does NOT grant owner/admin, so the default inbox scope
   * can tell "a session I own" apart from "a session I can merely oversee".
   */
  private ownsSession(spawnedBy: string | null, runAs: string | null, viewer: Member): boolean {
    if (runAs && runAs === viewer.id) return true;
    if (spawnedBy && !spawnedBy.includes(':') && spawnedBy === viewer.id) return true;
    return false;
  }

  /**
   * Is a message ADDRESSED to `viewer` (vs merely visible via an oversight role)? This is the `mine`
   * inbox scope — the fix for owner/admin being flooded by every session's cards. An explicit audience
   * routes by REAL membership: a named `member`/`sessionOwner` by id, an `approvers`/`admins` card to
   * anyone who genuinely holds that authority (they ARE an intended recipient — e.g. a member's session
   * that escalated an approval legitimately belongs in every approver's queue). A card with no audience
   * (legacy session card) is owned by its session's human. Owner/admin get NO blanket pass here.
   */
  private isAddressedTo(r: MessageRow, viewer: Member): boolean {
    // A session's own human always sees their session's cards in `mine`, whatever the card's routing
    // audience — e.g. an approval that escalated to the `approvers` tier still belongs in the member
    // owner's feed for awareness. (Task cards have no session row → this is a no-op for them.)
    if (this.ownsSession(r.session_spawned_by ?? null, r.session_run_as ?? null, viewer)) return true;
    const kind = r.audience_kind ?? null;
    if (kind === 'member') return r.audience_id === viewer.id;
    if (kind === 'approvers') {
      const a = audienceFromColumns('approvers', r.audience_id ?? null);
      return a?.kind === 'approvers' && canApprove(viewer.role, a.level);
    }
    if (kind === 'admins') return viewer.role === 'owner' || viewer.role === 'admin';
    // sessionOwner audience (audience_id === session id) and legacy un-audienced cards resolve to the
    // session owner too — already covered by the ownsSession check above; nothing else addresses them.
    return false;
  }

  /** Field-level twin of {@link canViewMessageRow} for the read/dismiss/answer guards, which fetch just
   *  the visibility columns. A card is visible to its explicit audience OR to the human of the session
   *  it belongs to — so a member whose session escalates an approval to the `approvers` tier still sees
   *  their OWN session's card (awareness), on top of the approvers who must act. A session-less card (a
   *  Task, session cols null) is governed purely by the audience + the owner/admin oversight rule. */
  private canViewMsg(audienceKind: string | null, audienceId: string | null, spawnedBy: string | null, runAs: string | null, viewer: Member): boolean {
    if (audienceKind && this.canViewAudience(audienceKind, audienceId, viewer)) return true;
    return this.canViewRow(spawnedBy, runAs, viewer);
  }

  /** Is `viewer` in the resolved recipient set of an explicit audience? Reuses `resolveRecipients` so a
   *  card is visible to exactly whom it would have been DMed (owner/admin always, per the platform rule). */
  private canViewAudience(kind: string, id: string | null, viewer: Member): boolean {
    if (viewer.role === 'owner' || viewer.role === 'admin') return true;
    const audience = audienceFromColumns(kind, id);
    if (!audience) return false;
    return resolveRecipients(this.os, audience).some((m) => m.id === viewer.id);
  }

  /** Whether `viewer` may see a specific session (resolves its provenance + run-as, then the rule). */
  canViewSession(sessionId: string, viewer: Member): boolean {
    const r = this.db.prepare('SELECT spawned_by, run_as FROM term_sessions WHERE id = ?').get<{ spawned_by: string | null; run_as: string | null }>(sessionId);
    return this.canViewRow(r ? r.spawned_by : null, r ? r.run_as : null, viewer);
  }

  /** Whether `viewer` may act on a pending question. A question `ask`ed to a SPECIFIC teammate
   *  (`audience_id` set) is answerable by that member (its `member` audience) OR by owner/admin oversight;
   *  otherwise it resolves through its session's provenance/run-as like the rest of the inbox. */
  canViewQuestion(questionId: string, viewer: Member): boolean {
    const q = this.db.prepare('SELECT run_id, audience_id FROM questions WHERE id = ?').get<{ run_id: string; audience_id: string | null }>(questionId);
    if (!q) return false;
    if (q.audience_id && this.canViewAudience('member', q.audience_id, viewer)) return true;
    return this.canViewSession(q.run_id, viewer);
  }

  /**
   * The browser iframe URL to attach to a session's live terminal. Flag off → the shared
   * `/terminal/?arg=…`; flag on → ensures the member's own ttyd is up and returns a per-member
   * `/terminal/<space>/?arg=…` that the app reverse-proxies to that member's port. null if unknown.
   */
  async attachUrl(sessionId: string): Promise<string | null> {
    const r = this.db.prepare('SELECT tmux, spawned_by, run_as FROM term_sessions WHERE id = ?').get<{ tmux: string; spawned_by: string | null; run_as: string | null }>(sessionId);
    if (!r) return null;
    // Opening the terminal is a deliberate act (vs ttyd's silent auto-reconnect, which never fetches an
    // attach URL) — so lift any prior stop-block and let attach.sh resurrect a stopped session on re-open.
    this.allowResume(sessionId);
    return this.backend.attachUrl(this.spaceFor(r.run_as ?? r.spawned_by), r.tmux);
  }

  /**
   * For the terminal reverse-proxy (flag on): the ttyd loopback port serving `space` if `member` may
   * reach it, else null. owner/admin reach any space; a member only their own; the shared
   * `automations` space is owner/admin-only.
   */
  proxyPortFor(space: string, member: Member): number | null {
    const allowed = member.role === 'owner' || member.role === 'admin' || space === member.id;
    if (!allowed) return null;
    return this.backend.ttydPortFor(space) ?? null;
  }

  /** Resolve a session's provenance (+ run-as) to a console-friendly label: member name/email, or
   *  automation — and "Automation · X · as Alice" when it ran as a resolved member. */
  private spawnedByLabel(spawnedBy: string | null, runAs?: string | null): string | undefined {
    const asMember = runAs ? this.os.team.getMember(runAs) : undefined;
    const asSuffix = asMember && asMember.id !== spawnedBy ? ` · as ${asMember.name || asMember.email}` : '';
    if (!spawnedBy) return asMember ? `as ${asMember.name || asMember.email}` : undefined;
    if (spawnedBy.startsWith('automation:')) {
      const auto = this.db.prepare('SELECT name FROM automations WHERE id = ?').get<{ name: string }>(spawnedBy.slice('automation:'.length));
      return `${auto ? `Automation · ${auto.name}` : 'Automation'}${asSuffix}`;
    }
    // Generic chat-router run (`chat:<agent>`) — a Slack/Discord message addressed to an agent, no automation.
    if (spawnedBy.startsWith('chat:')) return `Chat · ${spawnedBy.slice('chat:'.length)}${asSuffix}`;
    // Auto-dispatched from the Tasks board (`task:<id>`) — a durable unit of work spawned a session.
    if (spawnedBy.startsWith('task:')) return `Task · ${spawnedBy.slice('task:'.length)}${asSuffix}`;
    const m = this.os.team.getMember(spawnedBy);
    return m ? m.name || m.email : spawnedBy;
  }

  /** Normalize a session's raw provenance to a {@link SessionSourceKind} — the every-way-a-session-starts
   *  taxonomy the console badges. The automation family is split by joining the triggering automation's
   *  `type` (`once` → `scheduled`), which the bare `automation:<id>` can't tell the client; a `spawnedBy`
   *  that resolves to no known member is an internal `system` principal. */
  private sourceKind(spawnedBy: string | null): SessionSourceKind {
    if (!spawnedBy) return 'system';
    if (spawnedBy.startsWith('task:')) return 'task';
    if (spawnedBy.startsWith('chat:')) return 'chat';
    if (spawnedBy.startsWith('automation:')) {
      const auto = this.db.prepare('SELECT type FROM automations WHERE id = ?').get<{ type: string }>(spawnedBy.slice('automation:'.length));
      switch (auto?.type) {
        case 'cron': return 'cron';
        case 'webhook': return 'webhook';
        case 'slack': return 'slack';
        case 'discord': return 'discord';
        case 'composio': return 'composio';
        case 'once': return 'scheduled';
        default: return 'cron'; // deleted/unknown automation → treat as a generic scheduled trigger
      }
    }
    // A bare principal: a console member spawned it manually, or an internal system principal.
    return this.os.team.getMember(spawnedBy) ? 'manual' : 'system';
  }

  /** The run-as member's display name (name → email), for the sessions-list Owner filter. Undefined
   *  when the session has no run-as identity or the member no longer exists. */
  private runAsLabel(runAs: string | null): string | undefined {
    if (!runAs) return undefined;
    const m = this.os.team.getMember(runAs);
    return m ? m.name || m.email : undefined;
  }

  /**
   * How many sessions have a `running` row AND a live tmux pane right now — the whole-box concurrency
   * measure for the scheduler cap. Counts every provenance (interactive, chat, automation, task) since
   * they all consume memory, so the scheduler backs off when a human is already loading the box.
   *
   * When liveness CAN'T be polled (`aliveNames()===null` — always on the Linux LauncherSessionBackend,
   * or a transient tmux hiccup) it falls back to a pure DB count of `running` rows rather than 0. The old
   * fail-open-to-0 silently DISABLED the cap under exactly the load it's for (the launcher backend never
   * polls) — a DB proxy keeps the cap engaged. The crash sweep reaps stale `running` rows, so the count
   * is a safe upper-bound. (docs/concurrency-cap-plan.md Phase 1.)
   */
  aliveSessionCount(): number {
    const alive = this.backend.aliveNames();
    if (!alive) return this.runningSessionCount();
    const rows = this.db.prepare("SELECT tmux FROM term_sessions WHERE status = 'running'").all<{ tmux: string }>();
    let n = 0;
    for (const r of rows) if (alive.has(r.tmux)) n++;
    return n;
  }

  /** Pure DB count of `running` sessions — the cap's fallback when tmux liveness can't be polled. Cheap
   *  (runs per tick + per admission check); the crash sweep keeps the `running` set honest. */
  runningSessionCount(): number {
    return this.db.prepare("SELECT COUNT(*) AS c FROM term_sessions WHERE status = 'running'").get<{ c: number }>()!.c;
  }

  /**
   * Per-session resident memory for the live running set — what each agent session's process tree
   * (shell → claude/node → MCP subprocesses) currently occupies. Joins the running rows against the
   * backend's `sessionRss` map (keyed by tmux name). `available:false` when the backend can't measure
   * it (launcher/uid-isolation backend, or a transient tmux/ps failure). RSS is approximate (shared
   * library pages are counted per process). Bytes out (KiB×1024) so the API speaks one unit.
   */
  sessionMemory(): { available: boolean; totalRss: number; sessions: { id: string; agent: string; title: string; rss: number }[] } {
    const rss = this.backend.sessionRss();
    if (!rss) return { available: false, totalRss: 0, sessions: [] };
    const rows = this.db.prepare("SELECT id, agent, title, tmux FROM term_sessions WHERE status = 'running'")
      .all<{ id: string; agent: string; title: string; tmux: string }>();
    const sessions = rows
      .map((r) => ({ id: r.id, agent: r.agent, title: r.title, rss: (rss.get(r.tmux) ?? 0) * 1024 }))
      .filter((s) => s.rss > 0)                         // drop rows whose pane already went away
      .sort((a, b) => b.rss - a.rss);
    return { available: true, totalRss: sessions.reduce((n, s) => n + s.rss, 0), sessions };
  }

  /** Is this session's tmux shell still alive? (The automations guard against pile-ups.) */
  isAlive(sessionId: string): boolean {
    const r = this.db.prepare('SELECT tmux, status FROM term_sessions WHERE id = ?').get<{ tmux: string; status: string }>(sessionId);
    if (!r) return false;
    if (r.status !== 'running') return false; // already marked dead by a previous check
    const alive = this.backend.aliveNames();
    if (!alive) return true; // launcher backend: can't poll; the row says running, so treat as alive
    return alive.has(r.tmux);
  }

  /**
   * The MOST RECENT session bound to a Slack thread (`channel` + `thread_ts`), for thread continuity:
   * a follow-up message in a thread resumes THAT run's agent + claude conversation. Returns the agent,
   * its run-as, and the pinned `claudeSessionId` needed to `--resume`. Undefined when nothing is bound
   * (the first mention — the thread isn't bound yet) or the newest run predates the claude-id column
   * (unresumable → the caller falls back to a fresh spawn).
   */
  sessionForSlackThread(channel: string, threadTs: string): { sessionId: string; agent: string; runAs?: string; claudeSessionId?: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT t.id AS id, t.agent AS agent, t.run_as AS runAs, t.claude_session_id AS claudeSessionId
           FROM slack_threads s JOIN term_sessions t ON t.id = s.session_id
          WHERE s.channel = ? AND s.thread_ts = ?
          ORDER BY t.created_at DESC LIMIT 1`,
      )
      .get<{ id: string; agent: string; runAs: string | null; claudeSessionId: string | null }>(channel, threadTs);
    if (!row) return undefined;
    return { sessionId: row.id, agent: row.agent, runAs: row.runAs ?? undefined, claudeSessionId: row.claudeSessionId ?? undefined };
  }
  listMessages(viewer?: Member, scope: 'mine' | 'all' = 'mine'): FeedMessage[] {
    // Approval messages take their live status from the approvals table, so the inbox stays
    // correct even after a restart (when the in-memory resolution waiter is gone). We also pull each
    // message's session `spawned_by` so the inbox can be scoped per member (owner/admin see all).
    // Read/dismiss are PER-MEMBER (message_state join keyed to the viewer): the feed is shared, so one
    // admin dismissing must not hide the row for another. Legacy global `messages.dismissed_at` is still
    // honored as a dismissed-for-all fallback. With no viewer (demo), state joins to nothing.
    const viewerId = viewer?.id ?? '';
    const rows = this.db
      .prepare(
        `SELECT m.*, a.status AS approval_status, a.reason AS approval_reason, a.resolved_by AS approval_resolved_by,
                q.status AS question_status, q.answer AS question_answer, q.answered_by AS question_answered_by,
                ts.spawned_by AS session_spawned_by, ts.run_as AS session_run_as, ts.title AS session_title,
                ms.read_at AS state_read_at
         FROM messages m
         LEFT JOIN approvals a ON m.approval_id = a.id
         LEFT JOIN questions q ON m.question_id = q.id
         LEFT JOIN term_sessions ts ON m.session_id = ts.id
         LEFT JOIN message_state ms ON ms.message_id = m.id AND ms.member_id = ?
         WHERE m.dismissed_at IS NULL AND ms.dismissed_at IS NULL
         ORDER BY m.created_at DESC`,
      )
      .all<MessageRow>(viewerId);
    let visible = viewer ? rows.filter((r) => this.canViewMessageRow(r, viewer)) : rows;
    // `mine` (the default) narrows the visible set to what's ADDRESSED to the viewer, so owner/admin
    // aren't flooded by every session's cards; `all` is the explicit oversight view (owner/admin only —
    // a member's `all` and `mine` are identical since they only ever see their own).
    if (viewer && scope === 'mine') visible = visible.filter((r) => this.isAddressedTo(r, viewer));
    return visible.map(toMessage);
  }

  /** Mark one message read for a member (per-member; idempotent upsert). Visibility-guarded like the
   *  feed — you can only touch a message you can see. Returns false if it's not found or not yours. */
  markRead(id: string, viewer: Member): boolean {
    const row = this.db
      .prepare('SELECT m.audience_kind AS ak, m.audience_id AS ai, ts.spawned_by AS sb, ts.run_as AS ra FROM messages m LEFT JOIN term_sessions ts ON m.session_id = ts.id WHERE m.id = ?')
      .get<{ ak: string | null; ai: string | null; sb: string | null; ra: string | null }>(id);
    if (!row) return false;
    if (!this.canViewMsg(row.ak, row.ai, row.sb, row.ra, viewer)) return false;
    this.upsertState(id, viewer.id, 'read_at');
    return true;
  }

  /** Mark every message the viewer can currently see as read (per-member), within the given inbox
   *  scope (so "mark all read" on the default `mine` view doesn't touch other people's cards). */
  markAllRead(viewer: Member, scope: 'mine' | 'all' = 'mine'): number {
    let n = 0;
    for (const m of this.listMessages(viewer, scope)) {
      if (m.read) continue;
      this.upsertState(m.id, viewer.id, 'read_at');
      n++;
    }
    return n;
  }

  /** Upsert a per-member message_state timestamp column (read_at | dismissed_at) to now. */
  private upsertState(messageId: string, memberId: string, col: 'read_at' | 'dismissed_at'): void {
    this.db
      .prepare(
        `INSERT INTO message_state (message_id, member_id, ${col}) VALUES (?, ?, ?)
         ON CONFLICT(message_id, member_id) DO UPDATE SET ${col} = excluded.${col}`,
      )
      .run(messageId, memberId, Date.now());
  }

  /** The inbox feed for ONE session — what the agent itself can read back (answers to questions it
   *  asked, approvals/notifications/updates/reports on its own run). Session-scoped, newest first. */
  sessionInbox(sessionId: string, limit = 20): FeedMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, a.status AS approval_status, a.reason AS approval_reason, a.resolved_by AS approval_resolved_by,
                q.status AS question_status, q.answer AS question_answer, q.answered_by AS question_answered_by,
                ts.spawned_by AS session_spawned_by, ts.run_as AS session_run_as, ts.title AS session_title
         FROM messages m
         LEFT JOIN approvals a ON m.approval_id = a.id
         LEFT JOIN questions q ON m.question_id = q.id
         LEFT JOIN term_sessions ts ON m.session_id = ts.id
         WHERE m.session_id = ? AND m.dismissed_at IS NULL
         ORDER BY m.created_at DESC LIMIT ?`,
      )
      .all<MessageRow>(sessionId, limit);
    return rows.map(toMessage);
  }

  /**
   * Dismiss a message from the inbox (soft hide — the row stays for audit, `dismissed_at` is set).
   * Same visibility rule as the feed (`canViewSpawn`), and we refuse to dismiss an item still waiting
   * on the human — a pending approval/question must be resolved/answered, not swept under the rug.
   */
  dismissMessage(id: string, viewer: Member): 'ok' | 'not_found' | 'forbidden' | 'pending' {
    const row = this.db
      .prepare(
        `SELECT m.type, m.audience_kind, m.audience_id, a.status AS approval_status, q.status AS question_status, ts.spawned_by AS session_spawned_by, ts.run_as AS session_run_as
         FROM messages m
         LEFT JOIN approvals a ON m.approval_id = a.id
         LEFT JOIN questions q ON m.question_id = q.id
         LEFT JOIN term_sessions ts ON m.session_id = ts.id
         WHERE m.id = ?`,
      )
      .get<{ type: FeedMessage['type']; audience_kind: string | null; audience_id: string | null; approval_status: string | null; question_status: string | null; session_spawned_by: string | null; session_run_as: string | null }>(id);
    if (!row) return 'not_found';
    if (!this.canViewMsg(row.audience_kind ?? null, row.audience_id ?? null, row.session_spawned_by ?? null, row.session_run_as ?? null, viewer)) return 'forbidden';
    const stillWaiting =
      (row.type === 'approval' && (row.approval_status ?? 'pending') === 'pending') ||
      (row.type === 'question' && (row.question_status ?? 'pending') === 'pending');
    if (stillWaiting) return 'pending';
    this.upsertState(id, viewer.id, 'dismissed_at'); // per-member hide — the row stays for others + audit
    return 'ok';
  }

  /**
   * Dismiss every dismissible Activity message the viewer can see, in one shot. Mirrors
   * `dismissMessage`'s rules: only rows the viewer may see, and never an item still waiting on the
   * human (pending approval/question) — those are left in place. Returns how many were hidden.
   */
  dismissAllMessages(viewer: Member, scope: 'mine' | 'all' = 'mine'): number {
    // Reuse the feed (already visibility-scoped + per-member-dismiss filtered) and hide each dismissible
    // row for THIS viewer. Waiting items (pending approval/question, open notifications) stay put.
    let n = 0;
    for (const m of this.listMessages(viewer, scope)) {
      const stillWaiting =
        (m.type === 'approval' && (m.status ?? 'pending') === 'pending') ||
        (m.type === 'question' && (m.status ?? 'pending') === 'pending') ||
        m.type === 'notification';
      if (stillWaiting) continue;
      this.upsertState(m.id, viewer.id, 'dismissed_at');
      n++;
    }
    return n;
  }

  /**
   * Spawn a session. `headless` (used by automations) runs claude non-interactively (`claude -p`):
   * it works the task to completion and exits, so the pane dies, the session flips to `done`, and
   * the automations pile-up guard releases. Interactive (the default, e.g. manual spawns) opens a
   * normal attachable TUI that stays live until closed.
   */
  createSession(agent: string, title: string, task: string, spawnedBy?: string, headless = false, slack?: { channel: string; threadTs: string }, discord?: { channel: string; messageId: string }, runAs?: string, resumeClaudeId?: string, resident = false): Session {
    const id = randomUUID().slice(0, 8);
    const tmux = `aos-${id}`;
    // The claude conversation this run drives. A fresh run mints a new id (pinned via `--session-id`);
    // a thread follow-up passes the PRIOR run's id so the launcher `--resume`s the same transcript and
    // keeps context. Persisted on the row so a later follow-up can look it up (see sessionForSlackThread).
    const claudeSessionId = resumeClaudeId || randomUUID();
    // P2 — provenance vs identity:
    //   `spawnedBy`     = what TRIGGERED this run (an `automation:<id>` or the console member). Stays
    //                     provenance: drives the inbox source label, the audit principal, isolation
    //                     fallback, and the automation-creator's visibility.
    //   `actingMember`  = whose IDENTITY the agent acts under (connectors / Composio / inbox / uid).
    //                     `runAs` when a trigger resolved a member, else the console member who spawned.
    // When no runAs is given this collapses to today's behavior (identity = the spawning member).
    const actingMember = runAs ?? (spawnedBy && !spawnedBy.startsWith('automation:') ? spawnedBy : undefined);
    // Per-session bearer (0d): exported into the session env and required on the loopback agent
    // endpoints, so one session's runtime can't gate/recall/report AS another by forging its id.
    const secret = randomBytes(24).toString('hex');
    const session: Session = { id, agent, title, task, tmux, status: 'running', createdAt: Date.now(), updatedAt: Date.now() };
    this.db
      .prepare('INSERT INTO term_sessions (id, agent, title, task, tmux, status, spawned_by, run_as, secret, claude_session_id, resident, last_activity, headless, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(session.id, agent, title, task, tmux, 'running', spawnedBy ?? null, actingMember ?? null, secret, claudeSessionId, resident ? 1 : 0, resident ? session.createdAt : null, headless ? 1 : 0, session.createdAt, session.createdAt);
    // No spawn card — the Inbox is a feed of agent-authored signals (progress / questions / approvals /
    // completions / artifacts), not a session lifecycle log. A run that never speaks stays off the feed
    // and lives only on the Sessions page.

    // Native Slack egress: bind this session to the channel/thread it should reply into, so the
    // agentos `slack_reply` tool can post back without the agent supplying (or spoofing) a channel.
    if (slack?.channel) {
      this.db.prepare('INSERT OR REPLACE INTO slack_threads (session_id, channel, thread_ts, created_at) VALUES (?, ?, ?, ?)')
        .run(id, slack.channel, slack.threadTs || '', Date.now());
    }
    // Native Discord egress: the exact analogue — bind the channel + triggering message for discord_reply.
    if (discord?.channel) {
      this.db.prepare('INSERT OR REPLACE INTO discord_threads (session_id, channel, message_id, created_at) VALUES (?, ?, ?, ?)')
        .run(id, discord.channel, discord.messageId || '', Date.now());
    }

    // Pick the runtime from the agent's manifest: claude-code → real claude in its folder;
    // anything else (incl. unknown/demo names) → the scripted mock runner.
    const manifest = this.os.agents.get(agent);
    const runtime = manifest?.runtime ?? 'mock';
    // Audit records BOTH provenance and the run-as principal — when they differ (a trigger acting as
    // a member), the trail shows what fired it AND whose identity it used.
    this.audit(id, agent, 'session.created', { tmux, task, runtime, dir: manifest?.dir, headless, resident, spawnedBy: spawnedBy ?? null, runAs: actingMember ?? null });

    if (runtime === 'claude-code' && manifest?.dir) {
      this.launchClaudeCode({ id, agent, task, secret, actingMember, spawnedBy, hasSlack: !!slack?.channel, hasDiscord: !!discord?.channel, headless, resident, resume: !!resumeClaudeId, claudeSessionId });
    } else {
      this.backend.spawn(this.spaceFor(actingMember ?? spawnedBy), { sessionId: id, agent, tmuxName: tmux, env: this.sessionEnv(id, agent, task, secret), argv: ['bash', this.runner] });
    }
    return session;
  }

  /**
   * Spawn the claude-code runtime for a session row (in its agent folder, governed by the gate hook).
   * Factored out of `createSession` so `reviveResident` can re-launch the SAME row (same id/tmux/secret/
   * claude id) after the warm session was reaped — with `resume: true` it continues the transcript.
   * Memory + connectors are delivered purely as MCP tools via the per-session `.mcp.json`; the
   * orchestrator injects nothing into the prompt.
   */
  private launchClaudeCode(o: {
    id: string; agent: string; task: string; secret: string;
    actingMember?: string; spawnedBy?: string; hasSlack: boolean; hasDiscord: boolean;
    headless: boolean; resident: boolean; resume: boolean; claudeSessionId: string;
  }): void {
    const manifest = this.os.agents.get(o.agent);
    if (!manifest?.dir) return;
    const tmux = `aos-${o.id}`;
    const env = this.sessionEnv(o.id, o.agent, o.task, o.secret);
    // Build the per-session connector + company payloads once (Composio is minted here).
    const mcpJson = this.buildMcpConfigJson(o.id, o.agent, o.actingMember, o.secret, o.hasSlack, o.hasDiscord);
    const companyMd = this.buildCompanyMd(o.agent, o.actingMember);
    this.materializeSkills(o.id, o.agent, manifest.dir);
    // Unattended (automation/cron/task) runs are now an attachable interactive TUI, not `claude -p` — so a
    // human can take one over mid-run by simply attaching (no kill, no resume). The launcher's UNATTENDED
    // lane runs interactive + `--dangerously-skip-permissions` (the gate hook still governs every effect),
    // and the run is torn down at turn-end by the server (Stop-hook → markTurnIdle) rather than by the
    // process exiting. See docs/attachable-sessions-plan.md.
    if (o.headless) env.UNATTENDED = '1';
    // Resident (warm) chat session: the launcher's RESIDENT lane keeps an interactive claude alive so
    // thread follow-ups are delivered by send-keys (see deliverToResident / reviveResident).
    if (o.resident) env.RESIDENT = '1';
    env.AGENT_DIR = manifest.dir;
    env.HOOK = this.hook;
    // No OS sandbox env: the gate hook (PreToolUse) is the sole authority for governed side effects, so
    // we don't wrap the shell in Seatbelt/bubblewrap. Real OS containment is the Linux uid-isolation path.
    // Per-agent model / effort / permission-mode fall back to the workspace default; the launcher maps
    // them onto `--model`/`--effort`/`--permission-mode` (permission-mode on the interactive lane only).
    const tuning = resolveRuntimeTuning(manifest, this.os.settings.runtimeDefaults());
    if (tuning.model) env.CLAUDE_MODEL = tuning.model;
    if (tuning.effort) env.CLAUDE_EFFORT = tuning.effort;
    if (tuning.permissionMode) env.CLAUDE_PERMISSION_MODE = tuning.permissionMode;
    this.audit(o.id, o.agent, 'session.tuning', { model: tuning.model, effort: tuning.effort, permissionMode: tuning.permissionMode });
    // A stable claude session id we choose (vs letting claude mint its own), so a stopped session can be
    // resumed in-place with `claude --resume <id>`. `resume` continues that transcript (a thread
    // follow-up or a console reconnect) instead of starting fresh.
    env.CLAUDE_SESSION_ID = o.claudeSessionId;
    if (o.resume) env.RESUME = '1';
    // The agent's opt-in shell secrets (vault keys → shell env vars, e.g. GH_TOKEN for `gh`).
    this.injectShellSecrets(env, o.agent, manifest, o.id);
    // Per-member git: if THIS run's run-as human has linked their own GitHub account, their token
    // OVERRIDES the agent bot's GH_TOKEN — so git push / gh pr are authored as the actual person.
    this.injectMemberGithub(env, o.agent, o.actingMember, o.id);
    // Whatever set GH_TOKEN above (member token or agent bot), teach plain `git` to use it too — `gh`
    // reads GH_TOKEN natively but `git push` over HTTPS does not, so without this only half the toolchain
    // authenticates. A github.com-scoped credential helper closes that gap.
    this.configureGitCredentials(env);
    // Phase 2c: granted Host connections' SSH keys → a session ssh_config + ssh/scp PATH shim, so the
    // agent's plain `ssh` authenticates to a host without ever handling the key. (Local-lane only.)
    this.injectHostCredentials(env, o.agent, o.actingMember, o.id);
    if (this.uidIsolation) {
      // Flag on: the launcher writes the files INTO the member's home and sets MCP_CONFIG/COMPANY_FILE itself.
      this.backend.spawn(this.spaceFor(o.actingMember ?? o.spawnedBy), { sessionId: o.id, agent: o.agent, tmuxName: tmux, env, argv: ['bash', this.launcher], files: { mcp: mcpJson || undefined, company: companyMd || undefined }, agentSrc: manifest.dir });
    } else {
      // Flag off: materialise into the app's connectors dir and persist the launch context so the ttyd
      // attach wrapper can resurrect a dead session. Headless automation runs write no resurrect env.
      const mcpFile = this.writeSessionFile(o.id, 'mcp.json', mcpJson);
      if (mcpFile) env.MCP_CONFIG = mcpFile;
      const companyFile = this.writeSessionFile(o.id, 'company.md', companyMd);
      if (companyFile) env.COMPANY_FILE = companyFile;
      if (!o.headless) this.writeEnvFile(o.id, env);
      this.backend.spawn(this.spaceFor(o.actingMember ?? o.spawnedBy), { sessionId: o.id, agent: o.agent, tmuxName: tmux, env, argv: ['bash', this.launcher] });
    }
  }

  /**
   * Deliver a thread follow-up to a LIVE resident chat session by typing it into the running claude
   * (tmux send-keys) — the warm, fast path (no cold reload). Bumps the idle clock. Returns false when
   * the session isn't a live resident or the keystrokes couldn't be delivered (caller then revives).
   *
   * Turn-state check: typing into a claude TUI is always safe — an idle claude runs the message now, a
   * BUSY (mid-turn) claude QUEUES it and drains it at the next turn boundary (verified against the live
   * TUI: mid-turn keystrokes land as "queued messages", they never interrupt). We deliver in every case
   * because that queueing is exactly the hand-off we want; but we now resolve WHICH state we delivered
   * into and record it, so the reliance on claude's queue is intentional and auditable — not incidental.
   * The one authoritative state is `blocked` (a pending ask/approval whose turn can't end until a human
   * responds, so the follow-up necessarily queues behind it); idle-vs-generating is a best-effort pane
   * read that only labels the audit and never gates delivery.
   */
  deliverToResident(sessionId: string, text: string): boolean {
    const row = this.db.prepare('SELECT tmux, status, resident, run_as, spawned_by FROM term_sessions WHERE id = ?')
      .get<{ tmux: string; status: string; resident: number; run_as: string | null; spawned_by: string | null }>(sessionId);
    if (!row || !row.resident || row.status !== 'running') return false;
    if (!this.isAlive(sessionId)) return false;
    const body = (text || '').replace(/\r?\n+/g, ' ').trim(); // one-line: a stray newline would submit early
    if (!body) return false;
    const space = this.spaceFor(row.run_as ?? row.spawned_by);
    const turn: 'idle' | 'busy' | 'blocked' | 'unknown' =
      this.hasPendingHumanBlock(sessionId) ? 'blocked' : this.residentTurnState(space, row.tmux);
    const ok = this.backend.injectText(space, row.tmux, body, true);
    if (ok) {
      this.db.prepare('UPDATE term_sessions SET last_activity = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), sessionId);
      const agent = this.sessionAgent(sessionId) ?? '';
      // `queued` = the message will wait for claude to finish the current turn before it's read.
      this.audit(sessionId, agent, 'chat.delivered', { chars: body.length, turn, queued: turn === 'busy' || turn === 'blocked' });
    }
    return ok;
  }

  /**
   * Best-effort read of a live resident's turn state from its pane: 'busy' while a turn is generating
   * (claude renders a live token/elapsed counter, an "esc to interrupt" hint, or shows follow-ups already
   * queued behind the running turn), else 'idle', and 'unknown' when the pane can't be read (the launcher
   * backend / an unreachable socket → capturePane returns null). This is a HEURISTIC on claude's TUI
   * chrome, so it only LABELS the audit in `deliverToResident` — no behaviour depends on it (a follow-up
   * is safe to type in any state; claude runs it when idle and queues it when busy).
   */
  private residentTurnState(space: string, tmux: string): 'idle' | 'busy' | 'unknown' {
    const pane = this.backend.capturePane(space, tmux);
    if (pane == null) return 'unknown';
    // Any one of: the "esc to interrupt" hint, the live "↓ N tokens" counter, an elapsed "(12s …)" timer
    // beside the spinner, or follow-ups already "queued messages" behind the running turn. A finished
    // turn's summary line (e.g. "Cooked for 13s", no parens) is deliberately NOT matched.
    if (/esc to interrupt|·\s*↓\s*[\d.]+\s*tokens?|queued messages?|\(\d+\s*s(\s|·|\))/i.test(pane)) return 'busy';
    return 'idle';
  }

  /**
   * Revive a reaped/ended resident chat session IN PLACE: flip the row back to running and re-launch the
   * claude-code runtime under the SAME id/tmux/claude-session, resuming the transcript and seeded with the
   * new message. Keeps ONE session row per thread across idle gaps (no new list entry). Returns false if
   * the session can't be revived (unknown, still alive, or non-resumable).
   */
  reviveResident(sessionId: string, text: string, runAs?: string): boolean {
    const row = this.db.prepare('SELECT agent, secret, claude_session_id, run_as, spawned_by, status FROM term_sessions WHERE id = ?')
      .get<{ agent: string; secret: string | null; claude_session_id: string | null; run_as: string | null; spawned_by: string | null; status: string }>(sessionId);
    if (!row || !row.claude_session_id) return false;
    if (this.isAlive(sessionId)) return false; // caller should have delivered instead
    const body = (text || '').trim();
    if (!body) return false;
    const actingMember = runAs ?? row.run_as ?? undefined;
    const hasSlack = !!this.db.prepare('SELECT 1 FROM slack_threads WHERE session_id = ?').get(sessionId);
    const hasDiscord = !!this.db.prepare('SELECT 1 FROM discord_threads WHERE session_id = ?').get(sessionId);
    this.db.prepare("UPDATE term_sessions SET status = 'running', resident = 1, task = ?, run_as = ?, last_activity = ?, updated_at = ? WHERE id = ?")
      .run(body, actingMember ?? row.run_as ?? null, Date.now(), Date.now(), sessionId);
    this.audit(sessionId, row.agent, 'chat.revived', { runAs: actingMember ?? null });
    this.launchClaudeCode({
      id: sessionId, agent: row.agent, task: body, secret: row.secret ?? randomBytes(24).toString('hex'),
      actingMember, spawnedBy: row.spawned_by ?? undefined, hasSlack, hasDiscord,
      headless: false, resident: true, resume: true, claudeSessionId: row.claude_session_id,
    });
    return true;
  }

  /**
   * "Take over" an unattended run: CLAIM its live, attachable TUI so a human can watch and steer — with
   * ZERO disruption. Unattended automation/task runs are now a real interactive claude in a detached tmux
   * pane (not `claude -p`), so there is nothing to kill and nothing to resume: we just mark the row claimed
   * and the caller attaches to the still-streaming pane. Claiming makes the session STICKY — the turn-end
   * (`markTurnIdle`) and idle-backstop reapers leave a claimed run alone, so it keeps its TUI instead of
   * being auto-closed when it next goes idle. Also flips `headless → 0` (it is now attended) and clears any
   * stay-stopped sentinel so a re-open resurrects cleanly. Idempotent: claiming an already-claimed or an
   * interactive session is a no-op success. Returns an error only for an unknown / non-claude-code run.
   */
  claimSession(sessionId: string, by: string): { ok: boolean; error?: string } {
    const row = this.db.prepare('SELECT agent, claimed_by FROM term_sessions WHERE id = ?')
      .get<{ agent: string; claimed_by: string | null }>(sessionId);
    if (!row) return { ok: false, error: 'unknown session' };
    // Only the real claude-code runtime has an attachable governed TUI; a mock/other runtime has nothing to take over.
    const manifest = this.os.agents.get(row.agent);
    if (manifest?.runtime !== 'claude-code' || !manifest.dir) return { ok: false, error: 'only claude-code sessions can be taken over' };
    if (row.claimed_by) return { ok: true }; // already taken over — the pane is already sticky/attachable
    // A prior stop must not veto the deliberate take-over; clear any sentinel so a re-open resurrects.
    this.allowResume(sessionId);
    // Force status back to 'running' (like markResumed does for the resume path). A take-over can race the
    // Stop-hook turn-end teardown, which may have already flipped an unattended run to 'done'; without this,
    // the claimed run keeps a terminal status and everything gated on `status === 'running'` — notably
    // attachFile ("session is not live") — wrongly rejects the now-attached, steerable session. The sentinel
    // is already cleared above, so a re-open resurrects the pane; 'running' is the one flag resume set that
    // claim was missing.
    this.db.prepare("UPDATE term_sessions SET headless = 0, status = 'running', claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ?")
      .run(by, Date.now(), Date.now(), sessionId);
    // No kill, no relaunch — the live pane keeps streaming; the caller opens ttyd and attaches to it.
    this.audit(sessionId, by, 'session.claimed', { agent: row.agent });
    return { ok: true };
  }

  /**
   * Idle reaper (run from the process-wide 60s sweep in server.ts). Two jobs, one pass; never throws:
   *
   *  1. RESIDENT (warm chat) sessions whose last turn is older than the configured timeout
   *     (Settings → Integrations; default 30 min) → killed, row → `stopped`, revivable on a later reply.
   *     `timeoutMin = 0` disables residence → reap all now.
   *
   *  2. UNATTENDED backstop — the safety net for the Stop-hook fast path (`markTurnIdle`). An
   *     automation/task run is now an attachable interactive TUI, torn down at turn-end by the Stop
   *     beacon; if that beacon never lands (transport failure), or a human attached then detached without
   *     a further turn, the run would linger. So we also reap unattended (`headless=1`, non-resident,
   *     UNCLAIMED) running rows that have SEEN at least one turn-end beacon (`last_activity` stamped, so we
   *     never touch a mid-first-turn long run) and have been idle past the same timeout with NO client
   *     attached and no pending human block.
   */
  reapIdleSessions(): void {
    const timeoutMin = this.os.settings.chatIdleTimeoutMinutes();
    const cutoff = timeoutMin > 0 ? Date.now() - timeoutMin * 60_000 : Date.now() + 1; // 0 → reap all now

    // (1) resident warm-chat idle reap — unchanged behavior.
    const residents = this.db.prepare("SELECT id, tmux, run_as, spawned_by, agent FROM term_sessions WHERE resident = 1 AND status = 'running' AND COALESCE(last_activity, created_at) < ?")
      .all<{ id: string; tmux: string; run_as: string | null; spawned_by: string | null; agent: string }>(cutoff);
    for (const r of residents) {
      try {
        this.backend.kill(this.spaceFor(r.run_as ?? r.spawned_by), r.tmux);
        this.db.prepare("UPDATE term_sessions SET status = 'stopped', updated_at = ? WHERE id = ?").run(Date.now(), r.id);
        this.cancelPendingQuestions(r.id, 'system');
        this.cancelPendingApprovals(r.id, 'system');
        // A reaped session must stay reaped — otherwise ttyd's reconnect on the still-open tab would
        // resurrect it and defeat the reap. A later Slack reply still revives it (a fresh session), and a
        // deliberate console re-open clears the block.
        this.blockResume(r.id);
        this.audit(r.id, r.agent, 'chat.reaped', { idleMin: timeoutMin });
      } catch { /* one bad row must not stop the sweep */ }
    }

    // (2) unattended backstop — the safety net for markTurnIdle. Two ways an unattended run leaks a live pane:
    //   (a) DONE ORPHAN — it ended via `report`, which flips the row to 'done' before the Stop beacon lands, so
    //       markTurnIdle used to bail. Its pane must die regardless of idle time; a done run should hold no TUI.
    //       (markTurnIdle now reaps these directly; this sweep also clears any that predate the fix or whose
    //       Stop beacon never landed.) Only detectable when we can poll liveness (see below).
    //   (b) IDLE STRAGGLER — still 'running' with a turn-end beacon seen (`last_activity` set) and idle past the
    //       timeout: the classic case where the Stop beacon was lost or a human attached then detached.
    // `aliveNames()` returns the live tmux set, or NULL when the backend can't report liveness (the Linux
    // LauncherSessionBackend always; a transient local poll failure). When we CAN poll, gate on true pane
    // liveness so a cleanly-reaped row is never re-killed / re-audited on a later tick (a `done` row keeps its
    // status forever once torn down) — this is what lets us sweep 'done' orphans safely. When we CAN'T, fall
    // back to the classic time-based rule for RUNNING rows only (never blind-sweep a 'done' row, or we'd
    // re-teardown it every tick with no way to know its pane already died).
    const alive = this.backend.aliveNames();
    const unattended = this.db.prepare("SELECT id, tmux, run_as, spawned_by, agent, status, last_activity FROM term_sessions WHERE headless = 1 AND resident = 0 AND claimed_by IS NULL AND status IN ('running','done')")
      .all<{ id: string; tmux: string; run_as: string | null; spawned_by: string | null; agent: string; status: string; last_activity: number | null }>();
    for (const r of unattended) {
      try {
        if (alive) {
          if (!alive.has(r.tmux)) continue;                          // pane already gone — nothing to reap
          // a 'running' straggler is only idle-reaped once it has seen a turn-end beacon AND gone quiet past the
          // cutoff; a 'done' orphan is reaped on sight — it should never still be holding an interactive pane.
          if (r.status === 'running' && (r.last_activity == null || r.last_activity >= cutoff)) continue;
        } else {
          // no liveness signal: classic straggler rule, running-only, so we can't re-sweep a done row blind.
          if (r.status !== 'running' || r.last_activity == null || r.last_activity >= cutoff) continue;
        }
        const space = this.spaceFor(r.run_as ?? r.spawned_by);
        if (this.backend.hasClient(space, r.tmux) === true) continue; // a human is still watching — leave it
        if (this.hasPendingHumanBlock(r.id)) continue;               // blocked on an answer/approval — keep alive
        this.teardownUnattended(r.id, space, r.tmux, r.status === 'done' ? 'done-orphan' : 'idle-backstop');
      } catch { /* one bad row must not stop the sweep */ }
    }
  }

  /**
   * Stop-hook fast path (POST /api/turn-idle, fired by terminal/stop-hook.sh when claude finishes a turn).
   * For an UNATTENDED run this is the normal end-of-run teardown: if no human has claimed or is watching it
   * and it isn't blocked on a person, close it NOW — capture the transcript, mark it done, kill the pane so
   * the automations pile-up guard releases immediately (parity with the old `claude -p` exit). Otherwise
   * (claimed / attached / blocked) it stays a live TUI; we only stamp the turn-end time so the idle backstop
   * has a clock. No-op for interactive/resident runs.
   *
   * We accept a status of BOTH 'running' AND 'done': an agent that ends by calling `report` (the fleet's
   * automation prompts all do) flips its row to 'done' MID-turn, so by the time this turn-end beacon lands
   * the status is already terminal — but the interactive TUI pane is still live and MUST be reaped, else it
   * leaks a claude process forever (the row reads `done` while its pane keeps running). Before the fix this
   * bailed on `status !== 'running'` and orphaned every report-ended unattended run. A truly torn-down run
   * (pane already gone) is skipped via the liveness poll below, so a stray second beacon can't re-reap.
   */
  markTurnIdle(sessionId: string): void {
    const r = this.db.prepare('SELECT tmux, status, headless, resident, claimed_by, run_as, spawned_by FROM term_sessions WHERE id = ?')
      .get<{ tmux: string; status: string; headless: number; resident: number; claimed_by: string | null; run_as: string | null; spawned_by: string | null }>(sessionId);
    if (!r || !r.headless || r.resident) return;                       // only unattended, non-resident runs
    if (r.status !== 'running' && r.status !== 'done') return;         // stopped/crashed are already torn down
    // Record the turn-end time regardless of the decision below — it's the idle backstop's clock and the
    // signal that this run has completed at least one turn (so the backstop won't reap a mid-turn run).
    this.db.prepare('UPDATE term_sessions SET last_activity = ? WHERE id = ?').run(Date.now(), sessionId);
    if (r.claimed_by) return;                       // taken over → sticky, the human owns its lifecycle
    if (this.hasPendingHumanBlock(sessionId)) return; // waiting on an answer/approval → keep the pane alive
    const space = this.spaceFor(r.run_as ?? r.spawned_by);
    const alive = this.backend.aliveNames();
    if (alive && !alive.has(r.tmux)) return;         // pane already gone (already reaped) — nothing to do
    if (this.backend.hasClient(space, r.tmux) === true) return; // a human is watching live → don't close on them
    this.teardownUnattended(sessionId, space, r.tmux, 'turn-end');
  }

  /** Close a finished unattended run: snapshot its pane for the console transcript view, mark it done
   *  (blocks resurrection + writes the episode), then kill the pane so tmux drops and the pile-up guard
   *  releases. Shared by the Stop-hook fast path and the idle backstop. */
  private teardownUnattended(sessionId: string, space: string, tmux: string, reason: string): void {
    this.captureTranscript(sessionId, space, tmux);
    this.markEnded(sessionId);   // status → done (if still running), blockResume, writeEpisode
    this.backend.kill(space, tmux);
    this.audit(sessionId, 'system', 'session.reaped', { reason });
  }

  /** Is this session blocked on a human right now (a pending question OR a pending approval)? Used to
   *  keep an unattended run's pane alive while it legitimately waits, instead of reaping mid-`ask`. */
  private hasPendingHumanBlock(sessionId: string): boolean {
    const q = this.db.prepare("SELECT 1 FROM questions WHERE run_id = ? AND status = 'pending' LIMIT 1").get(sessionId);
    if (q) return true;
    return this.os.approvals.pending(this.os.tenant).some((a) => a.runId === sessionId);
  }

  /** Snapshot a live pane's scrollback to `<connectors>/session-<id>.log` (0600) so the console's
   *  transcript view survives the pane being killed — the replacement for the old headless `-p` tee.
   *  Best-effort: no paths, an unreachable socket, or a launcher backend (capturePane → null) → skip. */
  private captureTranscript(sessionId: string, space: string, tmux: string): void {
    if (!this.os.paths) return;
    try {
      const text = this.backend.capturePane(space, tmux);
      if (text == null) return;
      fs.mkdirSync(this.os.paths.connectors, { recursive: true }); // the dir exists once a session wrote its .mcp.json, but don't depend on it
      fs.writeFileSync(path.join(this.os.paths.connectors, `session-${sessionId}.log`), text, { mode: 0o600 });
    } catch { /* transcript capture is a nicety — never block teardown */ }
  }

  /** `{ AOS_URL, SESSION, AGENT, TASK_B64, AOS_SECRET }` — the base env every runner/launcher inherits. */
  private sessionEnv(id: string, agent: string, task: string, secret: string): Record<string, string> {
    const env: Record<string, string> = {
      AOS_URL: this.baseUrl,
      AOS_TENANT: this.os.tenant, // routes loopback agent calls to THIS tenant's runtime (multi-tenant)
      SESSION: id,
      AGENT: agent,
      TASK_B64: Buffer.from(task, 'utf8').toString('base64'),
      AOS_SECRET: secret,
    };
    // Under the launcher, the systemd-run scope starts with a minimal PATH; seed it with the dir that
    // holds this app's node (claude is usually installed alongside it) plus the standard bins. Flag
    // off we leave PATH untouched so the session inherits the app's richer environment as before.
    if (this.uidIsolation) env.PATH = `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
    return env;
  }

  /**
   * Verify the per-session bearer (0d) presented by a loopback agent call. Fails closed when the
   * session has a secret and the caller's doesn't match; fails OPEN for legacy sessions minted before
   * 0d (secret IS NULL) so a deploy doesn't brick in-flight sessions. Unknown session → false.
   */
  verifySessionSecret(sessionId: string, provided: string): boolean {
    const r = this.db.prepare('SELECT secret FROM term_sessions WHERE id = ?').get<{ secret: string | null }>(sessionId);
    if (!r) return false;
    if (!r.secret) return true; // pre-0d session — no secret was minted; don't break it
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(r.secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Does a session with this id exist? (Authorises the session-scoped /api/memory routes.) */
  hasSession(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM term_sessions WHERE id = ?').get(id);
  }

  /** The agent a session belongs to — the authoritative namespace for its memory. */
  sessionAgent(id: string): string | undefined {
    return this.db.prepare('SELECT agent FROM term_sessions WHERE id = ?').get<{ agent: string }>(id)?.agent;
  }

  /** The member id a session acts as (run-as), if any — so a deferred task it schedules runs as the
   *  same identity. NULL for company-identity runs. */
  sessionRunAs(id: string): string | undefined {
    return this.db.prepare('SELECT run_as FROM term_sessions WHERE id = ?').get<{ run_as: string | null }>(id)?.run_as ?? undefined;
  }

  /** The pinned claude transcript id for a session — so a self-scheduled follow-up can `--resume` this
   *  same conversation (context continuity) instead of starting fresh. */
  sessionClaudeId(id: string): string | undefined {
    return this.db.prepare('SELECT claude_session_id FROM term_sessions WHERE id = ?').get<{ claude_session_id: string | null }>(id)?.claude_session_id ?? undefined;
  }

  /** Resolve a tmux session name (`aos-xxxx`) to its session id — for the terminal-attach authz check. */
  sessionIdByTmux(tmux: string): string | undefined {
    return this.db.prepare('SELECT id FROM term_sessions WHERE tmux = ?').get<{ id: string }>(tmux)?.id;
  }

  /**
   * Ensure the per-session data dir exists and is owner-only (0700). It holds the materialised
   * `session-*.mcp.json` (connector secrets), company context, the resurrect env, and headless
   * transcripts — none of which any other OS account should read. Best-effort: never fail a launch.
   */
  private ensureSecureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, 0o700); } catch { /* best-effort */ }
  }

  /** Write a per-session file as 0600 (carries secrets / transcript content — never world-readable). */
  private writeSecret(file: string, content: string): void {
    fs.writeFileSync(file, content, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
  }

  /** Materialise a per-session file in the app's connectors dir (0600) and return its path, or '' when
   *  there's no data home. Used for the flag-OFF (local) path; the launcher writes its own copies in
   *  the member home under flag-on. */
  private writeSessionFile(sessionId: string, ext: string, contents: string): string {
    if (!this.os.paths || !contents) return '';
    const dir = this.os.paths.connectors;
    this.ensureSecureDir(dir);
    const file = path.join(dir, `session-${sessionId}.${ext}`);
    this.writeSecret(file, contents);
    return file;
  }

  /** The workspace Company context markdown (or '' if unset) — appended to claude's system prompt.
   *  We tack on OS-owned operating notes after the user's content. The terminal here is a browser
   *  xterm (over ttyd) running the TUI on the alternate screen with mouse reporting on, so embedded
   *  terminal hyperlinks (OSC 8) aren't clickable — the agent must surface raw URLs as plain text. */
  private buildCompanyMd(selfAgent?: string, actingMember?: string): string {
    const company = this.os.settings.company().companyMd.trim();
    // Per-member personal context: free-text the human you run AS chose to inject into their sessions
    // (their working style, standing preferences, domain notes). Self-service, owner-scoped — set on
    // the Profile page. Only present when acting as a real member who wrote something.
    let memberCtx = '';
    if (actingMember) {
      const ctx = this.os.team.memberContext(actingMember).trim();
      if (ctx) {
        const who = this.os.team.getMember(actingMember)?.name || 'the person you run as';
        memberCtx =
          `# Personal context from ${who} — the person you are running as\n\n` +
          `${who} added this to steer sessions run on their behalf. Treat it as their standing ` +
          'preferences and instructions for how you work for them, secondary to the task at hand and ' +
          'these operating notes.\n\n' +
          ctx;
      }
    }
    // Close the self-learning loop: the Dreamer's distilled guidance rides in every agent's prompt, so
    // the fleet's accumulated experience shapes each new session. Toggleable in Settings → Self-learning.
    const learned = this.os.settings.applyLearnings() ? this.os.settings.learnedGuidance().trim() : '';
    // The fleet roster — WHO this agent can delegate to. Injected so "hand off to the right agent" is
    // answerable straight from the prompt without a discovery round-trip (`list_agents` is the live
    // equivalent). Excludes self and mock agents, so it only lists peers this agent can actually dispatch.
    const roster = [...this.os.agents.values()]
      .filter((a) => a.runtime === 'claude-code' && a.id !== selfAgent)
      .map((a) => `- \`agent:${a.id}\`${a.category ? ` (${a.category})` : ''} — ${a.description}`)
      .join('\n');
    const fleet = roster
      ? '# Your fleet — who you can delegate to\n\n' +
        'These are the other agents in this workspace. To hand work to one, `task_create({ title, ' +
        'assignee: "agent:<id>", autoDispatch: true })` — it spawns that agent as a governed run under ' +
        'the same accountable human. Assign specialised work to the right agent rather than doing it ' +
        'poorly yourself or filing an unassigned task (which nobody picks up).\n\n' +
        roster
      : '';
    // The team roster — WHO this agent works for and with. Injected so an agent can loop in the right
    // person (roles set who can approve what) without a `directory_lookup` round-trip. Capped: past a
    // small team it stays tool-only, so a big org doesn't bloat every prompt.
    const members = this.os.team.listMembers();
    const TEAM_CAP = 30;
    const teamList = members.length && members.length <= TEAM_CAP
      ? members
          .map((m) => {
            const ids = this.os.team.externalIdsFor(m.id).map((i) => `${i.provider}:${i.externalId}`).join(', ');
            return `- ${m.name} (${m.role}) — ${m.email}${ids ? ` — ${ids}` : ''}`;
          })
          .join('\n')
      : '';
    const team = teamList
      ? '# Your team — the people in this workspace\n\n' +
        'The humans you work for and with. Roles set who can approve what: **owner** approves anything, ' +
        '**admin** approves most, **member** runs only assigned agents. Use `ask` to get a decision or ' +
        'sign-off from the right person; `directory_lookup` returns this same list with more on how to ' +
        'reach each one (Slack/Discord/email).\n\n' +
        teamList
      : members.length > TEAM_CAP
        ? `# Your team\n\n${members.length} people are on the team — use \`directory_lookup\` to find someone by name or email.`
        : '';
    // Native Slack/Discord are wired directly into the OS (they post as the company bot via the
    // `slack_*`/`discord_*` tools). When a platform is configured, steer the agent to those FIRST —
    // otherwise a claude reaching for chat defaults to a Composio Slack/Discord action. Only listed
    // per-platform when actually configured, so we never advertise a tool the session doesn't have.
    const chatLines: string[] = [];
    if (this.os.settings.slackConfigured())
      chatLines.push(
        '- **Slack** is native — use `slack_send` (any channel), `slack_dm` (any person), and ' +
          '`slack_reply` (the thread that triggered you). Do NOT use a Composio Slack action for this.',
      );
    if (this.os.settings.discordConfigured())
      chatLines.push(
        '- **Discord** is native — use `discord_send` (any channel), `discord_dm` (any person), and ' +
          '`discord_reply` (the message that triggered you). Do NOT use a Composio Discord action for this.',
      );
    const messaging = chatLines.length
      ? '# Messaging — use the native integration first\n\n' +
        'These channels are wired directly into Agent OS: the built-in tools post as the company bot, ' +
        'need no channel setup, and are the supported path. Reach for the native tool first; fall back to ' +
        'a Composio action only if no native tool covers what you need.\n\n' +
        chatLines.join('\n')
      : '';
    // Per-member git steer: when this run acts AS a person who hasn't linked their own GitHub, tell the
    // agent how to fix git attribution — so a session that needs to push/PR points the human at the
    // 1-click connect (or at an owner/admin, if the workspace App isn't set up yet) instead of silently
    // committing as a shared bot (or failing auth). Only when acting as a real member, and only the
    // actionable case (not connected) — a connected member's token is injected and just works.
    let github = '';
    if (actingMember) {
      const gh = new GithubIdentity(this.os);
      if (!gh.load(actingMember)) {
        const who = this.os.team.getMember(actingMember)?.name || 'the person you run as';
        github = gh.configured()
          ? '# Git identity — you are not yet acting as a person on GitHub\n\n' +
            `You are running as **${who}**, who hasn't linked their GitHub account — so any \`git push\` or ` +
            'pull request would be authored by the shared workspace app, not them. If this task involves ' +
            'committing code or opening a PR, use `ask` to tell them to connect their GitHub in one click: ' +
            '**Connections → Connected → Mine → Connect GitHub**. Once they do, commits land under their own name.'
          : '# Git identity — GitHub is not set up for this workspace\n\n' +
            "No company GitHub App is configured, so `git`/`gh` can't act as a specific person (a push would " +
            'use the shared bot token if one exists, else fail to authenticate). If this task needs to push ' +
            'code or open a PR, use `ask` to have an owner or admin set up the GitHub App in one click ' +
            `(**Connections → Creds → GitHub → Create GitHub App**), then ask **${who}** to connect their account.`;
      }
    }
    // Launch-time recall preamble (Settings → Memory, off by default): seed the prompt with this
    // agent's most salient memories so a cold session isn't blind, instead of relying on it to call
    // `recall`. Reads the local `memories` ledger directly (node:sqlite is synchronous) — the same
    // store recall ranks over. Best-effort: never let a preamble query block a launch.
    let preamble = '';
    const preload = this.os.settings.memoryConfig()?.preload;
    if (preload?.enabled && selfAgent) {
      const n = Math.max(1, Math.min(Math.floor(preload.count ?? 8), 25));
      try {
        const rows = this.db
          .prepare(
            `SELECT content FROM memories
             WHERE tenant = ? AND (scope = 'tenant' OR (scope = 'agent' AND agent_id = ?))
             ORDER BY COALESCE(importance, 0.5) DESC, COALESCE(last_recalled_at, created_at) DESC
             LIMIT ?`,
          )
          .all<{ content: string }>(this.os.tenant, selfAgent, n);
        if (rows.length)
          preamble =
            '# What you already know — your most salient memories\n\n' +
            "Surfaced from your persistent memory so you don't start blind. This is a HEAD START, not the " +
            'whole picture — `recall` for more on any specific topic before non-trivial work.\n\n' +
            rows.map((r) => `- ${r.content.replace(/\s+/g, ' ').trim()}`).join('\n');
      } catch {
        /* preamble is best-effort; a query failure must never block a session launch */
      }
    }
    // The strategic layer — the active company goals this agent's work should ladder up to. Injected so
    // "why am I doing this" is answerable straight from the prompt (goal_list is the live equivalent).
    // Human-owned; toggleable in Settings. Capped so a long goal list can't dominate every prompt.
    let goalsSection = '';
    if (this.os.settings.injectGoals()) {
      const active = this.os.goals.active(this.os.tenant).slice(0, 12);
      if (active.length) {
        goalsSection =
          '# Company goals — the direction your work serves\n\n' +
          'These are the active goals the whole fleet is working toward. Keep them in mind when you pick ' +
          'up or file work: prefer tasks that advance a goal, and link work to one where it fits ' +
          '(`goal_list` shows them live). You can `goal_propose` a new goal for a human to approve — you ' +
          'cannot activate or edit one yourself.\n\n' +
          active
            .map((g) => `- ${g.title}${g.target ? ` — target: ${g.target}` : ''}${g.body ? `\n  ${g.body.replace(/\s+/g, ' ').trim().slice(0, 200)}` : ''}`)
            .join('\n');
      }
    }
    return [company, memberCtx, AGENT_OS_OPERATING_NOTES, messaging, github, goalsSection, fleet, team, preamble, learned]
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Build the per-session `.mcp.json` payload (enabled connectors bound to the spawning member + the
   * OS-owned memory server) and return it as a JSON string. The backend materialises it where the
   * session can read it: the app's connectors dir (local), or the member's home (launcher). The
   * memory server is ALWAYS included and scoped to this session+agent. '' when there's no data home.
   */
  private buildMcpConfigJson(sessionId: string, agent: string, actingMember: string | undefined, secret: string, slackReply = false, discordReply = false): string {
    if (!this.os.paths) return '';
    // `actingMember` is the identity the session runs AS (runAs ?? the spawning member). Undefined for a
    // pure automation/system spawn → org + shared connectors only, never a person's private credentials.
    const memberId = actingMember;
    const config = this.os.connectors.mcpConfig(memberId);

    // Connector→vault: any env/header value written as `secret:KEY` (or `secret:PRINCIPAL/KEY`) is a
    // reference, not a literal. Resolve it to the real credential from the encrypted vault HERE, at
    // launch, inside the mediated boundary — so the DB holds only a reference and the plaintext exists
    // only in the connector subprocess's env for the life of the session. An unresolved reference is
    // audited and blanked (never leak the literal `secret:…` marker to the MCP server).
    this.resolveVaultRefs(config.mcpServers, memberId, sessionId, agent);

    // Composio (egress) is driven by the workspace key in Settings → Integrations — NOT by connector
    // rows. When a key is set we mint a fresh Tool Router session for each relevant identity and layer
    // it on. The minted URL still needs the key on the connection (x-api-key) or claude gets 401 and
    // sees zero tools (verified against the live endpoint). A mint failure just drops that one — audited.
    const apiKey = this.os.settings.composioApiKey();
    if (apiKey) {
      // `composio` → the running member's OWN connected apps (their email as user_id); `composio-company`
      // → apps connected under the shared service entity, usable by every agent. Automation/system spawns
      // get only the company entity (no person's personal credentials).
      const sessions = [{ id: 'composio-company', userId: serviceUserId(this.os.tenant), scope: 'company' }];
      if (memberId) sessions.unshift({ id: 'composio', userId: this.composioUserId(memberId, agent), scope: 'personal' });
      for (const s of sessions) {
        const res = mintToolRouterSession(apiKey, s.userId);
        if ('url' in res) {
          config.mcpServers[s.id] = { type: 'http', url: res.url, headers: { [COMPOSIO_KEY_HEADER]: apiKey } };
          this.audit(sessionId, agent, 'connector.minted', { connector: s.id, scope: s.scope, userId: s.userId });
        } else {
          this.audit(sessionId, agent, 'connector.mint.failed', { connector: s.id, scope: s.scope, error: res.error });
        }
      }
    }

    // The OS-owned tool server: recall/remember (memory) + ask (ask-human) + report (completion)
    // + list_capabilities/policy_check (policy preview).
    config.mcpServers.agentos = {
      command: 'node',
      args: [this.memoryMcp],
      // SLACK_REPLY / DISCORD_REPLY: '1' makes the agentos server expose the native `slack_reply` /
      // `discord_reply` tool — only for chat-triggered sessions (which have a bound thread/channel),
      // so other agents aren't cluttered by it. SLACK_EGRESS / DISCORD_EGRESS: '1' expose the proactive
      // `slack_send`/`slack_dm` (and Discord equivalents) whenever the workspace has that platform
      // configured — any session can message a channel/person, not just chat-triggered ones.
      env: {
        AOS_URL: this.baseUrl, AOS_TENANT: this.os.tenant, SESSION: sessionId, AGENT: agent, AOS_SECRET: secret,
        ...(slackReply ? { SLACK_REPLY: '1' } : {}),
        ...(discordReply ? { DISCORD_REPLY: '1' } : {}),
        ...(this.os.settings.slackConfigured() ? { SLACK_EGRESS: '1' } : {}),
        ...(this.os.settings.discordConfigured() ? { DISCORD_EGRESS: '1' } : {}),
        // IMAGE_GEN: '1' exposes `image_generate` when a backend key (OpenRouter/Atlas) is configured.
        ...(this.os.settings.imageGenConfigured() ? { IMAGE_GEN: '1' } : {}),
        // VIDEO_GEN: '1' exposes `video_generate` when a video backend key (fal/Atlas) is configured.
        ...(this.os.settings.videoGenConfigured() ? { VIDEO_GEN: '1' } : {}),
        // VIDEO_UNDERSTAND: '1' exposes `video_understand` (video→text) — needs Atlas (its multimodal LLMs).
        ...(this.os.settings.atlasKey() ? { VIDEO_UNDERSTAND: '1' } : {}),
      },
    };
    return JSON.stringify(config, null, 2);
  }

  /**
   * The `user_id` a Composio session is scoped to. A human spawn → that member's email, so the agent
   * sees exactly the apps that member connected on composio.dev. An automation/system spawn has no
   * member, so we fall back to a stable per-agent id (consistent across that agent's runs).
   */
  private composioUserId(memberId: string | undefined, agent: string): string {
    if (memberId) {
      const email = this.os.team.getMember(memberId)?.email;
      if (email) return email;
    }
    return `agent-os:${this.os.tenant}:${agent}`;
  }

  /**
   * Persist a claude-code session's launch env as a sourceable 0600 `session-<id>.env`, so the ttyd
   * attach wrapper (terminal/attach.sh) can resurrect a stopped session and resume the SAME claude
   * session id without involving the server. Carries the per-session secret → never world-readable.
   * Auto-removed with the rest of the session's files by `removeSessionFiles`. No data home → skip.
   */
  private writeEnvFile(sessionId: string, env: Record<string, string>): void {
    if (!this.os.paths) return;
    const dir = this.os.paths.connectors;
    this.ensureSecureDir(dir);
    const body = Object.entries(env).map(([k, v]) => `export ${k}=${shSingleQuote(v)}`).join('\n') + '\n';
    this.writeSecret(path.join(dir, `session-${sessionId}.env`), body);
  }

  /**
   * Sync the global skills library into the agent's `<dir>/.claude/skills/` so the launched claude
   * auto-discovers them (project-level Skills discovery — there's no per-invocation skills flag).
   * Best-effort: a skills failure must never block a session. Hand-authored per-agent skills are
   * preserved (and shadow same-named globals). The audit notes what was applied.
   */
  private materializeSkills(sessionId: string, agent: string, agentDir: string): void {
    try {
      const names = this.os.skills.materialize(path.join(agentDir, '.claude'), agent);
      if (names.length) this.audit(sessionId, agent, 'skills.materialized', { count: names.length, skills: names });
    } catch (e) {
      this.audit(sessionId, agent, 'skills.error', { error: String(e) });
    }
  }

  /**
   * Phase 3 same-session skill delivery. After a skill is installed for `agent` (an approved
   * `skill_request`), push it into that agent's LIVE interactive sessions instead of waiting for their
   * next launch: re-materialise the library into the agent's watched `.claude/skills` (so the new skill
   * lands as a folder claude's file-watcher picks up), then inject `/reload-skills` to force a re-scan +
   * re-surface skill descriptions. Best-effort and non-disruptive to correctness:
   *  - only INTERACTIVE (`headless = 0`) running+alive sessions — those have a live claude REPL we can
   *    send-keys into. This covers both a console-spawned TUI (`resident = 0`) and a chat-continuity
   *    resident session; a headless `claude -p` run has no REPL and exits anyway, so it gets the skill on
   *    its next run (the existing behavior). (Filtering on `resident` here was the bug dogfooding caught:
   *    a console interactive session is `headless = 0, resident = 0`, so it was skipped.)
   *  - the `/reload-skills` inject is gated on `claude` ≥ 2.1.152 — on an older binary we still
   *    re-materialise (the watcher exposes the skill as `/name` next turn), we just skip the forced rescan.
   * Returns how many live sessions were refreshed.
   */
  refreshAgentSkills(agent: string): { reloaded: number } {
    const manifest = this.os.agents.get(agent);
    if (!manifest || manifest.runtime !== 'claude-code' || !manifest.dir) return { reloaded: 0 };
    const rows = this.db
      .prepare(`SELECT id, tmux, run_as, spawned_by FROM term_sessions WHERE agent = ? AND status = 'running' AND headless = 0`)
      .all<{ id: string; tmux: string; run_as: string | null; spawned_by: string | null }>(agent)
      .filter((r) => this.isAlive(r.id));
    if (!rows.length) return { reloaded: 0 };
    // Sync the library (incl. the just-installed skill) into the agent's watched .claude/skills — once;
    // all of the agent's sessions run out of the same folder.
    this.materializeSkills(rows[0].id, agent, manifest.dir);
    if (!claudeSupportsReloadSkills()) return { reloaded: 0 }; // watcher still exposes it next turn
    let reloaded = 0;
    for (const r of rows) {
      if (this.backend.injectText(this.spaceFor(r.run_as ?? r.spawned_by), r.tmux, '/reload-skills', true)) {
        reloaded++;
        this.audit(r.id, agent, 'skills.reloaded', { agent });
      }
    }
    return { reloaded };
  }

  say(sessionId: string, body: string): void {
    const s = this.db.prepare('SELECT agent FROM term_sessions WHERE id = ?').get<{ agent: string }>(sessionId);
    if (!s) return;
    this.addMessage({ type: 'update', sessionId, agent: s.agent, title: `Task Update (${s.agent})`, body, status: 'open', audienceKind: 'sessionOwner', audienceId: sessionId });
  }

  /** The gate. Same policy brain as the console — allow flows, ask → inbox approval (auto-cleared for
   *  an attended approver), never → deny. Args are enriched into facts first (the single classifier). */
  gate(sessionId: string, agent: string, capability: string, rawArgs: Record<string, unknown>, reasoning: string): GateResult {
    // Workspace emergency stop — deny every action before classifying anything.
    if (this.os.settings.killSwitch().engaged) {
      this.audit(sessionId, agent, 'gate.killswitch', { capability });
      return { decision: 'deny' };
    }
    // Host-egress governance (Phase 2b): OFF unless the workspace switch is on. When on, pass the
    // agent's granted host matchers (org + shared + the session's run-as member's personal) so the
    // enricher can parse the egress target and compute host facts. `null` = feature off.
    let hostGrants: { match: string; protocol: 'ssh' | 'http' | 'postgres' | 'any'; posture: 'allow' | 'ask' | 'never' }[] | null = null;
    if (this.os.settings.hostGovernanceEnabled()) {
      const runAs = this.db.prepare('SELECT run_as FROM term_sessions WHERE id = ?').get<{ run_as: string | null }>(sessionId)?.run_as ?? undefined;
      hostGrants = this.os.hosts.grantsFor(runAs);
    }
    const args = enrichArgs(capability, rawArgs, this.emailOrgDomains(), this.os.agents.get(agent)?.dir, this.os.settings.enrichPatterns(), hostGrants);
    // An outbound email is its own governed capability: reclassify so the policy gates it by recipient
    // (internal → green, external → yellow) instead of the generic connector-mutation tier.
    if (args.emailSend === true) {
      capability = 'email.send';
      // Fail-closed (UC5): a session running AS a member must send email from THAT member's own
      // account. Reaching for the COMPANY email tool from a member-scoped run is the silent fallback we
      // must not allow — it means the member's Gmail isn't connected. Deny with a clear reason.
      const emailDenial = this.emailIdentityDenial(sessionId, rawArgs);
      if (emailDenial) {
        this.audit(sessionId, agent, 'gate.email.blocked', { capability, reason: emailDenial, recipients: args.emailRecipients ?? [] });
        this.audit(sessionId, agent, 'gate.decision', { capability, decision: { effect: 'deny', riskClass: 'deny', reason: emailDenial } });
        return { decision: 'deny' };
      }
    }
    // Host egress reclassification (Phase 2b): shell.exec → net.connect / ssh.exec when this command
    // reaches a host we should govern. netMode decides scope: 'allowlist' (lockdown) governs ALL
    // egress; 'open' (default) governs only internal-looking, explicitly-listed, or unpinnable-host
    // reaches — public-internet egress stays plain shell.exec. Host facts (hostAllowed/hostUnknown/
    // hostPosture) ride along in `args` for the net.* policy rules.
    if (hostGrants && args.netEgress === true) {
      const netMode = this.os.agents.get(agent)?.netMode === 'allowlist' ? 'allowlist' : 'open';
      const govern = netMode === 'allowlist'
        ? true
        : (args.hostUnknown === true || args.hostInternal === true || args.hostListed === true);
      if (govern) {
        capability = args.netProtocol === 'ssh' ? 'ssh.exec' : 'net.connect';
        this.audit(sessionId, agent, 'gate.net.reclassified', { capability, host: (args.host as string) ?? null, netMode, hostAllowed: args.hostAllowed === true, hostUnknown: args.hostUnknown === true });
      }
    }
    const attempt: ActionAttempt = { capabilityId: capability, args, reasoning };
    let decision: Decision = this.os.policy.classify(attempt, this.ctx(sessionId, agent));
    // Host governance is applied by the ENGINE (not the editable policy), so enabling it works on any
    // tenant even if its persisted policy predates the host rules. Combine with the policy verdict, most
    // restrictive wins — so the never-tier (`ssh box 'rm -rf /'`) still denies, while an ungranted reach
    // still pauses even when the tenant's policy has no host rule. Only for reclassified host caps.
    if (hostGrants && (capability === 'net.connect' || capability === 'ssh.exec')) {
      decision = stricterDecision(decision, hostGovernanceDecision(capability, args));
    }
    this.audit(sessionId, agent, 'gate.attempt', { capability, args, reasoning });
    this.audit(sessionId, agent, 'gate.decision', { capability, decision });

    if (decision.effect === 'allow') return { decision: 'allow' };
    if (decision.effect === 'deny') return { decision: 'deny' };

    // Context-aware `ask` (governance P5): if an attended human who can approve this level started the
    // run, clear it without a self-addressed card — audited as auto-approved. The never tier (deny)
    // already returned above, so this can never auto-clear an irreversible action.
    const approver = this.attendedApprover(sessionId, decision.level);
    if (approver) {
      this.audit(sessionId, agent, 'approval.auto_approved', { capability, level: decision.level, by: approver.email, reason: decision.reason });
      return { decision: 'allow' };
    }

    const { req, decision: settle } = this.os.approvals.request({
      runId: sessionId,
      tenant: this.os.tenant,
      level: decision.level,
      attempt,
      reason: decision.reason,
    });
    // Address the card to whoever will be pinged: the session owner if they can clear this level,
    // else the approver tier. Card audience == DM audience, so it shows in exactly their "mine" inbox.
    const aud = approvalAudience(this.os, sessionId, decision.level);
    this.addMessage({
      type: 'approval',
      sessionId,
      agent,
      title: `Approval needed — ${capability}`,
      body: reasoning,
      status: 'pending',
      approvalId: req.id,
      capability,
      args,
      level: decision.level,
      audienceKind: aud.kind,
      audienceId: audienceIdOf(aud),
    });
    this.audit(sessionId, agent, 'approval.requested', { approvalId: req.id, level: decision.level, capability });
    // Out-of-band ping (Slack/Discord DM to whoever can approve) — best-effort, never blocks the gate.
    try { this.approvalNotifier?.({ sessionId, agent, capability, level: decision.level, riskClass: decision.riskClass, reason: decision.reason }); } catch { /* notifications are advisory */ }
    // If the run was triggered from chat, surface the gate in that thread too (the approver DM reaches
    // the approver; this reaches everyone watching the thread). No-op for non-chat runs.
    const dot = decision.riskClass === 'red' ? '🔴' : '🟡';
    const inboxLink = consolePage(this.publicOrigin, 'inbox');
    try { this.chatMirror?.(sessionId, (p) => `${dot} ${agent} needs approval — \`${capability}\` (${decision.riskClass.toUpperCase()} · ${decision.level}).\n_why: ${decision.reason}_\nOpen the ${chatLink(p, inboxLink, 'Agent OS Inbox')} to approve or reject.`); } catch { /* advisory */ }

    // The message + gate status are derived from the approvals table at read time, so all this
    // waiter has to do is leave an audit trail. (It won't fire across a restart — that's fine.)
    settle.then((approved) => this.audit(sessionId, agent, 'approval.resolved', { approvalId: req.id, approved }));
    return { decision: 'pending', gateId: req.id };
  }

  /**
   * Agent-facing vault WRITE (the `secret_put` MCP tool) — the A2A credential-handoff primitive.
   * Stores a credential under the SHARED (tenant-wide `*`) scope so any agent in the tenant can later
   * `secret_get` it. Approval-gated through the SAME machinery as {@link gate}: policy classifies
   * `secret.put`, and unless an attended approver clears it, a human must approve before the value is
   * written. Crucially, the plaintext value lives ONLY in this call's memory + the encrypted vault
   * row — it is NEVER passed to the policy args, the approval card, or the audit trail (all of which
   * persist), so a secret cannot leak through the governance planes. Only the KEY is ever recorded.
   * Resolves once the write is settled (stored / denied / errored); like {@link gate} the waiter does
   * not survive a server restart (the agent simply retries).
   */
  async putSecret(
    sessionId: string,
    agent: string,
    key: string,
    value: string,
    reasoning: string,
  ): Promise<{ status: 'stored' | 'denied' | 'error'; detail?: string }> {
    if (this.os.settings.killSwitch().engaged) {
      this.audit(sessionId, agent, 'gate.killswitch', { capability: 'secret.put', key });
      return { status: 'denied', detail: 'workspace emergency stop is engaged' };
    }
    // Gate on the KEY only — the value is deliberately absent from classify/audit/the approval card.
    const attempt: ActionAttempt = { capabilityId: 'secret.put', args: { key }, reasoning };
    const decision: Decision = this.os.policy.classify(attempt, this.ctx(sessionId, agent));
    this.audit(sessionId, agent, 'gate.attempt', { capability: 'secret.put', args: { key }, reasoning });
    this.audit(sessionId, agent, 'gate.decision', { capability: 'secret.put', decision });
    if (decision.effect === 'deny') return { status: 'denied', detail: decision.reason };
    if (decision.effect === 'approve') {
      // Attended owner/admin clears their own write without a self-addressed card (governance P5).
      const approver = this.attendedApprover(sessionId, decision.level);
      if (approver) {
        this.audit(sessionId, agent, 'approval.auto_approved', { capability: 'secret.put', level: decision.level, by: approver.email, reason: decision.reason });
      } else {
        const { req, decision: settle } = this.os.approvals.request({
          runId: sessionId,
          tenant: this.os.tenant,
          level: decision.level,
          attempt,
          reason: decision.reason,
        });
        const aud = approvalAudience(this.os, sessionId, decision.level);
        this.addMessage({
          type: 'approval',
          sessionId,
          agent,
          title: `Approval needed — store secret "${key}"`,
          body: reasoning,
          status: 'pending',
          approvalId: req.id,
          capability: 'secret.put',
          args: { key },
          level: decision.level,
          audienceKind: aud.kind,
          audienceId: audienceIdOf(aud),
        });
        this.audit(sessionId, agent, 'approval.requested', { approvalId: req.id, level: decision.level, capability: 'secret.put' });
        try { this.approvalNotifier?.({ sessionId, agent, capability: 'secret.put', level: decision.level, riskClass: decision.riskClass, reason: decision.reason }); } catch { /* advisory */ }
        const approved = await settle;
        this.audit(sessionId, agent, 'approval.resolved', { approvalId: req.id, approved });
        if (!approved) return { status: 'denied', detail: `approval rejected (${decision.level})` };
      }
    }
    // green (allow) or approved → write the encrypted row under the shared tenant-wide principal.
    try {
      this.os.secrets.set(this.os.tenant, key, value, { principal: '*', updatedBy: `agent:${agent}` });
      this.audit(sessionId, agent, 'secret.put', { key, principal: '*' });
      return { status: 'stored' };
    } catch (e) {
      return { status: 'error', detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Agent-facing vault READ (the `secret_get` MCP tool). Under the shared-scope model any agent in the
   * tenant may read a shared secret, so this is allow-and-audit — but it still runs the policy
   * `classify` so a workspace CAN tighten a specific key to `deny` (a non-allow outcome refuses rather
   * than silently returning; reads must never hang on an approval card). The plaintext is returned to
   * the CALLER only; the audit records the key + whether it resolved, never the value. Widens the
   * agent-scoped principal to the tenant-wide `*` inside the vault, so an agent reads its own value
   * first, then the shared one.
   */
  getSecret(
    sessionId: string,
    agent: string,
    key: string,
  ): { status: 'ok' | 'denied' | 'missing'; value?: string; detail?: string } {
    if (this.os.settings.killSwitch().engaged) return { status: 'denied', detail: 'workspace emergency stop is engaged' };
    const decision = this.os.policy.classify({ capabilityId: 'secret.get', args: { key }, reasoning: '' }, this.ctx(sessionId, agent));
    if (decision.effect !== 'allow') {
      const reason = decision.effect === 'deny' ? decision.reason : 'reading this secret requires approval, which reads do not support';
      this.audit(sessionId, agent, 'secret.get.denied', { key, reason });
      return { status: 'denied', detail: reason };
    }
    const value = this.os.secrets.getSync(this.os.tenant, agent, key);
    this.audit(sessionId, agent, 'secret.get', { key, found: value !== undefined });
    if (value === undefined) return { status: 'missing' };
    return { status: 'ok', value };
  }

  /**
   * Agent-facing vault LISTING (the `secret_list` MCP tool): the shared (tenant-wide `*`) secret KEYS
   * an agent can `secret_get`, as metadata only — never values. Scoped to the shared principal so it
   * surfaces exactly the handoff namespace, not other principals' member-scoped key names.
   */
  listSecrets(): Array<{ key: string; updatedAt: number; updatedBy?: string }> {
    return this.os.secrets
      .list(this.os.tenant)
      .filter((s) => s.principal === '*')
      .map((s) => ({ key: s.key, updatedAt: s.updatedAt, updatedBy: s.updatedBy }));
  }

  /**
   * Dry-run the policy for a hypothetical attempt — the SAME brain the gate uses, but pure: no
   * approval card, no audit, no side effect. Lets an agent learn ahead of time whether an action is
   * allowed / needs approval / denied (via the policy_check + list_capabilities MCP tools), so it can
   * plan instead of discovering its limits only when the gate blocks it. Works for any capability
   * string — classify falls back to the ruleset's default outcome for ones with no matching rule.
   */
  policyCheck(sessionId: string, agent: string, capability: string, args: Record<string, unknown>): Decision {
    if (this.os.settings.killSwitch().engaged) return { effect: 'deny', riskClass: 'deny', reason: 'workspace emergency stop is engaged' };
    const enriched = enrichArgs(capability, args, this.emailOrgDomains(), this.os.agents.get(agent)?.dir, this.os.settings.enrichPatterns());
    const cap = enriched.emailSend === true ? 'email.send' : capability;
    return this.os.policy.classify({ capabilityId: cap, args: enriched, reasoning: '' }, this.ctx(sessionId, agent));
  }

  /**
   * The workspace's internal email domains, for the `email.send` internal/external split. Explicit
   * config (Settings → Governance) wins; when unset, derive from members' OWN email domains (dropping
   * common public mailbox providers), so a company on its own domain gets the internal→green fast path
   * with zero config. Unresolvable (no config, only public-provider members) → empty → every recipient
   * counts as external (the safe default: email leaves the org only after a human approves).
   */
  private emailOrgDomains(): string[] {
    const explicit = this.os.settings.emailOrgDomains();
    if (explicit.length) return explicit;
    const PUBLIC = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com']);
    const domains = new Set<string>();
    for (const m of this.os.team.listMembers()) {
      const at = m.email.lastIndexOf('@');
      const d = at >= 0 ? m.email.slice(at + 1).toLowerCase() : '';
      if (d && !PUBLIC.has(d)) domains.add(d);
    }
    return [...domains];
  }

  /**
   * Fail-closed guard for act-as-member email (UC5). Returns a denial reason, or null to allow. A
   * session that runs AS a specific member may only send email from that member's OWN account: if the
   * agent reaches for the COMPANY Composio email tool from a member-scoped run, the member simply hasn't
   * connected their Gmail, so we refuse rather than silently send from the company identity. Company /
   * automation runs (no run_as member) legitimately use the company account and pass through.
   */
  private emailIdentityDenial(sessionId: string, rawArgs: Record<string, unknown>): string | null {
    const runAs = this.db.prepare('SELECT run_as FROM term_sessions WHERE id = ?').get<{ run_as: string | null }>(sessionId)?.run_as ?? null;
    if (!runAs) return null; // company/automation identity → company email account is correct
    const tool = typeof rawArgs.tool === 'string' ? rawArgs.tool : '';
    if (/composio-company/i.test(tool)) {
      return 'acting as a member — send email from your own connected account, not the company one (the run-as member has no Gmail connected)';
    }
    return null;
  }

  /** Halt every running session (used when the kill switch is engaged with "stop running sessions").
   *  Returns the count halted. Each is stopped via the normal path so its inbox/audit reflect it. */
  stopAllRunning(by: string): number {
    const rows = this.db.prepare("SELECT id FROM term_sessions WHERE status = 'running'").all<{ id: string }>();
    let n = 0;
    for (const r of rows) if (this.stopSession(r.id, by)) n++;
    return n;
  }

  /**
   * The attended approver for the `ask` tier, or null. A run is "attended" when a human member (not an
   * `automation:`) started it; if that member already holds approval authority for `level`, their own
   * recoverable actions clear without a self-addressed card (governance P5). Automation-fired and
   * member-can't-approve runs return null → the normal human approval flow.
   */
  private attendedApprover(sessionId: string, level: ApprovalLevel): Member | null {
    const r = this.db.prepare('SELECT spawned_by FROM term_sessions WHERE id = ?').get<{ spawned_by: string | null }>(sessionId);
    const sb = r?.spawned_by;
    if (!sb || sb.startsWith('automation:')) return null; // unattended / automation → always ask
    const m = this.os.team.getMember(sb);
    const role: Role | undefined = m?.role;
    return m && autoClearsApproval(level, { initiatorRole: role, attended: true }) ? m : null;
  }

  /** Gate status for the PreToolUse hook — derived from the approval's live row. */
  gateStatus(id: string): GateStatus {
    const status = this.os.approvals.statusOf(id);
    if (status === 'approved') return 'allow';
    if (status === 'pending') return 'pending';
    return 'deny'; // rejected, cancelled, or unknown
  }

  private addMessage(m: Omit<FeedMessage, 'id' | 'createdAt'>): void {
    this.db
      .prepare('INSERT INTO messages (id, type, session_id, agent, title, body, status, approval_id, capability, args, level, source, question_id, outcome, audience_kind, audience_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        randomUUID().slice(0, 8), m.type, m.sessionId, m.agent, m.title, m.body, m.status,
        m.approvalId ?? null, m.capability ?? null, m.args !== undefined ? JSON.stringify(m.args) : null,
        m.level ?? null, m.source ?? null, m.questionId ?? null, m.outcome ?? null,
        m.audienceKind ?? null, m.audienceId ?? null, Date.now(),
      );
  }

  /**
   * Post an inbox card for a Tasks event, addressed to an explicit {@link Audience} (the assignee, the
   * owner, …) rather than to a session's viewers — a task has no session, so it uses the `task:<id>`
   * sentinel for `session_id` (no matching term_sessions row → visibility is governed entirely by the
   * audience via `canViewMessageRow`). `args.taskId` deep-links the card to the board. Public so the
   * tenant-registry wiring (the `os.tasks` notifier) can call it.
   */
  postTaskCard(input: { taskId: string; agent: string; title: string; body: string; audience: Audience; event: string }): void {
    this.addMessage({
      type: 'task', sessionId: `task:${input.taskId}`, agent: input.agent, title: input.title,
      body: input.body, status: 'open', args: { taskId: input.taskId, event: input.event },
      audienceKind: input.audience.kind, audienceId: audienceIdOf(input.audience),
    });
  }

  /**
   * Post an inbox card for an agent's goal PROPOSAL (a draft goal an owner/admin must review + activate),
   * addressed to an explicit {@link Audience} (admins). Like {@link postTaskCard} it uses the `goal:<id>`
   * sentinel for `session_id` (no session backs a goal) so visibility is governed by the audience, and
   * `args.goalId` deep-links the card to the Goals page. Public so the loopback propose route can call it.
   */
  postGoalCard(input: { goalId: string; agent: string; title: string; body: string; audience: Audience }): void {
    this.addMessage({
      type: 'goal.proposed', sessionId: `goal:${input.goalId}`, agent: input.agent, title: input.title,
      body: input.body, status: 'open', args: { goalId: input.goalId },
      audienceKind: input.audience.kind, audienceId: audienceIdOf(input.audience),
    });
  }

  // ── session lifecycle → inbox ────────────────────────────────────────────────
  /** Agent asks the human a question (the ask-human channel). Returns the question id to poll. */
  /**
   * The agent posts a blocking question (→ inbox card + out-of-band DM) and polls {@link questionStatus}
   * until answered. By default it's addressed to the session OPERATOR (the `sessionOwner` audience). Pass
   * `to` (a teammate name / email / member id) to route it to a SPECIFIC other member instead — the
   * "ask a teammate for info / a confirmation" channel — and both the inbox card and the DM target them,
   * and {@link canViewQuestion} grants them the answer. Returns `{ error }` when `to` matches no member.
   */
  askQuestion(sessionId: string, agent: string, prompt: string, to?: string): { id?: string; error?: string; to?: string } {
    let target: Member | undefined;
    if (to && to.trim()) {
      target = this.resolveMember(to);
      if (!target) return { error: `no teammate matches "${to}"` };
    }
    const id = randomUUID().slice(0, 8);
    this.db
      .prepare('INSERT INTO questions (id, run_id, tenant, agent, prompt, status, audience_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, this.os.tenant, agent, prompt, 'pending', target?.id ?? null, Date.now());
    // Card audience: the addressed teammate when `to` is set, else the session operator.
    const audienceKind = target ? 'member' : 'sessionOwner';
    const audienceId = target ? target.id : sessionId;
    this.addMessage({ type: 'question', sessionId, agent, title: `Question — ${agent}`, body: prompt, status: 'pending', questionId: id, audienceKind, audienceId });
    this.audit(sessionId, agent, 'question.asked', { questionId: id, prompt, ...(target ? { to: target.id } : {}) });
    // Out-of-band ping (like approvals): DM the person the run acts for — or the addressed teammate — so a
    // blocking `ask` doesn't sit unseen in the console. And if the run was triggered from chat, mirror the
    // question into that thread. Both best-effort, off the hot path.
    try { this.questionNotifier?.({ sessionId, agent, prompt, to: target?.id }); } catch { /* notifications are advisory */ }
    try { this.chatMirror?.(sessionId, (p) => `❓ ${agent} needs your input:\n${prompt}\n\nAnswer in the ${chatLink(p, consolePage(this.publicOrigin, 'inbox'), 'Agent OS Inbox')}.`); } catch { /* advisory */ }
    return { id, to: target?.email };
  }

  /** A human answers a pending question (from the inbox). */
  answerQuestion(id: string, answer: string, by: string): boolean {
    const q = this.db.prepare('SELECT run_id, agent, status FROM questions WHERE id = ?').get<{ run_id: string; agent: string; status: string }>(id);
    if (!q || q.status !== 'pending') return false;
    this.db.prepare('UPDATE questions SET status = ?, answer = ?, answered_by = ?, answered_at = ? WHERE id = ?').run('answered', answer, by, Date.now(), id);
    this.audit(q.run_id, by, 'question.answered', { questionId: id });
    return true;
  }

  /**
   * Cancel a single pending question (the inbox "dismiss" on a question card). Flips it to `cancelled`
   * so the card leaves "Needs you" and becomes a dismissable Activity row — and, since `questionStatus`
   * now reports `cancelled`, a still-live agent's blocking `ask` poll unblocks and proceeds instead of
   * waiting out the hour. No-op unless the question exists and is still pending.
   */
  cancelQuestion(id: string, by: string): boolean {
    const q = this.db.prepare('SELECT run_id, status FROM questions WHERE id = ?').get<{ run_id: string; status: string }>(id);
    if (!q || q.status !== 'pending') return false;
    this.db.prepare("UPDATE questions SET status = 'cancelled', answered_by = ?, answered_at = ? WHERE id = ?").run(by, Date.now(), id);
    this.audit(q.run_id, by, 'question.cancelled', { questionId: id });
    return true;
  }

  /**
   * Cancel every pending question for a session — called when the session stops/crashes/is reaped, so the
   * agent that asked is gone and no one can answer. Leaves the orphaned "Needs you" cards as dismissable
   * `cancelled` Activity rows instead of live prompts that can never be resolved. Returns how many flipped.
   */
  private cancelPendingQuestions(sessionId: string, by: string): number {
    const pending = this.db.prepare("SELECT id FROM questions WHERE run_id = ? AND status = 'pending'").all<{ id: string }>(sessionId);
    if (!pending.length) return 0;
    this.db.prepare("UPDATE questions SET status = 'cancelled', answered_by = ?, answered_at = ? WHERE run_id = ? AND status = 'pending'").run(by, Date.now(), sessionId);
    for (const q of pending) this.audit(sessionId, by, 'question.cancelled', { questionId: q.id, reason: 'session ended' });
    return pending.length;
  }

  /**
   * Cancel every pending approval for a session — the sibling of {@link cancelPendingQuestions}, run
   * when the session stops/crashes/is reaped. The agent blocked on the gate is gone, so an owner
   * approving now would gate an effect no one will ever perform. `Approvals.cancel` marks the row
   * `cancelled` and settles the waiter as denied; the card leaves "Needs you" and becomes a dismissable
   * Activity row. Returns how many were cancelled.
   */
  private cancelPendingApprovals(sessionId: string, by: string): number {
    const pending = this.os.approvals.pending(this.os.tenant).filter((a) => a.runId === sessionId);
    for (const a of pending) {
      this.os.approvals.cancel(a.id, by);
      this.audit(sessionId, by, 'approval.cancelled', { approvalId: a.id, reason: 'session ended' });
    }
    return pending.length;
  }

  /** Question status + answer for the polling ask-human MCP tool. */
  questionStatus(id: string): { status: 'pending' | 'answered' | 'cancelled'; answer?: string } {
    const q = this.db.prepare('SELECT status, answer FROM questions WHERE id = ?').get<{ status: string; answer: string | null }>(id);
    if (!q) return { status: 'pending' };
    if (q.status === 'answered') return { status: 'answered', answer: q.answer ?? undefined };
    if (q.status === 'cancelled') return { status: 'cancelled' };
    return { status: 'pending' };
  }

  /** Claude Code fired a Notification — it's blocked waiting on the human (a permission prompt in the
   *  TUI, or idle waiting for input). Surface ONE per-session alert in the inbox so the console shows a
   *  bell; replace any prior open one so repeated idle pings don't pile up. Only the human-actionable
   *  kinds get a card — auth/elicitation noise is dropped. Best-effort, never blocks (the hook can't). */
  notify(sessionId: string, agent: string, kind: string, message: string): void {
    if (!this.hasSession(sessionId)) return;
    // The human-actionable Notification kinds only: a permission prompt / idle wait in the TUI, or the
    // newer `agent_needs_input` Claude Code emits when it's blocked on the human. Auth/elicitation noise
    // and the per-turn `agent_completed` are dropped here (session completion is signalled by markEnded).
    if (kind !== 'permission_prompt' && kind !== 'idle_prompt' && kind !== 'agent_needs_input') return;
    this.clearNotifications(sessionId);
    const fallback = kind === 'permission_prompt' ? 'Claude needs permission to continue.' : 'Claude is waiting for your input.';
    const body = (message || '').trim() || fallback;
    this.addMessage({ type: 'notification', sessionId, agent, title: `Waiting — ${agent}`, body, status: 'open', audienceKind: 'sessionOwner', audienceId: sessionId });
    this.audit(sessionId, agent, 'session.notified', { kind, message });
    this.fireSessionEvent(sessionId, agent, 'waiting', `Waiting — ${agent}`, body);
  }

  /** Drop any open 'waiting' notification for a session — once it reports/ends, the bell is stale. */
  private clearNotifications(sessionId: string): void {
    this.db.prepare("DELETE FROM messages WHERE session_id = ? AND type = 'notification' AND status = 'open'").run(sessionId);
  }

  /** Agent self-reports a finished task: emits a 'completed' card with outcome + summary. An optional
   *  `lessons` note is the agent's deliberate "encode this for my future self" at the reflective moment
   *  of finishing — stored as a durable semantic memory (distinct from the mechanical end-of-session
   *  episode), so the next run recalls the lesson, not just that a session happened. */
  report(sessionId: string, agent: string, outcome: string, summary: string, lessons?: string): void {
    if (this.hasCompleted(sessionId)) return;
    this.clearNotifications(sessionId);
    this.addMessage({ type: 'completed', sessionId, agent, title: `Completed — ${agent}`, body: summary || '(no summary)', status: 'open', outcome, audienceKind: 'sessionOwner', audienceId: sessionId });
    this.fireSessionEvent(sessionId, agent, 'completed', `Completed — ${agent}`, summary || `Finished (${outcome}).`);
    // Close the chat loop: a chat-triggered run's completion goes back to the thread the human pinged
    // from, not just the console. No-op for non-chat runs. The agent's own `slack_reply`/`discord_reply`
    // still work for finer-grained replies; this guarantees the outcome lands even if it never called them.
    const mark = outcome === 'success' ? '✅' : outcome === 'failure' ? '❌' : '☑️';
    const inboxLink = consolePage(this.publicOrigin, 'inbox');
    try { this.chatMirror?.(sessionId, (p) => `${mark} ${agent} finished (${outcome}).\n${summary || '(no summary)'}\n${chatLink(p, inboxLink, 'Open in Agent OS')}`); } catch { /* advisory */ }
    // Rename the session from the agent's own summary — an AI-written label that reflects what the run
    // actually did, replacing the provisional title (the task text / automation name set at spawn).
    // Claude Code's internal /resume summaries aren't available for governed sessions (headless `-p`
    // never persists one), so the agent's report is the reliable source. Skip when empty so a good
    // title isn't blanked.
    const aiTitle = titleFromSummary(summary);
    if (aiTitle) this.db.prepare("UPDATE term_sessions SET title = ?, status = 'done', updated_at = ? WHERE id = ?").run(aiTitle, Date.now(), sessionId);
    else this.db.prepare("UPDATE term_sessions SET status = 'done', updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
    this.audit(sessionId, agent, 'session.reported', { outcome, summary });
    // Deliberate semantic memory — the agent's note to its future self. Higher importance than an
    // auto-episode (0.7 vs 0.5), private to this agent (broadly-useful facts go via `remember` shared).
    const lesson = (lessons ?? '').trim();
    if (lesson) {
      void this.os.memory
        .store({ tenant: this.os.tenant, agentId: agent, content: lesson, tags: ['lesson', 'session-end'], type: 'Insight', importance: 0.7, metadata: { sessionId, outcome, source: 'report-lesson' } })
        .then(() => this.audit(sessionId, agent, 'lesson.stored', { outcome }))
        .catch((e) => this.audit(sessionId, agent, 'lesson.error', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  /** Agent proposes a new skill (Lever 6 — the fleet drafting its own procedural memory). Drafts a
   *  `.aos-proposed` skill in the library (never materialised until a human publishes it), posts a
   *  'skill.proposed' card to the Inbox so owner/admins see it, and audits `skill.proposed`. Returns
   *  a structured result (name collisions/bad names come back as `ok:false` for the agent to see). */
  proposeSkill(sessionId: string, agent: string, input: { name: string; description: string; body: string; rationale?: string }): { ok: boolean; skill?: string; error?: string } {
    try {
      const s = this.os.skills.propose({ name: input.name, description: input.description, body: input.body, rationale: input.rationale, agent, session: sessionId });
      this.addMessage({
        type: 'skill.proposed', sessionId, agent,
        title: `Skill proposed — ${s.name}`,
        body: (input.description || s.description || `A new skill "${s.name}" is ready for review.`).trim(),
        status: 'open',
        args: { skill: s.name, ...(input.rationale ? { rationale: input.rationale } : {}) },
        // Publishing a skill is an owner/admin act — address the review card to the admin tier so it
        // lands in exactly their inbox (not the running agent's session owner).
        audienceKind: 'admins',
      });
      this.audit(sessionId, agent, 'skill.proposed', { name: s.name, description: s.description, rationale: input.rationale });
      return { ok: true, skill: s.name };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** An agent proposes a Host connection (`host_propose`). Drafts an inactive, credential-less org host
   *  (excluded from every grant set until published), posts a `host.proposed` review card to the
   *  owner/admin inbox, and audits `host.proposed`. Publishing (owner/admin) activates it. */
  proposeHost(sessionId: string, agent: string, input: { name: string; match: string; protocol?: string; posture?: string; rationale?: string }): { ok: boolean; host?: string; error?: string } {
    try {
      const h = this.os.hosts.propose({
        name: input.name,
        match: input.match,
        protocol: input.protocol as never,
        posture: input.posture as never,
        agent: `agent:${agent}`,
        rationale: input.rationale,
      });
      this.addMessage({
        type: 'host.proposed', sessionId, agent,
        title: `Host proposed — ${h.name}`,
        body: `${agent} proposes reaching ${h.match} (${h.protocol}). ${input.rationale ? 'Why: ' + input.rationale : ''}`.trim(),
        status: 'open',
        args: { host: h.id, match: h.match, protocol: h.protocol, ...(input.rationale ? { rationale: input.rationale } : {}) },
        // Publishing a host is an owner/admin act — address the review card to the admin tier.
        audienceKind: 'admins',
      });
      this.audit(sessionId, agent, 'host.proposed', { host: h.id, match: h.match, protocol: h.protocol, rationale: input.rationale });
      return { ok: true, host: h.id };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * The skills an agent could ask to have installed — what `skill_find` returns. `installed` is the
   * tenant's library (each flagged whether it's active for THIS agent, i.e. materialised at launch);
   * `catalog` is the bundled software catalog with an `installed` flag already. Phase 1 covers the
   * catalog + library; remote sources (skills.sh / GitHub) come later. */
  requestableSkills(agent: string): { installed: (SkillSummary & { active: boolean })[]; catalog: CatalogSkill[] } {
    const installed = this.os.skills.list()
      .filter((s) => !s.proposed)
      .map((s) => ({ ...s, active: s.agents.length === 0 || s.agents.includes(agent) }));
    return { installed, catalog: this.os.skills.catalog() };
  }

  /**
   * Agent asks a human to INSTALL an existing skill from the catalog (it never installs itself — the
   * `skill_request` tool). Validates the name against the catalog so a typo fails fast, short-circuits
   * when it's already in the library or already requested, else posts an owner/admin-addressed
   * 'skill.request' card and audits `skill.requested`. The human approves via POST
   * /api/skills/requests/:id/approve, which does the actual install. */
  async requestSkill(sessionId: string, agent: string, input: { name: string; source?: string; rationale?: string }): Promise<{ ok: boolean; status?: 'requested' | 'installed' | 'duplicate'; error?: string }> {
    const name = (input.name || '').trim().toLowerCase();
    if (!name) return { ok: false, error: 'a skill name is required' };
    if (this.os.skills.get(name)) return { ok: true, status: 'installed' }; // already in the library
    let source = (input.source || 'catalog').trim();
    const remote = source !== '' && source !== 'catalog';
    let description = '';
    let path = '';
    if (!remote) {
      source = 'catalog';
      const cat = this.os.skills.catalog().find((c) => c.name === name);
      if (!cat) return { ok: false, error: `"${name}" is not in the skill catalog — call skill_find to see what's installable` };
      description = cat.description;
    } else {
      // Remote source (a GitHub repo, e.g. surfaced by skill_find's `query` search). Resolve it NOW so a
      // typo / missing skill fails fast, and stash the resolved path so approve installs without re-guessing.
      let cat: RemoteCatalog;
      try { cat = await browseRepo(source); }
      catch (e) { return { ok: false, error: `could not read source "${source}": ${e instanceof Error ? e.message : String(e)}` }; }
      const hit = cat.skills.find((s) => s.name === name);
      if (!hit) return { ok: false, error: `no skill named "${name}" in ${cat.repo} — call skill_find with a query to see what's available` };
      source = cat.repo; // normalized owner/repo
      description = hit.description;
      path = hit.path;
    }
    // Dedupe against an already-open request for the same skill from the same source.
    const open = this.db
      .prepare(`SELECT args FROM messages WHERE type = 'skill.request' AND status = 'open'`)
      .all<{ args: string | null }>()
      .some((r) => { try { const a = JSON.parse(r.args || '{}'); return a.skill === name && (a.source || 'catalog') === source; } catch { return false; } });
    if (open) return { ok: true, status: 'duplicate' };
    this.addMessage({
      type: 'skill.request', sessionId, agent,
      title: `Skill requested — ${name}`,
      body: (input.rationale?.trim() || description || `${agent} wants the "${name}" skill installed${remote ? ` from ${source}` : ''}.`).trim(),
      status: 'open',
      args: { skill: name, source, ...(path ? { path } : {}), ...(input.rationale ? { rationale: input.rationale } : {}) },
      // Installing a skill is an owner/admin act — address the review card to the admin tier.
      audienceKind: 'admins',
    });
    this.audit(sessionId, agent, 'skill.requested', { name, source, rationale: input.rationale });
    return { ok: true, status: 'requested' };
  }

  /** Read a 'skill.request' card's payload (for the approve/dismiss routes). undefined if not one.
   *  `source` is 'catalog' or an `owner/repo`; `path` is the skill's folder within a remote repo (empty
   *  for catalog / a name-resolved remote install). */
  skillRequestCard(id: string): { skill: string; source: string; path: string; agent: string; status: string } | undefined {
    const row = this.db
      .prepare(`SELECT agent, args, status FROM messages WHERE id = ? AND type = 'skill.request'`)
      .get<{ agent: string; args: string | null; status: string }>(id);
    if (!row) return undefined;
    let a: Record<string, unknown> = {};
    try { a = row.args ? JSON.parse(row.args) : {}; } catch { /* tolerate a corrupt payload */ }
    return { skill: String(a.skill ?? ''), source: String(a.source ?? 'catalog'), path: String(a.path ?? ''), agent: row.agent, status: row.status };
  }

  /** Mark a 'skill.request' card resolved once a human approved (installed) or dismissed it. */
  setSkillRequestStatus(id: string, status: 'approved' | 'rejected'): void {
    this.db.prepare(`UPDATE messages SET status = ? WHERE id = ? AND type = 'skill.request'`).run(status, id);
  }

  /** Open (unresolved) skill.request cards — the Skills page's agent-request review section. */
  openSkillRequests(): { id: string; skill: string; source: string; agent: string; rationale?: string; createdAt: number }[] {
    return this.db
      .prepare(`SELECT id, agent, args, created_at FROM messages WHERE type = 'skill.request' AND status = 'open' ORDER BY created_at DESC`)
      .all<{ id: string; agent: string; args: string | null; created_at: number }>()
      .map((r) => {
        let a: Record<string, unknown> = {};
        try { a = r.args ? JSON.parse(r.args) : {}; } catch { /* tolerate corrupt payload */ }
        return { id: r.id, skill: String(a.skill ?? ''), source: String(a.source ?? 'catalog'), agent: r.agent, rationale: a.rationale ? String(a.rationale) : undefined, createdAt: r.created_at };
      });
  }

  /** Agent posts a mid-task progress update to the Inbox feed. Unlike the (now removed) spawn/stop/exit
   *  lifecycle cards, this is an agent-authored signal: a short note on what it just did or is about to
   *  do. Flagging it `important` highlights it in the feed — a milestone or heads-up worth the operator's
   *  eye. Each call is its own feed entry (a timeline), never deduped. Empty messages are dropped. */
  progress(sessionId: string, agent: string, message: string, important = false): void {
    const body = (message || '').trim();
    if (!body) return;
    this.addMessage({ type: 'update', sessionId, agent, title: `Update — ${agent}`, body, status: 'open', args: important ? { important: true } : undefined, audienceKind: 'sessionOwner', audienceId: sessionId });
    this.audit(sessionId, agent, 'session.progress', { important, message: body });
  }

  /**
   * Agent deliberately notifies a specific teammate (the `notify` MCP tool) — the "this task needs
   * someone else to know" escape hatch from the session-owner-scoped default. Resolves `to` (a member
   * id, email, or display name), posts an inbox card ADDRESSED to that member (so it lands in their
   * `mine` feed regardless of who owns the session), fires the out-of-band DM sink, and audits it.
   * Never routes to the whole team — one named recipient, deliberately chosen by the agent.
   */
  notifyMember(sessionId: string, agent: string, to: string, message: string, important = false): { ok: boolean; to?: string; error?: string } {
    const body = (message || '').trim();
    if (!body) return { ok: false, error: 'message is required' };
    const target = this.resolveMember(to);
    if (!target) return { ok: false, error: `no teammate matches "${to}"` };
    this.addMessage({
      type: 'update', sessionId, agent, title: `Note from ${agent}`, body, status: 'open',
      args: important ? { important: true } : undefined,
      audienceKind: 'member', audienceId: target.id,
    });
    this.audit(sessionId, agent, 'member.notified', { to: target.id, important, message: body });
    try { this.memberNotifier?.({ sessionId, agent, to: target.id, message: body, important }); } catch { /* advisory */ }
    return { ok: true, to: target.email };
  }

  /** Resolve a person the agent named — by member id, email (case-insensitive), or display name — to a
   *  member. Used by {@link notifyMember}; returns undefined when nothing matches unambiguously. */
  private resolveMember(who: string): Member | undefined {
    const q = (who || '').trim();
    if (!q) return undefined;
    const byId = this.os.team.getMember(q);
    if (byId) return byId;
    const lower = q.toLowerCase();
    const members = this.os.team.listMembers().filter((m) => m.status === 'active');
    return members.find((m) => m.email.toLowerCase() === lower)
        ?? members.find((m) => (m.name ?? '').toLowerCase() === lower);
  }

  /**
   * Agent publishes a deliverable to the gallery: snapshots a file from its working folder, records
   * it with full provenance (the session's spawned_by → `source`), posts an 'artifact' inbox card,
   * and audits it. The file path is resolved STRICTLY under the agent's own folder by the store.
   */
  publishArtifact(sessionId: string, input: { path: string; title?: string; description?: string; folder?: string }): { ok: boolean; id?: string; error?: string } {
    const agent = this.sessionAgent(sessionId);
    if (!agent) return { ok: false, error: 'unknown session' };
    const manifest = this.os.agents.get(agent);
    if (!manifest?.dir) return { ok: false, error: 'agent has no working folder' };
    // Provenance for the gallery's per-member visibility: the member the session acted as (so they see
    // their own deliverable), falling back to the trigger provenance for pure automation runs.
    const srow = this.db.prepare('SELECT spawned_by, run_as FROM term_sessions WHERE id = ?').get<{ spawned_by: string | null; run_as: string | null }>(sessionId);
    const source = srow?.run_as ?? srow?.spawned_by ?? undefined;
    const title = (input.title || '').trim() || path.basename(input.path);
    const r = this.os.artifacts.publish({
      sessionId, agent, source, title, description: input.description, folder: input.folder,
      allowRoot: manifest.dir, srcPath: input.path,
    });
    if (!r.ok) return { ok: false, error: r.error };
    const a = r.artifact;
    // The card stashes the artifact id + meta in `args` so the inbox can deep-link into the gallery.
    this.addMessage({
      type: 'artifact', sessionId, agent, title: `Artifact — ${agent}`, body: a.title, status: 'open',
      source, args: { artifactId: a.id, filename: a.filename, mime: a.mime, kind: a.kind },
      audienceKind: 'sessionOwner', audienceId: sessionId,
    });
    this.audit(sessionId, agent, 'artifact.published', { id: a.id, filename: a.filename, bytes: a.bytes, mime: a.mime, title: a.title, folder: a.folder });
    return { ok: true, id: a.id };
  }

  /**
   * Generate image(s) from a prompt (the `image_generate` MCP path) and snapshot each into the
   * Artifacts gallery. Claude can't draw natively, so this is a first-class governed capability:
   *  1. the run is policy-classified as `image.generate` with `amountUsd` = the pre-estimate, so the
   *     default money-cap `never` rule gates a runaway spend for free (and an owner can add a rule);
   *  2. the vendor call (OpenRouter default, else Atlas) returns bytes we `ingest` server-side —
   *     vendor URLs can expire in minutes, so we never store the URL as the deliverable;
   *  3. each image lands as an `image` artifact + an owner-scoped inbox card, and the run is audited
   *     with the REAL cost when the backend reports it (OpenRouter `usage.cost`), else the estimate.
   */
  async generateImage(sessionId: string, input: { prompt: string; model?: string; size?: string; n?: number }): Promise<{ ok: boolean; artifacts?: { id: string; filename: string; mime: string }[]; model?: string; costUsd?: number; warning?: string; error?: string }> {
    const agent = this.sessionAgent(sessionId);
    if (!agent) return { ok: false, error: 'unknown session' };
    if (!this.os.artifacts.enabled) return { ok: false, error: 'artifacts store is disabled (no data home)' };
    const prompt = (input.prompt || '').trim();
    if (!prompt) return { ok: false, error: 'a prompt is required' };
    const n = Math.max(1, Math.min(4, Math.floor(input.n ?? 1)));

    const backend = resolveImageBackend({
      openRouterKey: this.os.settings.openRouterKey(),
      atlasKey: this.os.settings.atlasKey(),
      defaultModel: this.os.settings.imageDefaultModel() || undefined,
    });
    if (!backend) return { ok: false, error: 'image generation is not configured — set an OpenRouter or Atlas key in Settings → Integrations' };

    // Govern BEFORE spending: classify with the estimated dollar cost so the money-cap rule applies.
    const estimateUsd = +(n * DEFAULT_IMAGE_COST_USD).toFixed(4);
    const model = input.model?.trim() || backend.defaultModel;
    const gate = this.gate(sessionId, agent, 'image.generate', { prompt, model, n, amountUsd: estimateUsd }, `generate ${n} image(s) with ${model}`);
    if (gate.decision === 'deny') return { ok: false, error: 'blocked by policy' };
    if (gate.decision === 'pending') return { ok: false, error: 'this generation needs human approval — an approval request was filed; retry once it is approved' };

    let result;
    try {
      result = await backend.generate({ prompt, model: input.model, size: input.size, n });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.audit(sessionId, agent, 'image.failed', { model, n, error: msg });
      return { ok: false, error: msg };
    }

    const srow = this.db.prepare('SELECT spawned_by, run_as FROM term_sessions WHERE id = ?').get<{ spawned_by: string | null; run_as: string | null }>(sessionId);
    const source = srow?.run_as ?? srow?.spawned_by ?? undefined;
    const shortPrompt = prompt.length > 60 ? prompt.slice(0, 57) + '…' : prompt;
    const stamp = Date.now();
    const costUsd = result.costUsd ?? estimateUsd;
    // Cost is per-REQUEST; split it evenly across the images so each artifact carries its share and the
    // gallery total sums back to what the request spent.
    const perImageUsd = +(costUsd / result.images.length).toFixed(6);
    const out: { id: string; filename: string; mime: string }[] = [];
    result.images.forEach((img, i) => {
      const filename = `image-${stamp}${result.images.length > 1 ? `-${i + 1}` : ''}.${img.ext}`;
      const r = this.os.artifacts.ingest({
        sessionId, agent, source, title: shortPrompt, description: prompt,
        folder: 'generated-images', filename, bytes: img.bytes, kind: 'image', costUsd: perImageUsd,
      });
      if (!r.ok) return;
      const a = r.artifact;
      out.push({ id: a.id, filename: a.filename, mime: a.mime });
      this.addMessage({
        type: 'artifact', sessionId, agent, title: `Image — ${agent}`, body: a.title, status: 'open',
        source, args: { artifactId: a.id, filename: a.filename, mime: a.mime, kind: a.kind },
        audienceKind: 'sessionOwner', audienceId: sessionId,
      });
    });
    if (!out.length) return { ok: false, error: 'generation succeeded but no image could be stored' };

    const warning = result.fallbackFrom
      ? `Model "${result.fallbackFrom}" was rejected by Atlas — used "${result.model}" instead. Fix the default in Settings → Integrations (or name a valid model).`
      : undefined;
    this.audit(sessionId, agent, 'image.generated', { model: result.model, backend: backend.name, count: out.length, costUsd, costSource: result.costUsd != null ? 'actual' : 'estimate', artifactIds: out.map((o) => o.id), prompt: shortPrompt, ...(result.fallbackFrom ? { fallbackFrom: result.fallbackFrom } : {}) });
    return { ok: true, artifacts: out, model: result.model, costUsd, ...(warning ? { warning } : {}) };
  }

  /**
   * Edit or upscale an EXISTING image (the `image_edit` MCP path). Same governance + storage as
   * `generateImage`: classified `image.edit` with an estimated `amountUsd` (money-cap applies), the
   * result is `ingest`ed as a NEW `image` artifact (the source is never mutated) + an owner-scoped inbox
   * card, audited `image.edited`. The source image is any ref `resolveImageRef` accepts — a Library
   * artifact id, a working-folder file (written or terminal-uploaded), or a URL. Mode precedence:
   * `operation` (a named preset — 'remove-background', a transparent-PNG cutout, no prompt) ⇒ that preset;
   * else `scale` (>1) upscales (prompt ignored); else `prompt` drives an image-to-image edit. Atlas-only.
   */
  async editImage(sessionId: string, input: { image: string; prompt?: string; scale?: number; model?: string; operation?: 'remove-background' }): Promise<{ ok: boolean; artifacts?: { id: string; filename: string; mime: string }[]; model?: string; costUsd?: number; warning?: string; error?: string }> {
    const agent = this.sessionAgent(sessionId);
    if (!agent) return { ok: false, error: 'unknown session' };
    if (!this.os.artifacts.enabled) return { ok: false, error: 'artifacts store is disabled (no data home)' };
    const bgRemove = input.operation === 'remove-background';
    const upscale = !bgRemove && typeof input.scale === 'number' && input.scale > 1;
    const prompt = (input.prompt || '').trim();
    if (!bgRemove && !upscale && !prompt) return { ok: false, error: 'describe the edit in `prompt`, pass `scale` to upscale, or set `operation` (e.g. "remove-background")' };
    const imageRef = (input.image || '').trim();
    if (!imageRef) return { ok: false, error: 'an input `image` is required — a Library artifact id, a working-folder path, or an image URL' };
    const resolved = this.resolveImageRef(agent, imageRef);
    if ('error' in resolved) return { ok: false, error: resolved.error };

    const backend = resolveImageBackend({
      openRouterKey: this.os.settings.openRouterKey(),
      atlasKey: this.os.settings.atlasKey(),
      defaultModel: this.os.settings.imageDefaultModel() || undefined,
    });
    if (!backend) return { ok: false, error: 'image editing is not configured — set an Atlas Cloud key in Settings → Integrations' };

    const estimateUsd = DEFAULT_IMAGE_COST_USD;
    const op = bgRemove ? 'remove-background' : upscale ? 'upscale' : 'edit';
    const model = input.model?.trim() || (bgRemove ? 'youchuan/v8.1/remove-background' : upscale ? 'atlascloud/image-upscaler' : op);
    const gate = this.gate(sessionId, agent, 'image.edit', { prompt, model, op, amountUsd: estimateUsd }, `${op} an image with ${model}`);
    if (gate.decision === 'deny') return { ok: false, error: 'blocked by policy' };
    if (gate.decision === 'pending') return { ok: false, error: 'this edit needs human approval — an approval request was filed; retry once it is approved' };

    let result;
    try {
      result = await backend.editImage({ images: [resolved.url], prompt, model: input.model, scale: input.scale, operation: input.operation });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.audit(sessionId, agent, 'image.failed', { model, op, error: msg });
      return { ok: false, error: msg };
    }

    const srow = this.db.prepare('SELECT spawned_by, run_as FROM term_sessions WHERE id = ?').get<{ spawned_by: string | null; run_as: string | null }>(sessionId);
    const source = srow?.run_as ?? srow?.spawned_by ?? undefined;
    const title = bgRemove ? 'Background removed' : upscale ? `Upscaled ${input.scale}×` : (prompt.length > 60 ? prompt.slice(0, 57) + '…' : prompt);
    const description = bgRemove ? `Background removed from ${imageRef}` : upscale ? `Upscaled ${input.scale}× from ${imageRef}` : prompt;
    const stamp = Date.now();
    const costUsd = result.costUsd ?? estimateUsd;
    const perImageUsd = +(costUsd / result.images.length).toFixed(6);
    const out: { id: string; filename: string; mime: string }[] = [];
    result.images.forEach((img, i) => {
      const filename = `${op}-${stamp}${result.images.length > 1 ? `-${i + 1}` : ''}.${img.ext}`;
      const r = this.os.artifacts.ingest({
        sessionId, agent, source, title, description,
        folder: 'edited-images', filename, bytes: img.bytes, kind: 'image', costUsd: perImageUsd,
      });
      if (!r.ok) return;
      const a = r.artifact;
      out.push({ id: a.id, filename: a.filename, mime: a.mime });
      this.addMessage({
        type: 'artifact', sessionId, agent, title: `Image — ${agent}`, body: a.title, status: 'open',
        source, args: { artifactId: a.id, filename: a.filename, mime: a.mime, kind: a.kind },
        audienceKind: 'sessionOwner', audienceId: sessionId,
      });
    });
    if (!out.length) return { ok: false, error: 'edit succeeded but no image could be stored' };

    const warning = result.fallbackFrom
      ? `Model "${result.fallbackFrom}" was rejected by Atlas — used "${result.model}" instead. Name a valid model or omit it.`
      : undefined;
    this.audit(sessionId, agent, 'image.edited', { model: result.model, backend: backend.name, op, count: out.length, costUsd, costSource: result.costUsd != null ? 'actual' : 'estimate', artifactIds: out.map((o) => o.id), ...(result.fallbackFrom ? { fallbackFrom: result.fallbackFrom } : {}) });
    return { ok: true, artifacts: out, model: result.model, costUsd, ...(warning ? { warning } : {}) };
  }

  /**
   * Understand a VIDEO (or image) — the `video_understand` MCP path. Claude can't natively watch a video,
   * so this delegates to an Atlas video-capable multimodal LLM (chat endpoint, a `video_url` content part)
   * and returns the model's TEXT answer directly to the agent — no artifact. The source is any ref
   * `resolveImageRef` accepts (Library id, working-folder file, or URL), resolved to a base64 data URL so
   * a clip the agent just generated or was handed can be analysed with no public hosting. Governed like the
   * other media calls: classified `video.understand` with a cost estimate (money-cap applies), audited.
   */
  async understandVideo(sessionId: string, input: { video: string; prompt?: string; model?: string; kind?: 'video' | 'image' }): Promise<{ ok: boolean; text?: string; model?: string; costUsd?: number; error?: string }> {
    const agent = this.sessionAgent(sessionId);
    if (!agent) return { ok: false, error: 'unknown session' };
    const atlasKey = this.os.settings.atlasKey();
    if (!atlasKey) return { ok: false, error: 'video understanding needs an Atlas Cloud key — set one in Settings → Integrations' };
    const kind = input.kind === 'image' ? 'image' : 'video';
    const ref = (input.video || '').trim();
    if (!ref) return { ok: false, error: `a ${kind} is required — a Library artifact id, a working-folder path, or a URL` };
    const resolved = this.resolveImageRef(agent, ref, kind);
    if ('error' in resolved) return { ok: false, error: resolved.error };
    const prompt = (input.prompt || '').trim() || (kind === 'video' ? 'Describe this video in detail — what happens, who/what is in it, notable actions and setting.' : 'Describe this image in detail.');

    // Token-priced LLM call; the exact cost isn't known ahead of time. Estimate for the money-cap gate.
    const estimateUsd = DEFAULT_IMAGE_COST_USD;
    const model = input.model?.trim() || 'qwen/qwen3.5-27b';
    const gate = this.gate(sessionId, agent, 'video.understand', { prompt, model, kind, amountUsd: estimateUsd }, `understand a ${kind} with ${model}`);
    if (gate.decision === 'deny') return { ok: false, error: 'blocked by policy' };
    if (gate.decision === 'pending') return { ok: false, error: 'this needs human approval — an approval request was filed; retry once it is approved' };

    let result;
    try {
      result = await understandMedia({ atlasKey, model: input.model, mediaUrl: resolved.url, kind, prompt });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.audit(sessionId, agent, 'video.understand.failed', { model, kind, error: msg });
      return { ok: false, error: msg };
    }

    const costUsd = result.costUsd ?? estimateUsd;
    this.audit(sessionId, agent, 'video.understood', { model: result.model, kind, costUsd, costSource: result.costUsd != null ? 'actual' : 'estimate', chars: result.text.length });
    return { ok: true, text: result.text, model: result.model, costUsd };
  }

  /**
   * Resolve an agent-supplied image reference for image-to-video into something a vendor accepts inline
   * (a `data:` URL or a passthrough http URL). Supports every place a session's image can live:
   *   1. an http(s) or data: URL           → passed straight through
   *   2. a path in the agent's WORKING FOLDER → raw files AND terminal-uploaded files (resolved strictly
   *      under `manifest.dir` via `containedPath`, the same containment `publish` uses — no escapes)
   *   3. a LIBRARY artifact id              → a prior generation / published deliverable
   * File-path is tried before artifact-id so a real file always wins; a bare id (no matching file) falls
   * through to the Library. Non-image inputs and unresolvable refs are rejected. Inlining as base64 means
   * the agent needs no public hosting step for something it just made or was handed.
   */
  private resolveImageRef(agent: string, ref: string, kind: 'image' | 'video' = 'image'): { url: string } | { error: string } {
    if (/^https?:\/\//i.test(ref) || ref.startsWith('data:')) return { url: ref };
    const wantMime = new RegExp(`^${kind}/`);
    const toDataUrl = (absPath: string, mime: string): { url: string } | { error: string } => {
      if (!wantMime.test(mime)) return { error: `"${ref}" is ${mime}, not ${kind === 'image' ? 'an image' : 'a video'}` };
      try {
        return { url: `data:${mime};base64,${fs.readFileSync(absPath).toString('base64')}` };
      } catch (e) {
        return { error: `could not read "${ref}": ${e instanceof Error ? e.message : String(e)}` };
      }
    };
    // (2) a file in the agent's own working folder — covers files it wrote AND files uploaded via the
    // terminal, both of which live under its cwd. containedPath returns null for a non-existent path.
    const dir = this.os.agents.get(agent)?.dir;
    if (dir) {
      const abs = containedPath(dir, ref);
      if (abs) {
        try {
          if (fs.statSync(abs).isFile()) return toDataUrl(abs, mimeOf(abs));
        } catch { /* not a readable file → fall through to Library id */ }
      }
    }
    // (3) a Library artifact id (a prior generation or published deliverable)
    const a = this.os.artifacts.get(ref);
    if (a) {
      const rp = this.os.artifacts.readPath(ref);
      if (rp) return toDataUrl(rp.absPath, a.mime || rp.mime);
    }
    return { error: `couldn't resolve ${kind} "${ref}" — pass an http(s) URL, a file path in your working folder, or a Library artifact id` };
  }

  /**
   * Generate a video from a prompt (the `video_generate` MCP path). Video is ASYNC — renders take
   * minutes — so this SUBMITS the job, persists it to `video_jobs`, and briefly polls for the fast
   * case; anything not finished by the short cap is completed later by `pollVideoJobs()` (driven by the
   * Automations tick), surviving the cap AND a restart. On completion the mp4 is ingested as an
   * `artifact` (kind='video') + an owner-scoped inbox card, audited `video.generated`. Governed exactly
   * like images: classified `video.generate` with the estimated `amountUsd` (per-second × duration), so
   * the money-cap rule applies. Cost is an estimate (video is per-second and rarely returned in-band).
   * An optional `image` seed (URL or artifact id) switches it to image-to-video via `backend.imageModel`.
   */
  async generateVideo(sessionId: string, input: { prompt: string; model?: string; durationSec?: number; image?: string }): Promise<{ ok: boolean; status?: 'done' | 'rendering'; jobId?: string; artifact?: { id: string; filename: string; mime: string }; model?: string; costUsd?: number; error?: string }> {
    const agent = this.sessionAgent(sessionId);
    if (!agent) return { ok: false, error: 'unknown session' };
    if (!this.os.artifacts.enabled) return { ok: false, error: 'artifacts store is disabled (no data home)' };
    const prompt = (input.prompt || '').trim();
    if (!prompt) return { ok: false, error: 'a prompt is required' };
    const durationSec = Math.max(1, Math.min(VIDEO_MAX_DURATION_SEC, Math.floor(input.durationSec ?? DEFAULT_VIDEO_DURATION_SEC)));

    const backend = resolveVideoBackend(this.videoBackendConfig());
    if (!backend) return { ok: false, error: 'video generation is not configured — set a fal.ai (or Atlas Cloud) key in Settings → Integrations' };

    // An optional image seed turns this into image-to-video. The ref is either an http(s) URL (passed
    // through) or a Library artifact id (a prior generation) — resolved to a base64 data URL the vendor
    // accepts inline, so an agent can animate an image it just made without any public hosting.
    let imageUrl: string | undefined;
    const imageRef = (input.image || '').trim();
    if (imageRef) {
      const resolved = this.resolveImageRef(agent, imageRef);
      if ('error' in resolved) return { ok: false, error: resolved.error };
      imageUrl = resolved.url;
    }

    const estimateUsd = +(durationSec * DEFAULT_VIDEO_COST_PER_SEC_USD).toFixed(4);
    const model = input.model?.trim() || (imageUrl ? backend.imageModel : backend.defaultModel);
    const gate = this.gate(sessionId, agent, 'video.generate', { prompt, model, durationSec, imageToVideo: !!imageUrl, amountUsd: estimateUsd }, `generate a ${durationSec}s ${imageUrl ? 'image-to-video' : 'video'} with ${model}`);
    if (gate.decision === 'deny') return { ok: false, error: 'blocked by policy' };
    if (gate.decision === 'pending') return { ok: false, error: 'this generation needs human approval — an approval request was filed; retry once it is approved' };

    let submit;
    try {
      submit = await backend.submit({ prompt, model, durationSec, imageUrl });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.audit(sessionId, agent, 'video.failed', { model, error: msg });
      return { ok: false, error: msg };
    }

    const srow = this.db.prepare('SELECT spawned_by, run_as FROM term_sessions WHERE id = ?').get<{ spawned_by: string | null; run_as: string | null }>(sessionId);
    const source = srow?.run_as ?? srow?.spawned_by ?? undefined;
    const job = this.os.videoJobs.create({ sessionId, agent, source, backend: backend.name, model, prompt, providerRef: submit.providerRef, costUsd: estimateUsd, ttlMs: VIDEO_JOB_TTL_MS });
    this.audit(sessionId, agent, 'video.submitted', { jobId: job.id, model, backend: backend.name, durationSec, estimateUsd });

    // Brief in-call poll for the fast case; otherwise the tick poller finishes it.
    for (let i = 0; i < VIDEO_INCALL_POLLS; i++) {
      await new Promise((r) => setTimeout(r, VIDEO_INCALL_POLL_MS));
      const done = await this.advanceVideoJob(job.id, backend).catch(() => undefined);
      if (done?.status === 'done') return { ok: true, status: 'done', jobId: job.id, artifact: done.artifact, model, costUsd: done.costUsd ?? estimateUsd };
      if (done?.status === 'failed') return { ok: false, error: done.error || 'render failed' };
    }
    return { ok: true, status: 'rendering', jobId: job.id, model, costUsd: estimateUsd };
  }

  /** The Settings-derived config for building a video backend (keys + default model). */
  private videoBackendConfig() {
    return {
      falKey: this.os.settings.falKey(),
      atlasKey: this.os.settings.atlasKey(),
      defaultModel: this.os.settings.videoDefaultModel() || undefined,
    };
  }

  /**
   * Poll ONE rendering job and, if it finished, download + ingest the video. Shared by the in-call fast
   * path and the background poller. Returns the terminal outcome, or `{status:'rendering'}` if not ready.
   */
  private async advanceVideoJob(jobId: string, backend: VideoBackend): Promise<{ status: 'done'; artifact: { id: string; filename: string; mime: string }; costUsd?: number } | { status: 'failed'; error: string } | { status: 'rendering' }> {
    const job = this.os.videoJobs.get(jobId);
    if (!job || job.status !== 'rendering') return { status: 'rendering' };
    this.os.videoJobs.bumpAttempt(jobId);
    let poll;
    try {
      poll = await backend.poll(job.providerRef);
    } catch (e) {
      return { status: 'rendering' }; // a transient poll error — try again next tick, don't fail the job
    }
    if (poll.status === 'rendering') return { status: 'rendering' };
    if (poll.status === 'failed' || !poll.video) {
      const error = poll.error || 'render failed';
      this.os.videoJobs.markFailed(jobId, error);
      this.audit(job.sessionId, job.agent, 'video.failed', { jobId, model: job.model, error });
      this.postVideoCard(job, undefined, `Video failed — ${error}`);
      return { status: 'failed', error };
    }
    // Done → download the mp4 and ingest it as an artifact.
    let bytes: Buffer;
    try {
      const res = await fetch(poll.video.url);
      if (!res.ok) throw new Error(`downloading the finished video failed (${res.status})`);
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.os.videoJobs.markFailed(jobId, error);
      this.audit(job.sessionId, job.agent, 'video.failed', { jobId, model: job.model, error });
      return { status: 'failed', error };
    }
    const costUsd = poll.costUsd ?? job.costUsd;
    const shortPrompt = job.prompt.length > 60 ? job.prompt.slice(0, 57) + '…' : job.prompt;
    const r = this.os.artifacts.ingest({
      sessionId: job.sessionId, agent: job.agent, source: job.source, title: shortPrompt, description: job.prompt,
      folder: 'generated-videos', filename: `video-${Date.now()}.${poll.video.ext}`, bytes, kind: 'video', costUsd,
    });
    if (!r.ok) {
      this.os.videoJobs.markFailed(jobId, r.error);
      return { status: 'failed', error: r.error };
    }
    const a = r.artifact;
    this.os.videoJobs.markDone(jobId, a.id, costUsd);
    this.postVideoCard(job, a.id, a.title);
    this.audit(job.sessionId, job.agent, 'video.generated', { jobId, model: job.model, backend: job.backend, costUsd, costSource: poll.costUsd != null ? 'actual' : 'estimate', artifactId: a.id, prompt: shortPrompt });
    return { status: 'done', artifact: { id: a.id, filename: a.filename, mime: a.mime }, costUsd };
  }

  /** Owner-scoped inbox card for a finished/failed video (the async delivery — the requester has moved on). */
  private postVideoCard(job: { sessionId: string; agent: string; source?: string }, artifactId: string | undefined, body: string): void {
    this.addMessage({
      type: 'artifact', sessionId: job.sessionId, agent: job.agent, title: `Video — ${job.agent}`, body, status: 'open',
      source: job.source, args: artifactId ? { artifactId, kind: 'video' } : { kind: 'video', failed: true },
      audienceKind: 'sessionOwner', audienceId: job.sessionId,
    });
  }

  /**
   * Background pass over in-flight video renders — advances each `rendering` job (poll → ingest on
   * completion). Expired jobs (past their TTL) or ones that outran the poll ceiling are parked. Driven
   * by the Automations tick so a paid render always lands even though the requesting call returned.
   */
  async pollVideoJobs(): Promise<void> {
    const jobs = this.os.videoJobs.pending();
    if (!jobs.length) return;
    const cfg = this.videoBackendConfig();
    for (const job of jobs) {
      if (Date.now() > job.expiresAt || job.attempts > VIDEO_MAX_POLLS) {
        this.os.videoJobs.markExpired(job.id);
        this.audit(job.sessionId, job.agent, 'video.failed', { jobId: job.id, model: job.model, error: 'render timed out' });
        this.postVideoCard(job, undefined, 'Video timed out while rendering');
        continue;
      }
      const backend = videoBackend(job.backend as 'fal' | 'atlas', cfg);
      if (!backend) continue; // key was removed — leave it pending until reconfigured (or it expires)
      await this.advanceVideoJob(job.id, backend).catch(() => undefined);
    }
  }

  /**
   * Agent attaches a file from its OWN working folder onto a task (the `task_attach` MCP path). The
   * store resolves the path strictly under the agent folder + snapshots it into the task's attachment
   * dir. Uploader = `agent:<id>`; auto-apply + audited, exactly like publishArtifact / task edits.
   */
  attachTaskFile(sessionId: string, taskId: string, srcPath: string): { ok: boolean; id?: string; filename?: string; error?: string } {
    const agent = this.sessionAgent(sessionId);
    if (!agent) return { ok: false, error: 'unknown session' };
    const manifest = this.os.agents.get(agent);
    if (!manifest?.dir) return { ok: false, error: 'agent has no working folder' };
    const r = this.os.tasks.attachFromPath({ taskId, allowRoot: manifest.dir, srcPath, uploadedBy: `agent:${agent}` });
    if (!r.ok) return { ok: false, error: r.error };
    this.audit(sessionId, agent, 'task.attached', { taskId, id: r.attachment.id, filename: r.attachment.filename, bytes: r.attachment.bytes, mime: r.attachment.mime });
    return { ok: true, id: r.attachment.id, filename: r.attachment.filename };
  }

  /**
   * Console operator pasted/dropped/picked a file (ANY type — image, PDF, log, zip, …) onto a LIVE
   * session. Save it under the agent's OWN working folder (`.inbox/`) — reachable by the agent's Read
   * tool via a relative path — and type its relative path into the running claude (no auto-submit) so
   * the operator can add a question and send. The agent's Read tool can then open the file. Authz is
   * the caller's job (canViewSession). `origName` (the browser filename) is preserved when present so
   * the agent sees a meaningful path (timestamp-prefixed to stay unique); otherwise we fall back to
   * `pasted-<ts>.<ext>`. Returns the in-folder relative path.
   */
  attachFile(sessionId: string, by: string, data: Buffer, ext: string, origName?: string): { ok: boolean; path?: string; error?: string } {
    const row = this.db.prepare('SELECT agent, tmux, status, spawned_by, run_as FROM term_sessions WHERE id = ?')
      .get<{ agent: string; tmux: string; status: string; spawned_by: string | null; run_as: string | null }>(sessionId);
    if (!row) return { ok: false, error: 'unknown session' };
    if (row.status !== 'running') return { ok: false, error: 'session is not live — attachments need a running session' };
    const manifest = this.os.agents.get(row.agent);
    if (!manifest?.dir) return { ok: false, error: 'agent has no working folder' };
    const safeExt = (ext || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
    // Prefer the real filename (basename only, sanitized) so a report.pdf stays report.pdf; a
    // timestamp prefix keeps concurrent same-name uploads from clobbering each other.
    const clean = (origName || '').split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80);
    let rel: string;
    try {
      const dir = path.join(manifest.dir, '.inbox');
      fs.mkdirSync(dir, { recursive: true });
      const name = clean && /\.[A-Za-z0-9]+$/.test(clean) ? `${Date.now()}-${clean}` : `pasted-${Date.now()}.${safeExt}`;
      fs.writeFileSync(path.join(dir, name), data);
      rel = path.join('.inbox', name);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const injected = this.backend.injectText(this.spaceFor(row.run_as ?? row.spawned_by), row.tmux, rel + ' ', false);
    this.audit(sessionId, by, 'session.attachment', { path: rel, bytes: data.length, injected });
    return { ok: true, path: rel };
  }

  /** Launcher signal that claude exited GRACEFULLY (the process returned; the launcher reached its
   *  notify_ended). Advances a still-running row → `done`, but never clobbers a richer terminal state
   *  the run already reached — an agent `report` (`done`) or a human `stopSession` (`stopped`). Emits
   *  no feed card — the agent's own `report` is the meaningful completion signal. */
  markEnded(sessionId: string): void {
    const s = this.db.prepare('SELECT agent, status FROM term_sessions WHERE id = ?').get<{ agent: string; status: string }>(sessionId);
    if (!s) return;
    // A "natural end": the row was still live and the process returned on its own — as opposed to a human
    // `stopSession` (already 'stopped') or a crash the sweep caught ('crashed'). Only a natural end earns
    // the completion-fallback card below, so closing a session yourself doesn't ping you about it.
    const naturalEnd = s.status === 'running';
    if (naturalEnd) this.db.prepare("UPDATE term_sessions SET status = 'done', updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
    this.clearNotifications(sessionId);
    // claude exited on its own. The launcher normally holds the pane on a "press [r] to resume" prompt,
    // but if that pane dies (an idle/detached `read` bailing out), ttyd's silent auto-reconnect would
    // re-run attach.sh and `claude --resume` the finished session back to life. Drop the same stay-stopped
    // sentinel as a manual stop — inert while the holding pane lives, decisive if it doesn't. A deliberate
    // re-open/Resume clears it.
    this.blockResume(sessionId);
    // Distil the session into one durable memory for the agent — the `report` (a 'completed' card) has
    // already landed by now if the agent left one, so writeEpisode prefers it; otherwise it summarises
    // the audit stream. Best-effort + idempotent; never blocks the end signal.
    this.writeEpisode(sessionId, s.agent);
    // Completion fallback: a run that exits without leaving its own `report` card still tells its owner it
    // finished — the "session complete" bell/toast the console shows. Posted AFTER writeEpisode so this
    // synthetic card can't be mistaken for the agent's own summary when composing the episode, and gated
    // on `hasCompleted` so it never doubles a real report. Owner-scoped like every session card.
    if (naturalEnd && !this.hasCompleted(sessionId)) {
      const title = `Finished — ${s.agent}`;
      const body = 'The session ended.';
      this.addMessage({ type: 'completed', sessionId, agent: s.agent, title, body, status: 'open', outcome: 'ended', audienceKind: 'sessionOwner', audienceId: sessionId });
      this.fireSessionEvent(sessionId, s.agent, 'completed', title, body);
    }
    this.audit(sessionId, s.agent, 'session.ended', {});
  }

  /** A stopped/ended session was reconnected and is live again — the ttyd attach wrapper resurrected
   *  it via `claude --resume`. Flip the row back to `running` so the console shows it active, and drop
   *  an activity note. No-op if the row is already running (or unknown). */
  markResumed(sessionId: string): void {
    const s = this.db.prepare('SELECT agent, status FROM term_sessions WHERE id = ?').get<{ agent: string; status: string }>(sessionId);
    if (!s || s.status === 'running') return;
    this.db.prepare("UPDATE term_sessions SET status = 'running', updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
    // No "Resumed" card — reconnecting is lifecycle noise, not something the operator needs in the feed.
    this.audit(sessionId, s.agent, 'session.resumed', {});
  }

  private hasCompleted(sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM messages WHERE session_id = ? AND type = 'completed'").get(sessionId);
  }

  /** Sessions already turned into an episode this process — belt-and-braces with the audit_events
   *  marker below, so a doubled end signal (or a repeated crash-sweep poll) can't write two episodes
   *  for one session. */
  private readonly episoded = new Set<string>();

  /**
   * Write one end-of-session **episode** — a durable `Insight` memory for the agent — so a future
   * session can `recall` what this one did. Prefers the agent's own `report` summary; failing that,
   * summarises the session's audit stream. Skips sessions that did nothing worth remembering. Stores
   * via the live memory provider (so episodes are recalled like any memory); best-effort + idempotent.
   * Episodes are the richest input the self-learning ("Dreaming") pass consumes — see src/edge/dreaming.ts.
   */
  private writeEpisode(sessionId: string, agent: string, outcomeOverride?: string): void {
    if (this.episoded.has(sessionId)) return;
    if (this.db.prepare("SELECT 1 FROM audit_events WHERE run_id = ? AND type = 'episode.stored'").get(sessionId)) return;
    const task = this.db.prepare('SELECT task FROM term_sessions WHERE id = ?').get<{ task: string }>(sessionId)?.task ?? '';
    const report = this.db.prepare("SELECT outcome, body FROM messages WHERE session_id = ? AND type = 'completed' ORDER BY created_at DESC LIMIT 1").get<{ outcome: string | null; body: string }>(sessionId);
    const events = this.db.prepare('SELECT type, data FROM audit_events WHERE run_id = ? ORDER BY ts').all<{ type: string; data: string }>(sessionId);
    const ep = composeEpisode(task, report, events, outcomeOverride);
    if (!ep) return; // nothing worth remembering
    this.episoded.add(sessionId);
    void this.os.memory
      .store({
        tenant: this.os.tenant,
        agentId: agent,
        content: ep.content,
        tags: ['episode', 'session-end'],
        type: 'Insight',
        importance: ep.importance,
        metadata: { sessionId, outcome: ep.outcome, source: ep.source, salience: ep.signals },
      })
      .then(() => this.audit(sessionId, agent, 'episode.stored', { outcome: ep.outcome, source: ep.source, importance: ep.importance, salience: ep.signals }))
      .catch((e) => this.audit(sessionId, agent, 'episode.error', { error: e instanceof Error ? e.message : String(e) }));
  }

  // ── session management / cleanup ─────────────────────────────────────────────
  /**
   * Stop a running session: kill its tmux shell (terminate a runaway/hung agent) and flip the row
   * to `idle`. The row, its messages and on-disk files all stay — this is "halt", not "remove".
   * Emits no feed card (lifecycle noise); the audit log records the stop. No-op on unknown id.
   * Called both by a human (console kill, `by` = member email) and by the agent itself ending its
   * own run (`stop` MCP tool → /api/agent/stop, `by` = agent id, optional `reason`).
   */
  stopSession(sessionId: string, by: string, reason?: string): boolean {
    const r = this.db.prepare('SELECT agent, tmux, status, spawned_by, run_as FROM term_sessions WHERE id = ?').get<{ agent: string; tmux: string; status: string; spawned_by: string | null; run_as: string | null }>(sessionId);
    if (!r) return false;
    const space = this.spaceFor(r.run_as ?? r.spawned_by);
    // Snapshot the pane before we kill it, so the console transcript view still shows what the run did
    // (an attachable unattended run has no `-p` tee to fall back on). Best-effort; never blocks the stop.
    this.captureTranscript(sessionId, space, r.tmux);
    this.backend.kill(space, r.tmux);
    if (r.status === 'running') this.db.prepare("UPDATE term_sessions SET status = 'stopped', updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
    this.clearNotifications(sessionId);
    // The agent that asked is now dead — no one can answer its open questions or act on its approvals.
    // Cancel both so they leave "Needs you" and become dismissable, rather than hanging forever.
    this.cancelPendingQuestions(sessionId, by);
    this.cancelPendingApprovals(sessionId, by);
    // A deliberate stop must STAY stopped. The terminal is likely still open in the browser, and ttyd
    // (disableReconnect=false) silently re-dials the moment the pane's tmux dies — re-running attach.sh,
    // which would otherwise `claude --resume` the session straight back to life ("reconnected… resumes").
    // Drop a sentinel so attach.sh skips resurrection; a deliberate re-open (attachUrl / the Resume
    // button → /resume) clears it. Auto-reconnect calls neither, so it can't self-revive.
    this.blockResume(sessionId);
    // Halting kills the tmux shell, so the launcher's `markEnded` never fires — capture the episode
    // here instead so the work done (the audit stream) is remembered. Outcome 'stopped'; skipped if the
    // session did nothing worth remembering.
    this.writeEpisode(sessionId, r.agent, 'stopped');
    // No "Stopped" card — a human halting a run is lifecycle noise; the audit log records who/when.
    // `by` distinguishes a human halt (member email) from a self-stop (the agent id, via the `stop`
    // MCP tool → /api/agent/stop); an agent-supplied `reason` rides along for the audit trail.
    this.audit(sessionId, by, 'session.stopped', { tmux: r.tmux, ...(reason ? { reason } : {}) });
    return true;
  }

  /**
   * A human verdict on a finished run — 'up' (did what I wanted) / 'down' (didn't) / null (clear it).
   * The ground-truth signal that feeds the agent maturity score above self-report + task result. One
   * verdict per session (latest wins); the caller must be allowed to see the session (checked upstream).
   */
  rateSession(sessionId: string, by: Member, rating: 'up' | 'down' | null): { ok: boolean; error?: string } {
    const r = this.db.prepare('SELECT id, agent FROM term_sessions WHERE id = ?').get<{ id: string; agent: string }>(sessionId);
    if (!r) return { ok: false, error: 'unknown session' };
    if (rating === null) {
      this.db.prepare('UPDATE term_sessions SET rating = NULL, rated_by = NULL, rated_at = NULL WHERE id = ?').run(sessionId);
    } else {
      this.db.prepare('UPDATE term_sessions SET rating = ?, rated_by = ?, rated_at = ? WHERE id = ?').run(rating, by.id, Date.now(), sessionId);
    }
    this.audit(sessionId, by.email, 'session.rated', { rating, agent: r.agent });
    return { ok: true };
  }

  /** Path of a session's "do not auto-resurrect" sentinel (see stopSession / attach.sh). */
  private stopMarkerPath(sessionId: string): string | null {
    return this.os.paths ? path.join(this.os.paths.connectors, `session-${sessionId}.stopped`) : null;
  }

  /** Mark a session as "do not auto-resurrect" so the ttyd attach wrapper (attach.sh) won't
   *  `claude --resume` it the next time its dead pane triggers a silent reconnect. Only a session with a
   *  persisted launch env is resurrectable, so there's nothing to block otherwise — skip it (a headless
   *  run leaves no env and would only litter the dir). A deliberate re-open clears it via `allowResume`. */
  private blockResume(sessionId: string): void {
    const p = this.stopMarkerPath(sessionId);
    if (!p || !this.os.paths) return;
    if (!fs.existsSync(path.join(this.os.paths.connectors, `session-${sessionId}.env`))) return;
    try { this.ensureSecureDir(this.os.paths.connectors); fs.writeFileSync(p, '', { mode: 0o600 }); } catch { /* best-effort */ }
  }

  /** Clear the stop sentinel — a human deliberately re-opened/resumed this session, so let attach.sh
   *  resurrect it again. No-op if it was never stopped. Idempotent. */
  allowResume(sessionId: string): void {
    const p = this.stopMarkerPath(sessionId);
    if (!p) return;
    try { fs.rmSync(p, { force: true }); } catch { /* best-effort */ }
  }

  /**
   * Permanently delete a session: kill its tmux shell, remove its per-session on-disk files, and
   * cascade-delete its inbox messages, questions and the row itself. The audit JSONL (the durable
   * system-of-record) is preserved — a `session.deleted` event is appended. No-op on unknown id.
   */
  deleteSession(sessionId: string, by: string): boolean {
    const r = this.db.prepare('SELECT agent, tmux, spawned_by, run_as FROM term_sessions WHERE id = ?').get<{ agent: string; tmux: string; spawned_by: string | null; run_as: string | null }>(sessionId);
    if (!r) return false;
    this.backend.kill(this.spaceFor(r.run_as ?? r.spawned_by), r.tmux);
    this.removeSessionFiles(sessionId);
    // Settle any in-memory approval waiter (deny) before the rows go, so a still-suspended gate unblocks.
    this.cancelPendingApprovals(sessionId, by);
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM questions WHERE run_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM approvals WHERE run_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM term_sessions WHERE id = ?').run(sessionId);
    this.audit(sessionId, by, 'session.deleted', { tmux: r.tmux, agent: r.agent });
    return true;
  }

  /** Remove every per-session file we materialise under the data home (`session-<id>.{mcp.json,company.md,log}`). */
  private removeSessionFiles(sessionId: string): void {
    if (!this.os.paths) return;
    const dir = this.os.paths.connectors;
    const prefix = `session-${sessionId}.`;
    try {
      for (const f of fs.readdirSync(dir)) {
        // `recursive` also clears the Phase 2c `session-<id>.d/` dir (keys + ssh_config + shim).
        if (f.startsWith(prefix)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      }
    } catch {
      /* dir may not exist yet — nothing to clean */
    }
  }

  private audit(sessionId: string, principal: string, type: string, data: Record<string, unknown>): void {
    const ev: AuditEvent = { ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal, type, data };
    this.os.audit.append(ev);
  }

  /**
   * Resolve `secret:` references in connectors' env/headers to real credentials from the vault,
   * in place. Principal precedence: an explicit `secret:PRINCIPAL/KEY` wins; otherwise the session's
   * acting member (so a member-scoped secret is preferred), and the vault widens to tenant-wide (`*`)
   * on its own. A reference the vault can't resolve is blanked and audited — we never hand the MCP
   * server the literal `secret:…` marker (which would silently authenticate as that string).
   */
  private resolveVaultRefs(
    servers: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>,
    actingMember: string | undefined,
    sessionId: string,
    agent: string,
  ): void {
    const resolveBag = (connectorId: string, field: 'env' | 'headers', bag?: Record<string, string>) => {
      if (!bag) return;
      for (const [name, value] of Object.entries(bag)) {
        const ref = parseSecretRef(value);
        if (!ref) continue;
        const principal = ref.principal ?? actingMember ?? '*';
        const resolved = this.os.secrets.getSync(this.os.tenant, principal, ref.key);
        if (resolved === undefined) {
          bag[name] = '';
          this.audit(sessionId, agent, 'connector.secret.unresolved', { connector: connectorId, field, name, key: ref.key, principal });
        } else {
          bag[name] = resolved;
        }
      }
    };
    for (const [id, spec] of Object.entries(servers)) {
      resolveBag(id, 'env', spec.env);
      resolveBag(id, 'headers', spec.headers);
    }
  }

  /**
   * Resolve the agent's opt-in `shellSecrets` (vault keys) and export each as a shell env var into
   * the session — so a plain CLI like `gh` (GH_TOKEN) authenticates without the OS baking the
   * credential into the server env. Agent-scoped principal (the agent IS the identity for its
   * tooling), widening to the tenant-wide `*` default inside the vault. Audited per key: `injected`
   * on success, `unresolved` when the vault has no value (env var left unset rather than blanked, so
   * `gh` sees "no token" cleanly instead of "set but empty"). This is the ONLY path a vault secret
   * reaches the interactive shell — connectors get theirs via the MCP bag — so exposure stays
   * explicit and opt-in per agent (the manifest list).
   */
  private injectShellSecrets(
    env: Record<string, string>,
    agent: string,
    manifest: { shellSecrets?: string[] } | undefined,
    sessionId: string,
  ): void {
    const keys = manifest?.shellSecrets;
    if (!keys?.length) return;
    for (const key of keys) {
      const value = this.os.secrets.getSync(this.os.tenant, agent, key);
      if (value === undefined) {
        this.audit(sessionId, agent, 'shell.secret.unresolved', { key, principal: agent });
        continue;
      }
      env[key] = value;
      this.audit(sessionId, agent, 'shell.secret.injected', { key, principal: agent });
    }
  }

  /**
   * Per-member GitHub (Phase 2 — docs/per-member-github-plan.md). If the session's run-as member has
   * linked their own GitHub account, export their user token as `GH_TOKEN` + `GITHUB_TOKEN`, OVERRIDING
   * any agent-scoped bot token set by `injectShellSecrets` — so git/PRs are authored as the actual human
   * (the company bot remains the fallback when the human hasn't connected). Reads the stored token
   * synchronously (the launch path is sync); if it's within the refresh skew of expiry AND has a refresh
   * token, kick a fire-and-forget refresh that rewrites the vault blob for the NEXT launch (this run
   * still gets the currently-valid token). Audited per injection.
   */
  private injectMemberGithub(env: Record<string, string>, agent: string, actingMember: string | undefined, sessionId: string): void {
    if (!actingMember) return;
    const gh = new GithubIdentity(this.os);
    const blob = gh.load(actingMember);
    if (!blob) return;
    env.GH_TOKEN = blob.token;
    env.GITHUB_TOKEN = blob.token;
    this.audit(sessionId, agent, 'github.token.injected', { login: blob.login, principal: actingMember });
    if (gh.needsRefresh(blob) && blob.refreshToken) {
      this.audit(sessionId, agent, 'github.token.stale', { login: blob.login, principal: actingMember });
      void gh.ensureFresh(actingMember).catch(() => { /* best-effort; next launch retries */ });
    }
  }

  /**
   * Make plain `git` authenticate with the injected `GH_TOKEN` too — not just `gh`. `gh` reads
   * `GH_TOKEN`/`GITHUB_TOKEN` from the env natively, but `git push`/`clone` over HTTPS does not, so
   * without a credential helper only half the toolchain would work. We install a **github.com-scoped**
   * helper entirely via `GIT_CONFIG_*` env vars (git ≥2.31) — no file writes, session-scoped, and it
   * reads `$GH_TOKEN` at call time so a rotated token still works. The empty helper (index 0) first
   * RESETS any inherited system/global helper for that host so ours is the only one consulted; the
   * username `x-access-token` is what GitHub expects for App/user tokens. No-op when no token was set
   * (nothing to authenticate with) or for non-github.com remotes (SSH hosts keep their own keys).
   */
  private configureGitCredentials(env: Record<string, string>): void {
    if (!env.GH_TOKEN) return;
    env.GIT_CONFIG_COUNT = '2';
    env.GIT_CONFIG_KEY_0 = 'credential.https://github.com.helper';
    env.GIT_CONFIG_VALUE_0 = '';
    env.GIT_CONFIG_KEY_1 = 'credential.https://github.com.helper';
    env.GIT_CONFIG_VALUE_1 = '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; }; f';
  }

  /** Find the real `ssh`/`scp` on the PARENT PATH (which never includes a session shim dir), so the
   *  injected wrapper can exec the genuine binary. Falls back to the conventional /usr/bin path. */
  private resolveBin(name: string): string {
    for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!d) continue;
      const p = path.join(d, name);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
    }
    return `/usr/bin/${name}`;
  }

  /**
   * Phase 2c — deliver a granted Host connection's SSH-key credential to the session so a plain
   * `ssh`/`scp` authenticates transparently, WITHOUT the agent handling the key. For each enabled
   * SSH host bound to this run that carries a `secret:` credential, we resolve the key from the vault
   * and write, under a session-private `session-<id>.d/` dir: the key (0600), an `ssh_config` mapping
   * each Host pattern → its key (`IdentitiesOnly`, so the prod key is only ever OFFERED to prod hosts),
   * and an `ssh`/`scp` shim on PATH that injects `-F <ssh_config>`. Host-scoped by construction.
   *
   * Local-lane only for now: under uid-isolation the files must land in the member's home via the
   * launcher (a follow-up). A CIDR matcher can't be an ssh_config Host pattern, so those are skipped
   * (the key still governs via the gate; it just isn't auto-offered). Audited per key.
   */
  private injectHostCredentials(env: Record<string, string>, agent: string, actingMember: string | undefined, sessionId: string): void {
    if (!this.os.paths || this.uidIsolation) return;
    const hosts = this.os.hosts.sshCredsFor(actingMember);
    if (!hosts.length) return;
    const dir = path.join(this.os.paths.connectors, `session-${sessionId}.d`);
    const keysDir = path.join(dir, 'keys');
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(keysDir, { recursive: true });
    const cfg: string[] = [`# Agent OS host connections — session ${sessionId}`, ''];
    let injected = 0;
    for (const h of hosts) {
      const m = h.match.trim();
      if (m.includes('/')) { this.audit(sessionId, agent, 'host.cred.skipped', { host: h.id, reason: 'cidr-matcher', match: m }); continue; }
      const ref = parseSecretRef(h.credential);
      const principal = ref?.principal ?? actingMember ?? '*';
      const key = ref ? this.os.secrets.getSync(this.os.tenant, principal, ref.key) : h.credential;
      if (!key) { this.audit(sessionId, agent, 'host.secret.unresolved', { host: h.id, key: ref?.key ?? '(raw)', principal }); continue; }
      const keyPath = path.join(keysDir, `${h.id}.key`);
      fs.writeFileSync(keyPath, key.endsWith('\n') ? key : `${key}\n`, { mode: 0o600 });
      const hostPat = m.replace(/:\d+$/, '');
      const portM = m.match(/:(\d+)$/);
      cfg.push(`Host ${hostPat}`, `  IdentityFile ${keyPath}`, `  IdentitiesOnly yes`);
      if (portM) cfg.push(`  Port ${portM[1]}`);
      cfg.push('');
      injected++;
      this.audit(sessionId, agent, 'host.secret.injected', { host: h.id, match: hostPat, principal });
    }
    if (!injected) { fs.rmSync(dir, { recursive: true, force: true }); return; }
    const cfgPath = path.join(dir, 'ssh_config');
    fs.writeFileSync(cfgPath, cfg.join('\n'), { mode: 0o600 });
    fs.mkdirSync(binDir, { recursive: true });
    for (const name of ['ssh', 'scp'] as const) {
      const shim = path.join(binDir, name);
      fs.writeFileSync(shim, `#!/bin/sh\nexec ${this.resolveBin(name)} -F "${cfgPath}" "$@"\n`, { mode: 0o755 });
    }
    // Prepend the shim dir so `ssh`/`scp` resolve to it (the launcher then prepends ~/.local/bin ahead,
    // which won't shadow ssh in practice). Off-lane leaves env.PATH unset → seed from the parent PATH.
    env.PATH = `${binDir}${path.delimiter}${env.PATH ?? process.env.PATH ?? ''}`;
  }

  /** The JSON policy engine ignores ctx; provide a minimal stand-in to satisfy the type. */
  private ctx(sessionId: string, agent: string): RunContext {
    return {
      run: { id: sessionId, tenant: this.os.tenant, principal: agent } as never,
      secrets: this.os.secrets,
      audit: this.os.audit,
      log: () => undefined,
    } as RunContext;
  }
}

/** POSIX single-quote a value for a sourceable `export KEY='value'` line (handles embedded quotes). */
function shSingleQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Audit types that are session plumbing, not work — they don't, on their own, make an episode. Includes
 *  the paired/duplicate signals (gate.attempt pairs gate.decision; approval.resolved/auto_approved pair
 *  approval.requested) so the audit-summary counts each governed action once, not two or three times. */
const EPISODE_NOISE = new Set([
  'session.created', 'session.ended', 'session.reported', 'session.resumed', 'session.stopped',
  'session.error', 'session.tuning', 'session.progress', 'session.notified', 'session.attachment',
  'skills.materialized', 'skills.reloaded', 'skills.error', 'connector.minted', 'connector.mint.failed',
  'connector.secret.unresolved', 'shell.secret.injected', 'shell.secret.unresolved',
  'gate.attempt', 'gate.killswitch', 'approval.resolved',
  'approval.auto_approved', 'episode.stored', 'episode.error',
]);

/** Friendlier names for the common activity events when summarising a session with no report. */
const EPISODE_LABELS: Record<string, string> = {
  'gate.decision': 'governed actions',
  'capability.invoked': 'tool actions',
  'memory.stored': 'facts remembered',
  'artifact.published': 'artifacts published',
  'question.asked': 'questions to a human',
  'approval.requested': 'approvals requested',
};

/** The salience signals (lever 3) distilled from a session's audit stream. */
interface SalienceSignals { actions: number; rejected: number; errors: number; budgetStops: number; killswitch: number; approvals: number }

/**
 * Grade how *memorable* a session is from its audit stream (lever 3 — auto-salience). Effort (governed
 * actions) and friction (rejected approvals, errors, budget stops, kill-switch blocks) and a hard
 * outcome raise importance above the flat baseline, so recall / dreaming / consolidation weight the
 * sessions that actually taught the fleet something — not the boring ones. Pure.
 */
function episodeSalience(source: 'report' | 'audit', outcome: string, events: { type: string; data?: string }[]): { importance: number; signals: SalienceSignals } {
  const s: SalienceSignals = { actions: 0, rejected: 0, errors: 0, budgetStops: 0, killswitch: 0, approvals: 0 };
  for (const e of events) {
    switch (e.type) {
      case 'gate.decision': s.actions++; break;
      case 'approval.requested': s.approvals++; break;
      case 'budget.exceeded': s.budgetStops++; break;
      case 'gate.killswitch': s.killswitch++; break;
      case 'episode.error': case 'session.error': s.errors++; break;
      case 'approval.resolved': {
        let approved = true;
        try { approved = (JSON.parse(e.data || '{}') as { approved?: boolean }).approved !== false; } catch { /* ignore */ }
        if (!approved) s.rejected++;
        break;
      }
      default: break;
    }
  }
  const base = source === 'report' ? 0.55 : 0.4; // a deliberate report is worth more than a bare audit trace
  const effortBoost = Math.min(0.2, s.actions * 0.02); // caps at ~10 governed actions
  const frictionBoost = Math.min(0.3, (s.rejected + s.errors + s.budgetStops + s.killswitch) * 0.15); // friction is the strongest memorability signal
  const outcomeBoost = outcome === 'failure' || outcome === 'crashed' ? 0.1 : 0;
  const importance = Math.round(Math.min(0.95, Math.max(0.3, base + effortBoost + frictionBoost + outcomeBoost)) * 100) / 100;
  return { importance, signals: s };
}

/**
 * Turn a finished session into the body of one `Insight` memory — or null when there's nothing worth
 * remembering. Prefers the agent's own end-of-session `report` summary; otherwise distils the audit
 * stream into a short "what this session did" line. Importance is graded by `episodeSalience` (effort +
 * friction + outcome), not flat. Pure (no I/O) so it's trivially testable.
 */
function composeEpisode(
  task: string,
  report: { outcome: string | null; body: string } | undefined,
  events: { type: string; data?: string }[],
  outcomeOverride?: string,
): { content: string; outcome: string; source: 'report' | 'audit'; importance: number; signals: SalienceSignals } | null {
  const taskLine = task.trim() ? `Task: ${task.trim()}` : '';
  const body = (report?.body ?? '').trim();
  const hasReport = !!body && body !== '(no summary)' && body !== 'Session ended.';
  if (hasReport) {
    // The agent's own summary wins — even if the session was later stopped, its report stands.
    const outcome = report?.outcome || 'unknown';
    const content = [taskLine, `Outcome: ${outcome}`, '', body].filter((l) => l !== '').join('\n').trim();
    const { importance, signals } = episodeSalience('report', outcome, events);
    return { content, outcome, source: 'report', importance, signals };
  }
  // No usable report → summarise the audit stream. Skip if the session did no real work.
  const acts = events.filter((e) => !EPISODE_NOISE.has(e.type));
  if (!acts.length) return null;
  const counts = new Map<string, number>();
  for (const e of acts) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const parts = [...counts].map(([t, n]) => `${n} ${EPISODE_LABELS[t] ?? t}`);
  const outcome = outcomeOverride || report?.outcome || 'unknown';
  const content = [taskLine, `Outcome: ${outcome}`, `Activity: ${parts.join(', ')}.`].filter((l) => l !== '').join('\n').trim();
  const { importance, signals } = episodeSalience('audit', outcome, events);
  return { content, outcome, source: 'audit', importance, signals };
}

/** Derive a short, single-line session title from an agent's free-text report summary:
 *  first non-empty line, whitespace collapsed, capped with an ellipsis. Empty in → empty out. */
function titleFromSummary(summary: string): string {
  const firstLine = (summary || '').split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  return collapsed.length > 72 ? `${collapsed.slice(0, 71).trimEnd()}…` : collapsed;
}

function toSession(r: SessionRow): Session {
  return { id: r.id, agent: r.agent, title: r.title, task: r.task, tmux: r.tmux, status: r.status, spawnedBy: r.spawned_by ?? undefined, runAs: r.run_as ?? undefined, headless: !!r.headless, claimedBy: r.claimed_by ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at ?? r.created_at, rating: r.rating === 'up' || r.rating === 'down' ? r.rating : undefined, ratedBy: r.rated_by ?? undefined, ratedAt: r.rated_at ?? undefined };
}

function toMessage(r: MessageRow): FeedMessage {
  // Approval/question rows reflect their live status from the joined table; others keep their own.
  let status = r.status;
  if (r.type === 'approval' && r.approval_status) status = r.approval_status;
  if (r.type === 'question' && r.question_status) status = r.question_status;
  return {
    id: r.id,
    type: r.type,
    sessionId: r.session_id,
    agent: r.agent,
    title: r.title,
    body: r.body,
    status,
    approvalId: r.approval_id ?? undefined,
    capability: r.capability ?? undefined,
    args: r.args ? (JSON.parse(r.args) as unknown) : undefined,
    level: r.level ?? undefined,
    // Explicit risk bucket for approval cards, derived from the approver level (head→yellow, owner→red).
    riskClass: r.type === 'approval' && r.level ? riskClassForLevel(r.level as ApprovalLevel) : undefined,
    source: r.source ?? undefined,
    questionId: r.question_id ?? undefined,
    answer: r.question_answer ?? undefined,
    outcome: r.outcome ?? undefined,
    policyReason: r.type === 'approval' ? r.approval_reason ?? undefined : undefined,
    resolvedBy: r.type === 'approval' ? r.approval_resolved_by ?? undefined : undefined,
    answeredBy: r.type === 'question' ? r.question_answered_by ?? undefined : undefined,
    sessionTitle: r.session_title ?? undefined,
    // read is per-member: present only when the console feed joined message_state for the viewer.
    // The agent's own session inbox doesn't select it (key absent) → left undefined.
    read: 'state_read_at' in r ? r.state_read_at != null : undefined,
    audienceKind: (r.audience_kind as Audience['kind']) ?? undefined,
    audienceId: r.audience_id ?? undefined,
    createdAt: r.created_at,
  };
}

/** Rebuild an {@link Audience} from a message row's two persisted columns (`audience_kind`,
 *  `audience_id`) — the inverse of how `postTaskCard` flattens it. Unknown/blank kind → null. */
function audienceFromColumns(kind: string, id: string | null): Audience | null {
  switch (kind) {
    case 'member': return id ? { kind: 'member', id } : null;
    case 'sessionOwner': return id ? { kind: 'sessionOwner', id } : null;
    case 'admins': return { kind: 'admins' };
    case 'approvers': return id === 'head' || id === 'owner' ? { kind: 'approvers', level: id } : null;
    default: return null;
  }
}

/** The `audience_id` column value for an {@link Audience} (its member id / session id / level; null for
 *  the role-set `admins`) — the inverse of {@link audienceFromColumns}, shared by every card writer. */
function audienceIdOf(a: Audience): string | undefined {
  switch (a.kind) {
    case 'member': return a.id;
    case 'sessionOwner': return a.id;
    case 'approvers': return a.level;
    case 'admins': return undefined;
  }
}

