/**
 * Terminal-native sessions. Each agent session is a real tmux shell on the box (attachable
 * in the browser via ttyd). Every side effect the session takes is routed through the SAME
 * Agentric gateway as the console — so even a raw shell can't act on anything risky without
 * a human approving it in the inbox.
 *
 * Governance over a real terminal = the agent-runner / Claude PreToolUse hook calls
 * POST /api/gate before each effect; risky ones become inbox approval cards and BLOCK.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { newId } from './id';
import { AgentOS } from './kernel';
import { Db } from './state/db';
import { containedPath, mimeOf } from './state/artifacts';
import { clipText } from './state/session-activity';
import { computeAgentStat } from './state/agent-stats';
import { agentEditable, applyAgentEdit, assessClaudeMdEdit, contentHash, diffStat, readAgentSnapshot, resolveClaudeMd } from './state/agent-edit';
import { mintToolRouterSessionAsync, COMPOSIO_KEY_HEADER, serviceUserId, type MintOptions } from './connectors/composio';
import { listConnectedAccounts } from './connectors/composio';
import { activeToolkits, resolveIdentities } from './connectors/composio-identity';
import { exclusionFor } from './connectors/composio-claims';
import { isCodingRuntime, runtimeSupports, CODING_RUNTIMES, CodingRuntimeId, ActionAttempt, AgentManifest, ApprovalLevel, AuditEvent, Decision, Member, RiskClass, Role, RunContext, RuntimeTuning, TaskRun, TaskStatus, TaskWorkers, TaskTimelineEntry, TaskDiscussionSummary, canApprove, resolveRuntimeTuning, riskClassForLevel } from './types';
import { enrichArgs, autoClearsApproval, redactSecrets } from './governance/enricher';
import { isolateClaudeConfig } from './edge/config-isolation';
import { resolveCapability } from './capabilities/normalize';
import { unwrapComposioEnvelope } from './capabilities/composio-envelope';
import { briefFor } from './governance/briefer';
import { ReliabilityMonitor } from './edge/reliability';
import { hostGovernanceDecision, stricterDecision } from './governance/host-match';
import { fileGovernanceDecision } from './governance/file-guard';
import { injectionDecision } from './governance/semantic-guard';
import { Audience, approvalAudience, resolveRecipients } from './governance/recipients';
import { JsonPolicyEngine, PolicyDelta, applyProposal, describeProposal } from './governance/policy';
import { ChatPlatform, chatLink, consolePage } from './governance/chat-links';
import { SkillSummary, CatalogSkill } from './governance/skills';
import { browseRepo, RemoteCatalog } from './governance/skill-registry';
import { claudeSupportsReloadSkills, claudeSupportsGoal, GOAL_MAX_CHARS } from './edge/claude-cli';
import { DEFAULT_IMAGE_COST_USD, resolveImageBackend, imageErrorInfo } from './edge/image-gen';
import { VendorError, retryableStatus, timedFetch, withRetry, vendorErrorInfo } from './edge/vendor-fetch';
import { DEFAULT_VIDEO_COST_PER_SEC_USD, DEFAULT_VIDEO_DURATION_SEC, resolveVideoBackend, videoBackend, VideoBackend } from './edge/video-gen';
import { understandMedia } from './edge/media-understand';
import { readSessionCost } from './edge/session-cost';
import { readTranscriptEnd } from './edge/outcome';
import { pendingBackgroundWork, BACKGROUND_GRACE_MS, UNATTENDED_TURN_BRIEF, WAITING_BRIEF } from './edge/background-work';
import { findCodexRollout, readCodexCost, readCodexConversation } from './edge/codex-transcript';
import { readConversation, findTranscript, registerTranscriptRoot, Conversation } from './edge/conversation';

// Video render tuning: a submitted job renders async. The in-call path polls briefly for the fast case;
// the tick poller finishes the rest, bounded by a TTL + a poll ceiling so a stuck render can't linger.
/** How long a just-delivered message keeps an unattended run's pane alive at turn-end, so a HOLD or a
 *  correction typed in seconds before the Stop hook fired still gets read instead of dying with the pane. */
const DELIVERY_GRACE_MS = 90_000;
/** How long after a WARM chat delivery we re-check that a turn actually started. Long enough for claude
 *  to read the keystrokes and write its first transcript line (a cold relaunch alone takes ~4s), short
 *  enough that a swallowed message is repaired while the human is still looking at the window. */
const WARM_CONFIRM_MS = 12_000;
/** How long a turn may claim to be in flight before the idle reaper stops believing it. Real turns run
 *  for minutes; one still "busy" after this is wedged, and protecting it would mean never reclaiming
 *  its pane. */
const MID_TURN_MAX_MS = 2 * 3600_000;
/** How long the LAUNCH-TIME `busy_since` prediction may stand before we stop believing a turn started.
 *  `createSession` stamps `busy_since = created_at` because a launch normally seeds a prompt — but that
 *  is a PREDICTION, not evidence, and the runtime has plenty of ways to open without ever running a turn
 *  (a resume that was handed no prompt, a rate-limited start, a trust dialog, a crash on boot). An
 *  unconfirmed prediction used to ride the full {@link MID_TURN_MAX_MS} ceiling, so the console span
 *  "working" for two hours on a session doing nothing. Real turns announce themselves fast — the
 *  `UserPromptSubmit` hook fires BEFORE claude even processes the prompt, and the gate fires on the first
 *  tool call (96% of fleet runs within 30s) — and either one PROMOTES `busy_since` off `created_at`
 *  ({@link markTurnBusy}), which is what makes "unconfirmed" a decidable state rather than a guess. */
const LAUNCH_TURN_GRACE_MS = 5 * 60_000;
/** How long after a run goes terminal we keep re-probing for a transcript that isn't on disk before
 *  concluding it never will be. A run that crashed before its runtime opened a `.jsonl` has no cost to
 *  read, ever; without a ceiling those rows are re-probed on every sessions poll forever (see the
 *  no-transcript branch in {@link TerminalManager.backfillCosts}). Generous on purpose — the only thing
 *  a too-long grace costs is a few more probes, while a too-short one would stamp a zero over a
 *  transcript that was merely slow to flush. */
const TRANSCRIPT_SETTLE_MS = 60 * 60_000;
/** How long an idle INTERACTIVE session keeps its spawn-cap slot after its last turn ended. Long enough
 *  that a human thinking between turns never loses their slot to a scheduled spawn; short enough that a
 *  TUI someone walked away from stops blocking the scheduler. Only affects ADMISSION — the session stays
 *  alive and attachable either way; reaping it is the idle reaper's separate, much longer, decision. */
const PARKED_IDLE_MS = 30 * 60_000;
/** How long one in-memory "this session is mid-turn" stamp suppresses the gate's heartbeat write. The
 *  gate fires on every tool call and `node:sqlite` is synchronous, so the write must not ride the hot
 *  path more often than it has to; the DB statement is a no-op mid-turn anyway. */
const BUSY_STAMP_THROTTLE_MS = 30_000;

/** The `report` tool's enum is `success | failure | partial`, but the loopback route stores whatever it
 *  is handed (`String(b.outcome || 'success')`), so agents have written `completed`, `progressed` and
 *  `blocked` into the column too — `src/edge/outcome.ts` already folds those in as synonyms when it
 *  derives a verdict, and the console now does the same. Normalising at the WRITE keeps one canonical
 *  vocabulary in the DB, so the synonym folding downstream is belt-and-braces rather than load-bearing
 *  (and the chat mirror stops sending ☑️ for a run that plainly succeeded). An unrecognised word is kept
 *  VERBATIM: the agent's own account beats a guess, and every reader has a pass-through for it. */
const OUTCOME_SYNONYMS: Record<string, string> = {
  completed: 'success', progressed: 'partial', blocked: 'failure', error: 'failure',
};
const normalizeOutcome = (o: string): string => OUTCOME_SYNONYMS[o.trim().toLowerCase()] ?? o.trim().toLowerCase();
const VIDEO_MAX_DURATION_SEC = 60;         // clamp the requested clip length
const VIDEO_JOB_TTL_MS = 20 * 60_000;      // give up on a render after 20 minutes
const VIDEO_MAX_POLLS = 200;               // poll-attempt ceiling (belt-and-suspenders with the TTL)
const VIDEO_INCALL_POLLS = 3;              // brief in-call polls to catch a fast render before returning
const VIDEO_INCALL_POLL_MS = 10_000;       // …10s apart (~30s max block, within tool tolerance)
// ask_agent: how long after spawn before a not-alive delegate is judged to have died WITHOUT answering
// (so `agentAskStatus` fails the caller out). A grace so a just-spawned run — whose tmux may not yet
// register — isn't misjudged; the caller polls every 3s and real answers take far longer than this.
const ASK_AGENT_GRACE_MS = 20_000;
// Stale-prompt escalation window (see TerminalManager.escalateStalePrompts). A pending approval / `ask`
// question older than MIN gets ONE reminder DM; the MAX floor keeps the first sweep from re-nudging
// long-abandoned rows in a burst (and, past MAX, a still-pending prompt is treated as dead, not nagged).
const STALE_PROMPT_MIN_MS = 3 * 60 * 60_000;   // 3h pending → re-nudge the approver/operator once
const STALE_PROMPT_MAX_MS = 3 * 24 * 60 * 60_000; // ignore anything pending longer than 3 days
/**
 * How long a `session_dms` binding keeps claiming the sender's DM replies (see {@link
 * TerminalManager.sessionForDm}). Its two siblings (`question_dms` / `approval_dms`) self-expire — the
 * bound row leaves `pending` and stops matching — but a session has no such terminal state, so the claim
 * has to be bounded by time or an agent that pinged you last month would silently swallow today's
 * unrelated "hey". A day is the shape of the real interaction: a notice you reply to at all, you reply to
 * within a working day; past that a fresh DM means a fresh request and belongs to the router.
 */
const SESSION_DM_WINDOW_MS = 24 * 60 * 60_000;
import { LauncherClient } from './edge/launcher';
import { parseSecretRef } from './edge/secrets';
import { materializeSubagents } from './edge/subagents';
import { guidanceStale } from './edge/dreaming';
import { GithubIdentity } from './edge/github-identity';
import { credentialDirHasLogin, preflightCredential } from './edge/runtime-account-check';
import type { RuntimeAccount } from './state/runtime-accounts';
import { RuntimeLoginManager } from './edge/runtime-login';
import { LauncherSessionBackend, LocalSessionBackend, SessionBackend, SpawnErrorSink } from './edge/session-backend';

/** OS-owned operating notes appended to every claude system prompt (after the user's Company context).
 *  Kept terse — it rides in every session's context. */
// Appended to every claude-code agent's system prompt (after the workspace Company context). This is
// the agent's orientation: it is otherwise a stock `claude` dropped into a folder, blind to the OS it
// runs inside. Keep it tight — it costs tokens on every session. Describe the environment and how to
// operate well in it; don't restate what the MCP tool descriptions already say.
export const AGENT_OS_OPERATING_NOTES = `# You are running inside Agentric

You are an autonomous agent operating inside **Agentric**, a governed runtime. You are not a chat
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

**Memory or the Knowledge Base?** Ask what KIND of thing you learned, not who might want it:
- **The finding goes in the KB** (\`kb_write\`) — what is true about the system, written for someone who
  wasn't there: a root cause, a measured result, a runbook, a convention. It gets a title and a reader.
- **The technique goes in memory** (\`remember\`) — how to work on this system, for your own next run:
  which box has the credentials, which tool lies to you, which probe can't fail, the flag that wasted an
  hour. Nobody wants a wiki page called "psysh evaluates line by line", and you will want it again.
When one run produces both, write both — the page for the finding, the memory for what it cost you to
get there. If the finding is big, a memory pointing at the page is worth more than a second copy of it.

## Talking to the human — use the Inbox, not just the terminal
Your terminal output may not be read. The operator lives in the Inbox:
- \`ask_human\` when you're blocked on a judgement only the human can make — it waits for their reply. Prefer
  asking over guessing on anything risky or ambiguous. This is the ONLY way to ask a person here: there
  is no human at your terminal, so a native multiple-choice/interactive prompt just hangs unanswered —
  always use \`ask_human\` (or plain text if you're in a chat), never an interactive picker.
- \`report\` exactly once when you finish, with the outcome and a one-line summary, so the result is
  visible without anyone reading the terminal. If the task taught you something durable, pass it in
  \`lessons\` — it's saved to your memory as a note to your future self.
- \`publish\` real deliverables (a document, PDF, image, chart, generated media) to the Library. The one
  rule that matters — overriding the harness's "put ALL temporary files in the scratchpad" instruction —
  is that a deliverable must live in **your working folder (your cwd)**, never the scratchpad, or
  \`publish\` can't reach it (see the tool's own notes for the details). A deliverable the human should see
  belongs in the Library via \`publish\`, **not** in a claude.ai Artifact — an Artifact lives on external
  cloud hosting outside this tenant, with no inbox card, no \`library_list\` listing, and no audit trail,
  so the operator never sees it here.

## Opening a pull request — always link back to this session
When you open a pull request (or any deliverable that carries a description), add a line linking back to
this run so a reviewer can trace the change to the audited session that produced it — the URL is in the
\`AOS_SESSION_URL\` env var (\`echo "$AOS_SESSION_URL"\`), e.g. \`Agentric session: <url>\`. Print it as a
plain URL (links aren't clickable here).

## You are one agent in a fleet — don't work alone
Other agents run in this workspace and you share state with them. You are a node, not a silo:
- **Tasks** (\`task_*\`) are the shared, durable work queue — the unit of work between "something asked"
  and "a session ran". Before non-trivial work, \`task_list\` to check it isn't already filed or in
  flight (don't duplicate), and \`task_claim\` to take one. \`task_create\` to file work: hand it to a
  specialist (\`assignee: "agent:<id>", autoDispatch: true\` spawns that agent as a governed run under the
  same accountable human), park work too big for this run, or make your own multi-step work trackable —
  then \`task_update\` to close the loop (\`done\`, or \`blocked\` with why). Prefer delegating specialised
  work over doing it poorly yourself; an unassigned task just waits for someone to pick it up.
  Every task has a **Discussion** — \`task_say({ id, message })\` to talk to the humans + agents on it (ask
  a question, hand off, give a heads-up). @mention an \`agent:<id>\` to pull that agent onto the task, or a
  teammate to ping them; plain messages stay quiet. Read it first via \`task_get\` (its \`discussion\`).
- **Goals** (\`goal_*\`) are the strategic layer your work ladders up to — **Goal → Task → this session**.
  Goals are human-owned *direction*: \`goal_list\` / \`goal_get\` to see what the fleet is working toward,
  steer your work to advance one, and link tasks to it with \`task_create({ goalId })\` so progress rolls
  up. You can't activate or edit a goal, but if you spot a direction worth making explicit, \`goal_propose\`
  a draft for a human to approve.
- **Knowledge Base** (\`kb_*\`) is the fleet's shared, living wiki. \`kb_search\` before assuming a fact
  isn't already written down; \`kb_write\` durable facts, runbooks, and conventions that help *other*
  agents and humans. (Which store gets what: see "Memory or the Knowledge Base?" above.)
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
  **Read before you write:** call \`agent_get\` first (it returns your prompt in full, plus a
  \`baseHash\` to pass back), then change it with \`claudeMdEdits\` / \`claudeMdAppend\`. A hand-retyped
  \`claudeMd\` REPLACES the whole document, so anything you forget to retype is deleted — the same is
  true of \`agent_propose_update\`, where the deleted text belongs to a teammate. Never submit part of a
  prompt hoping a human will merge it; nothing merges it.
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
  | 'manual' | 'cron' | 'webhook' | 'slack' | 'discord' | 'telegram' | 'composio' | 'scheduled' | 'task' | 'chat' | 'system';

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
   * Whether a TURN is in flight right now. For a cold-per-turn run `alive` answered this by accident (the
   * process only existed while it worked); a WARM chat session keeps its pane between turns, so liveness
   * and working came apart. Set when a turn is handed to the runtime, cleared by the Stop-hook turn-end
   * beacon. This — not `alive` — is what the chat window spins on.
   */
  working?: boolean;
  /**
   * Whether this session can be resurrected in place via `claude --resume` when its terminal is
   * re-opened (the ttyd attach wrapper sources its persisted `session-<id>.env`). True for every
   * claude-code run, unattended ones included — the env is written at launch whatever the lane, which is
   * what makes Reload / Reload-on-another-account reachable for a taken-over automation run. It says
   * nothing about WHICH lane the run is on: that's the `headless` flag. Independent of `status` too — a
   * running session is also "resumable", but the console only offers a Resume affordance once it isn't
   * live.
   */
  resumable?: boolean;
  /** True when this session can be FORKED — branched into a new independent session that inherits its
   *  full conversation (`claude --resume <parent> --fork-session`). Requires a claude-code runtime and a
   *  persisted `claude_session_id` (a conversation to branch from). Unlike `resumable`, a headless run is
   *  forkable too — forking reads the transcript, it doesn't need the parent's live launch env. */
  forkable?: boolean;
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
  /** True when this run belongs to a `category:'System'` agent — the OS machinery (concierge/operator
   *  answering Cockpit, consolidator, …), not a user teammate. The console hides these from the Chat +
   *  Sessions lists to keep them uncluttered; the row still exists for by-id opens (Cockpit's "Open full
   *  session") + Audit. */
  system?: boolean;
  /** CONVERSATION key — the claude transcript this run belongs to, falling back to the session id when
   *  there is none. A poke-back / thread continuation RESUMES a transcript, so several session rows share
   *  one `threadId`: it is the identity the console groups the list by, so a resumed conversation reads as
   *  one entry with N runs instead of N unrelated entries. */
  threadId?: string;
  /** The `threadId` of the CALLER that delegated this run — set when the run was dispatched by a task
   *  (`task:` / `ask:` / `poke:` provenance) whose `caller_claude_id` is known. Equal to `threadId` for a
   *  poke (a caller waking itself), which the console reads as "no parent". The one edge that turns the
   *  flat session list into the hand-off tree. */
  parentThreadId?: string;
  /** The task this run works (`task:`/`poke:`/`ask:` provenance) — the hand-off it belongs to. */
  taskId?: string;
  /** True when the run launched unattended (an automation/cron/task run). These now run as an attachable
   *  interactive TUI (not `claude -p`) that a human can take over live; the console badges them as
   *  unattended vs. a member's own interactive session. */
  headless?: boolean;
  /** The member id who "took over" (claimed) this unattended run to watch/steer it — set makes the
   *  session sticky (never auto-reaped at turn-end). Undefined = nobody has claimed it. */
  claimedBy?: string;
  /** True when the run is BLOCKED on a human right now — a pending `ask` question or a pending approval
   *  gate whose turn can't end until someone answers. The one authoritative "needs you" state, resolved
   *  server-side (a pending question OR approval for this run) so the console doesn't re-derive it from the
   *  message feed. Only meaningful for a live run (`status === 'running'`). Drives the "blocked" list
   *  filter and the sidebar/overview "waiting on you" treatment. */
  blocked?: boolean;
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
  /** What the run cost in USD, from its transcript's per-request token usage × model rates. Undefined
   *  while the run is live or before it's been computed (transcript not yet parsed / not written). */
  costUsd?: number;
  /** Token breakdown behind `costUsd` (uncached input / output / cache-read / cache-write). Undefined
   *  until cost is computed. */
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** What the AGENT said happened, from its end-of-session `report` — 'success' | 'failure' | 'partial'
   *  | 'unknown' | … Orthogonal to `status`, which only says how the PROCESS ended: a `done` session can
   *  carry a `failure` outcome, and an `unknown` outcome on a finished run means nobody closed the loop.
   *  Undefined while the run is live or before it's been stamped. */
  outcome?: string;
  /** The report's one-line summary — the human-readable "what came of it" behind {@link outcome}. */
  summary?: string;
  /** ENGAGED milliseconds, from the transcript (idle gaps excluded) — the honest answer to "how long
   *  did this take". Wall-clock (`updatedAt - createdAt`) is not: an interactive session idles between
   *  turns, so it routinely spans hours or days of nothing. Undefined until stamped. */
  activeMs?: number;
  /** Real user prompts in the conversation (1 for a one-shot headless run, many for a steered one). */
  turns?: number;
  /** Tool calls the agent issued — the true activity volume, unlike `insights.actions` which counts
   *  only the subset of effects the gate mediates. */
  toolCalls?: number;
  /** The governance fingerprint of the run, counted off its audit stream: `actions` = governed effects
   *  (gate.decision), `approvals` = human gates hit, `denied` = policy denials + rejected approvals,
   *  `errors` = session/episode errors. Live rows carry the running tally; terminal rows the stamped
   *  final one. Definitions mirror `episodeSalience`, which grades the same signals for memory. */
  insights?: { actions: number; approvals: number; denied: number; errors: number };
  /** The runtime tuning the run launched with — the model id and reasoning effort (`session.tuning`).
   *  Undefined for whichever lane the run left on the workspace default. Surfaced now that both are
   *  per-task overridable, so "what ran this, how hard" reads next to what it cost. */
  model?: string;
  effort?: string;
  /** Claude Code output style the run launched with ('Default' | 'Concise' | a library style).
   *  Undefined on runs that predate the knob, and on runtimes that have no output styles — those are
   *  excluded from the adoption counts rather than assumed Default. */
  outputStyle?: string;
  /** Total milliseconds the run sat BLOCKED on a human — approval gates plus `ask` questions. The
   *  governed-OS latency no other field captures; a big number next to a small `activeMs` is a run that
   *  mostly waited on people. Undefined until stamped; 0 when it never blocked. */
  blockedMs?: number;
  /** How many deliverables the run published to the Library (`artifacts` rows). Undefined until stamped. */
  artifacts?: number;
}

/** Something in a chain node that can't proceed without a person: an unanswered `ask`, or an approval
 *  gate holding a run open. Carries the id its resolve route takes, so the rail answers in place. */
export interface ChainPending {
  kind: 'question' | 'approval';
  /** The question / approval id — `POST /api/questions/:id` or `POST /api/approvals/:id`. */
  id: string;
  sessionId: string;
  agent: string;
  /** The question text, or the policy's reason this action needs sign-off. */
  text: string;
  capability?: string;
  level?: ApprovalLevel;
  createdAt: number;
}

/** One CONVERSATION in a hand-off chain — every run sharing a claude transcript folded into a single
 *  entry (`runs` of them), positioned in the delegation tree by `parentThreadId` + `depth`. */
export interface ChainNode {
  threadId: string;
  /** The conversation that delegated this one. Absent on the root. */
  parentThreadId?: string;
  depth: number;
  /** The newest run of the conversation — what "open this node" attaches to. */
  sessionId: string;
  tmux: string;
  agent: string;
  title: string;
  summary?: string;
  status: SessionStatus;
  alive?: boolean;
  /** True when the newest run launched unattended (automation/task dispatch) — the rail draws it as a
   *  hollow ring, exactly like the sessions list, so "the fleet is doing this" reads differently from
   *  "someone is driving this". */
  headless?: boolean;
  /** True when this conversation is LIVE and blocked on a human right now (its own pending ask/approval).
   *  The one state that must not read as "working". */
  blocked?: boolean;
  /** True when a TURN is in flight on the newest run — the same `busy_since` signal the session list
   *  carries as `working`. A warm conversation keeps its pane between turns, so `alive` alone can't tell
   *  "generating right now" from "sitting there waiting for someone to type". */
  working?: boolean;
  outcome?: string;
  /** How many session rows this conversation spans (>1 = it was resumed by pokes/continuations). */
  runs: number;
  /** Cost summed across every run of the conversation. */
  costUsd?: number;
  createdAt: number;
  updatedAt: number;
  /** `root` = the conversation the chain starts at; `delegate` = dispatched for a task; `answer` = an
   *  ephemeral quick-answer run (`ask:` provenance) that never took the task over. */
  kind: 'root' | 'delegate' | 'answer';
  taskId?: string;
  taskTitle?: string;
  taskStatus?: TaskStatus;
  /** Set when an earlier sibling already handed the SAME work to the SAME agent — the duplicate
   *  re-dispatch a flat list hides. Holds the task id it repeats. */
  duplicateOf?: string;
  pending: ChainPending[];
}

/** The hand-off tree a session belongs to — see {@link TerminalManager.sessionChain}. */
export interface SessionChain {
  rootThreadId: string;
  /** Flat, in walk order (parents before children); render as a tree via `parentThreadId`/`depth`. */
  nodes: ChainNode[];
  /** Distinct agents taking part — the chain's headline "3 agents". */
  agents: number;
  totalCostUsd?: number;
  startedAt: number;
  updatedAt: number;
}

/** Chain-walk bounds. Deep enough for any real hand-off (the deepest observed in the fleet is 3), tight
 *  enough that a cyclic or pathological graph can't turn one request into an unbounded crawl. */
const CHAIN_MAX_DEPTH = 8;
const CHAIN_MAX_NODES = 60;

/** The task id behind a dispatched run's provenance — `task:<id>` (working it), `ask:<id>` (quick answer
 *  on it), or `poke:<id>` (the caller woken because it finished). Undefined for every other origin. */
function taskOfProvenance(spawnedBy: string | null | undefined): string | undefined {
  const m = spawnedBy ? /^(?:task|poke|ask):(.+)$/.exec(spawnedBy) : null;
  return m ? m[1] : undefined;
}

/** Flag re-dispatches: among siblings of one caller, a delegate to the same agent for the same task
 *  title is the SECOND (or third) attempt at work already handed off. First one wins; the rest carry
 *  `duplicateOf`. Mutates in place — the nodes are already in walk (chronological) order. */
function markDuplicateDispatches(nodes: ChainNode[]): void {
  const firstSeen = new Map<string, string>();
  for (const n of nodes) {
    if (!n.taskId || !n.parentThreadId || n.kind === 'root') continue;
    const key = `${n.parentThreadId}|${n.agent}|${(n.taskTitle ?? n.title).trim().toLowerCase().replace(/\s+/g, ' ')}`;
    const first = firstSeen.get(key);
    if (first && first !== n.taskId) n.duplicateOf = first;
    else if (!first) firstSeen.set(key, n.taskId);
  }
}

export interface FeedMessage {
  id: string;
  type: 'task' | 'task.chat' | 'task.mention' | 'update' | 'approval' | 'question' | 'completed' | 'artifact' | 'notification' | 'skill.proposed' | 'goal.proposed' | 'goal.ready' | 'goal.update.proposed' | 'skill.request' | 'secret.request' | 'host.proposed' | 'app.proposed' | 'policy.proposal' | 'automation.proposed' | 'agent.update.proposed' | 'connection.request' | 'connection.expired';
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
// On a deny, `reason` (the classifier's human account — see describeMatch/hostGovernanceDecision) and the
// classified `capability` ride back to the hook so the agent is told WHY it was blocked and WHICH rule
// fired, instead of an opaque "this action is blocked". The rich reason already existed (audit trail +
// approval cards); it was just dropped before the wire. Diagnosability, not permissiveness.
type GateResult = { decision: 'allow' | 'deny' | 'pending'; gateId?: string; note?: string; reason?: string; capability?: string };

/** The automation columns the per-row label/source/authz helpers read — see `TerminalManager.withRowCache`. */
interface AutomationLookup {
  name: string;
  type: string;
  created_by: string | null;
}

interface SessionRow {
  id: string;
  agent: string;
  title: string;
  task: string;
  tmux: string;
  status: SessionStatus;
  spawned_by: string | null;
  run_as: string | null;
  claude_session_id: string | null;
  headless: number | null;
  claimed_by: string | null;
  claimed_at: number | null;
  created_at: number;
  updated_at: number;
  rating: string | null;
  rated_by: string | null;
  rated_at: number | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  outcome: string | null;
  report_summary: string | null;
  active_ms: number | null;
  turns: number | null;
  tool_calls: number | null;
  archived_at?: number | null;
  busy_since: number | null;
  /** Last turn-END (or delivery) stamp. Paired with `busy_since` it says whether the CURRENT turn is
   *  still in flight — see {@link TerminalManager.isWorking}. */
  last_activity: number | null;
  gov_actions: number | null;
  gov_approvals: number | null;
  gov_denied: number | null;
  gov_errors: number | null;
  model: string | null;
  effort: string | null;
  output_style: string | null;
  blocked_ms: number | null;
  artifacts: number | null;
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
  /** The pending approval's id — the notifier binds it to the DM(s) it sends so a reply (approve/deny)
   *  can resolve the gate, the approval-side twin of {@link QuestionNotice.questionId}. */
  approvalId: string;
  sessionId: string;
  agent: string;
  capability: string;
  level: ApprovalLevel;
  riskClass: 'yellow' | 'red';
  reason?: string;
  /** The decision-brief headline — a legible summary of the effect ("Run a deploy-status check…"),
   *  so the out-of-band DM leads with WHAT the agent wants, not just the capability + terse reason. */
  headline?: string;
}

/**
 * Read a Slack/Discord DM reply as an approve / deny decision for a pending approval. Deliberately
 * conservative: matches on the FIRST token (so "approve", "yes go ahead", "👍" ⇒ approve; "deny",
 * "no", "reject it", "👎" ⇒ deny) or a whole-message emoji, and returns `null` for anything ambiguous
 * so the caller prompts for a clear yes/no rather than guessing wrong on a governance decision.
 */
export function parseApprovalIntent(text: string): 'approve' | 'deny' | null {
  const t = (text || '').trim().toLowerCase().replace(/[.!,]+$/, '');
  if (!t) return null;
  const first = t.split(/\s+/)[0];
  const APPROVE = new Set(['approve', 'approved', 'approves', 'yes', 'y', 'yeah', 'yep', 'yup', 'ok', 'okay', 'k', 'sure', 'go', 'allow', 'allowed', 'lgtm', 'accept', 'accepted', '👍', '✅', '👌']);
  const DENY = new Set(['deny', 'denied', 'reject', 'rejected', 'no', 'n', 'nope', 'nah', 'block', 'blocked', 'stop', 'decline', 'declined', '👎', '❌', '🚫']);
  if (APPROVE.has(t) || APPROVE.has(first)) return 'approve';
  if (DENY.has(t) || DENY.has(first)) return 'deny';
  if (/[👍✅👌]/u.test(t)) return 'approve';
  if (/[👎❌🚫]/u.test(t)) return 'deny';
  return null;
}

/** What the question-notifier sink receives when an agent asks the human a question — so an out-of-band
 *  channel (Slack/Discord DM) can ping the person the run acts for, the way approvals already ping
 *  approvers. Without it a blocking `ask` sits unseen in the console until it times out. */
export interface QuestionNotice {
  /** The pending question's id — the notifier binds it to the DM(s) it sends so a reply can answer it. */
  questionId: string;
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

/** What the review-notifier sink receives when an agent files something for owner/admin REVIEW — a
 *  credential request (`secret_request`), a skill proposal/install request (`skill_propose`/`skill_request`),
 *  a host proposal (`host_propose`), or a policy proposal (`policy_propose`). One out-of-band push for the
 *  whole "agent asks a human to approve X" family, the review-side twin of the approval/question notifiers:
 *  before this the review CARD landed in the inbox but nobody was ever pinged, so a request could sit unseen
 *  until an owner happened to open Settings. The registry DMs the `admins` tier — the audience every one of
 *  these cards is already addressed to. `kind` is the card type (drives the DM icon + deep-link); `title`
 *  and `summary` are the card's own heading/body reused verbatim. */
/** The review kinds that are also a `messages.type` — i.e. everything an AGENT raises. `system.update`
 *  is deliberately excluded: it is an OS-raised notice delivered as a plain `notification` card, so it
 *  travels the DM path without inventing a message type nothing renders. */
export type ReviewCardKind = Exclude<ReviewNotice['kind'], 'system.update'>;

export interface ReviewNotice {
  sessionId: string;
  agent: string;
  kind: 'secret.request' | 'skill.proposed' | 'skill.request' | 'host.proposed' | 'policy.proposal' | 'automation.proposed' | 'agent.update.proposed' | 'goal.update.proposed' | 'connection.request' | 'connection.expired' | 'system.update';
  title: string;
  summary: string;
  /** Whom to DM. Defaults (in the registry's `notifyReview`) to the `admins` tier — the audience nearly
   *  every review card is addressed to. A PERSONAL connection request overrides it to the run's own
   *  member, since only they can complete the OAuth for their own account. */
  audience?: Audience;
  /** Where the DM's link lands, when the card is about ONE named object and the kind's default page is a
   *  list. Overrides {@link REVIEW_PRESENTATION}'s page for this notice: an `agent.update.proposed` points
   *  at `#/agent/<target>` — the target agent's settings page, where the review card actually is — instead
   *  of dropping the reviewer on the Agents index to find it themselves (parity with the inbox row, which
   *  has deep-linked by target all along). `label` names the destination in the DM text. */
  link?: { page: string; detail?: string; label?: string };
}

/** What an agent's `secret_request` is asking a human to do with the KEY it named:
 *  `provide` (the vault has nothing — type a value), `access` (it exists but is scoped away — grant it),
 *  `rotate` (the agent CAN read it but the value is being rejected — replace it). Detected server-side
 *  in {@link TerminalManager.requestSecret}; the agent only says which key and why. */
export type SecretRequestMode = 'provide' | 'access' | 'rotate';

/** Read a `secret.request` card's stored `mode`, defaulting to 'provide' for an unknown/legacy value. */
function parseSecretRequestMode(v: unknown): SecretRequestMode {
  return v === 'access' || v === 'rotate' ? v : 'provide';
}

/** The spec an agent proposes for a new automation — the subset of `AddAutomationInput` an agent may
 *  suggest. It rides in the `automation.proposed` review-card args and is fed to `Automations.add` only
 *  once a human approves (so an unapproved automation is never created and can never fire). */
export interface ProposedAutomation {
  agentId: string;
  name: string;
  type: 'cron' | 'webhook' | 'composio' | 'slack' | 'discord';
  schedule?: string;
  filter?: string;
  task: string;
  mode?: 'headless' | 'interactive';
  /** The member id the fired session should act AS. An unattended run defaults to the company identity
   *  (only the shared company Composio + org/shared connectors); set this when the task needs a person's
   *  OWN connected apps (their personal Composio Gmail/ClickUp/etc.), which are injected only under their
   *  identity. The proposing agent may suggest it (by member id or email, resolved at propose time); the
   *  approving owner/admin sees whose credentials will be used and consents by approving. */
  runAs?: string;
}

/** What the session-event notifier sink receives when one of a member's own sessions changes state — it
 *  began (a delegated/unattended run), started waiting on them, finished, or crashed. The registry DMs the
 *  run's owner (its `run_as`, else the console member who spawned it) on Slack/Discord IF that member opted
 *  into `dm` notifications (except `crashed`, an always-on failure signal that also escalates to admins).
 *  Most kinds also write an inbox card inline; `started` is DM-only (no card — the feed stays agent-
 *  authored, not a lifecycle log). Approvals/questions have their own (always-on) notifiers. */
export interface SessionEventNotice {
  sessionId: string;
  agent: string;
  kind: 'started' | 'waiting' | 'completed' | 'crashed';
  title: string;
  message: string;
}

/** What the transfer sink receives when a session is handed off to another member ({@link
 *  TerminalManager.transferSession}). The new owner inherits accountability for a run they didn't start,
 *  so the registry DMs them out-of-band on their linked Slack/Discord — a hand-off nobody sees is a
 *  hand-off nobody picks up. Always-on (not gated on the `dm` pref): a deliberate person-to-person
 *  reassignment is a direct ask, not a lifecycle beat. */
export interface TransferNotice {
  sessionId: string;
  agent: string;
  /** Member id of the new owner (the session's new `run_as`). */
  to: string;
  /** The human who performed the hand-off. */
  byName: string;
  /** Session display title, when it has one. */
  title?: string;
}

/** Everything the runtime launcher needs for ONE launch of a session row. Named (rather than inline)
 *  because the launch is now scheduled and executed in two steps — see `launchAgentRuntime`. */
interface LaunchSpec {
  id: string; agent: string; task: string; secret: string;
  actingMember?: string; spawnedBy?: string; hasSlack: boolean; hasDiscord: boolean; hasClickup: boolean; hasTelegram: boolean;
  headless: boolean; resident: boolean; resume: boolean;
  /** The transcript id to pin. NULL for a runtime that mints its own (Codex) — the launcher
   *  discovers it and reports it back via /api/runtime-session instead. */
  claudeSessionId: string | null;
  /** Per-launch tuning override (highest priority over the agent manifest + workspace default) — e.g. a
   *  delegated task pinning the model/effort of its dispatched session. Undefined → resolve as before. */
  tuning?: RuntimeTuning;
  /** Fork: branch this NEW session (claudeSessionId) off an existing conversation (forkFrom). The
   *  launcher's FORK_FROM branch runs `claude --resume <forkFrom> --fork-session --session-id
   *  <claudeSessionId>` on first launch; a reattach (resume:true) resumes the fork's own branch. */
  forkFrom?: string;
}

/**
 * The name an inbound chat attachment takes inside an agent's `.inbox/`. Exported because the chat
 * sockets must name the file in the PROMPT before the session (and therefore the agent folder) exists
 * — if the two sanitizers ever disagreed, the agent would be told to Read a path that isn't there.
 */
export function inboxFileName(name: string): string {
  const clean = (name || 'file').split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80);
  return clean || 'file';
}

export class TerminalManager {
  /** Scripted demo runner — for `runtime: mock` agents. */
  private readonly runner = path.resolve(__dirname, '../terminal/agent-runner.sh');
  /** Real-Claude launcher — for `runtime: claude-code` agents. Opens claude in the agent's folder.
   *  Kept as a named field because the uid-isolation launcher path still references it directly. */
  private readonly launcher = path.resolve(__dirname, '../terminal/claude-launch.sh');
  /** The launcher for a given coding runtime (`terminal/<spec.launchScript>`). */
  private launchScriptFor(runtime: CodingRuntimeId): string {
    return path.resolve(__dirname, '..', 'terminal', CODING_RUNTIMES[runtime].launchScript);
  }
  /** PreToolUse gate hook for the runtimes that share it (claude-code + codex; $AOS_RUNTIME picks
   *  the routing table). Kept as a named field because the uid-isolation launcher references it. */
  private readonly hook = path.resolve(__dirname, '../terminal/gate-hook.sh');
  /** The gate artifact for a given runtime (`terminal/<spec.gateHook>`), exported to the launcher as
   *  $HOOK. Usually the shared shell hook above; opencode has no command-hook facility at all, so its
   *  gate is a JS plugin the launcher copies into the session's plugin dir instead. */
  private gateHookFor(runtime: CodingRuntimeId): string {
    return path.resolve(__dirname, '..', 'terminal', CODING_RUNTIMES[runtime].gateHook);
  }
  /** OS-owned memory MCP server (compiled JS), injected into every CLI-backed session. */
  private readonly memoryMcp = path.resolve(__dirname, 'memory/memory-mcp.js');
  private readonly db: Db;
  /** Where sessions actually run: the shared local socket (default) or per-member uids via the
   *  launcher when AOS_UID_ISOLATION=1 (Phase A). Selected once at construction. */
  private readonly backend: SessionBackend;
  /** Guided runtime-account login — the console-driven `claude login` that produces a credential dir.
   *  Public: the API routes drive it directly (see `src/edge/runtime-login.ts`). */
  readonly logins: RuntimeLoginManager;
  /** Phase A flag — when on, per-session files are handed to the launcher (written in the member
   *  home) rather than the app dir, and resurrect/.env (a local-ttyd feature) is skipped. */
  private readonly uidIsolation = process.env.AOS_UID_ISOLATION === '1';
  /** Idle grace before a member's uid/ttyd is reclaimed once they have no running sessions (A5). */
  private readonly idleGraceMs = Number(process.env.AOS_IDLE_GRACE_MS) || 15 * 60_000;
  /** Online behavioural-failure watch (phase 3): detects a no-progress LOOP within a run and nudges the
   *  agent via an `instruct` (allow + advisory note). In-memory per session. Off when AOS_RELIABILITY=0. */
  private readonly reliability = new ReliabilityMonitor();
  private readonly reliabilityOn = process.env.AOS_RELIABILITY !== '0';
  /** Sessions whose runtime launch is SCHEDULED but whose pane doesn't exist yet (see
   *  `launchAgentRuntime`). `reachable` counts them as live so the window between "row written" and
   *  "tmux up" can't be read as "nothing is running" — which would let a second turn launch a
   *  competing claude on the same transcript. */
  private readonly launching = new Set<string>();
  /** sessionId → when the gate heartbeat last stamped it. Purely a write throttle (see
   *  {@link BUSY_STAMP_THROTTLE_MS}); the DB is the source of truth and `clearTurnBusy` drops the entry. */
  private readonly busyStamped = new Map<string, number>();
  /** Pending "did that warm turn actually start?" checks, keyed by session — see `confirmWarmTurn`.
   *  Held so a newer message can cancel the previous check instead of racing it. */
  private readonly warmChecks = new Map<string, ReturnType<typeof setTimeout>>();
  /** sessionId → when its turn-end teardown was FIRST deferred for outstanding background work (see
   *  `markTurnIdle`). The clock for {@link BACKGROUND_GRACE_MS}: held per RUN, not per turn, so ending
   *  more turns can't renew the grace. In-memory on purpose — a restart forgetting it costs at most one
   *  more grace window, and the idle-straggler backstop bounds that anyway. */
  private readonly turnEndDeferred = new Map<string, number>();
  /** Optional sink notified when an approval card lands, so an out-of-band channel (Slack/Discord DM)
   *  can ping the approver. Set by the registry once the chat sockets exist; absent = no notifications. */
  private approvalNotifier?: (notice: ApprovalNotice) => void;
  setApprovalNotifier(fn: (notice: ApprovalNotice) => void): void { this.approvalNotifier = fn; }
  /** Optional sink notified when an agent asks the human a question — mirrors the approval notifier so
   *  a blocking `ask` pings the run-as member out-of-band instead of sitting unseen. */
  private questionNotifier?: (notice: QuestionNotice) => void;
  setQuestionNotifier(fn: (notice: QuestionNotice) => void): void { this.questionNotifier = fn; }

  /**
   * Re-nudge stale human-in-the-loop prompts: an approval or `ask` question that has sat pending past
   * {@link STALE_PROMPT_MIN_MS} (and is younger than {@link STALE_PROMPT_MAX_MS}) gets its out-of-band
   * DM fired a SECOND time — via the SAME {@link approvalNotifier}/{@link questionNotifier} the original
   * ask used, so the reminder re-binds the reply-to-decide DM channel and reaches the same audience.
   * Exactly once per item (a durable `escalated_at` marker, like the overdue-task sweep), so a restart
   * never re-alarms and the max-age floor stops the first sweep from bursting on historically-abandoned
   * rows. Only prompts whose session is still `running` are nudged — a dead run's orphaned gate is moot.
   * Driven by the scheduler tick (see {@link Automations.setStalePromptSweeper}); best-effort, never throws.
   */
  escalateStalePrompts(now: number): void {
    const min = Number(process.env.AOS_STALE_PROMPT_MIN_MS) || STALE_PROMPT_MIN_MS;
    const max = Number(process.env.AOS_STALE_PROMPT_MAX_MS) || STALE_PROMPT_MAX_MS;
    const isRunning = (runId: string): boolean =>
      this.db.prepare("SELECT 1 FROM term_sessions WHERE id = ? AND status = 'running' LIMIT 1").get(runId) != null;
    // Approvals — the store owns the age/marker query; we add the liveness filter + rebuild the notice
    // (approval rows don't carry the agent name or riskClass, so derive both here).
    for (const a of this.os.approvals.staleForEscalation(min, max, now, this.os.tenant)) {
      if (!isRunning(a.runId)) continue;
      if (!this.os.approvals.markEscalated(a.id, now)) continue;
      const agent = this.db.prepare('SELECT agent FROM term_sessions WHERE id = ?').get<{ agent: string }>(a.runId)?.agent ?? 'agent';
      try {
        this.approvalNotifier?.({ approvalId: a.id, sessionId: a.runId, agent, capability: a.attempt.capabilityId, level: a.level, riskClass: riskClassForLevel(a.level), reason: a.reason });
      } catch { /* notifications are advisory */ }
      this.audit(a.runId, agent, 'approval.escalated', { approvalId: a.id, level: a.level, capability: a.attempt.capabilityId, ageMs: now - a.createdAt });
    }
    // Questions — this table lives here, so query it directly for the same window + one-time marker.
    const minCreated = now - max, maxCreated = now - min;
    const stale = this.db
      .prepare("SELECT id, run_id, agent, prompt, audience_id, created_at FROM questions WHERE status = 'pending' AND escalated_at IS NULL AND created_at <= ? AND created_at >= ? ORDER BY created_at")
      .all<{ id: string; run_id: string; agent: string; prompt: string; audience_id: string | null; created_at: number }>(maxCreated, minCreated);
    for (const q of stale) {
      if (!isRunning(q.run_id)) continue;
      const marked = this.db.prepare("UPDATE questions SET escalated_at = ? WHERE id = ? AND escalated_at IS NULL AND status = 'pending'").run(now, q.id);
      if (marked.changes === 0) continue;
      try {
        this.questionNotifier?.({ questionId: q.id, sessionId: q.run_id, agent: q.agent, prompt: q.prompt, to: q.audience_id ?? undefined });
      } catch { /* notifications are advisory */ }
      this.audit(q.run_id, q.agent, 'question.escalated', { questionId: q.id, ageMs: now - q.created_at });
    }
  }

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
  /** Optional sink notified when an agent files a request/proposal for owner/admin review (secret / skill /
   *  host / policy). The one out-of-band push shared by every `postReviewCard` caller so a pending request
   *  DMs the admin tier instead of only sitting in the inbox. Set by the registry once the chat sockets
   *  exist; absent = no push (the review card is always written regardless). */
  private reviewNotifier?: (notice: ReviewNotice) => void;
  setReviewNotifier(fn: (notice: ReviewNotice) => void): void { this.reviewNotifier = fn; }
  /** Optional sink notified when one of a member's sessions starts waiting / finishes / crashes, so the
   *  registry can DM the run's owner out-of-band (gated on their `dm` preference). Set by the registry
   *  once the chat sockets exist; absent = no push (the inbox card is always written regardless). */
  private sessionEventNotifier?: (notice: SessionEventNotice) => void;
  setSessionEventNotifier(fn: (notice: SessionEventNotice) => void): void { this.sessionEventNotifier = fn; }
  /** Optional sink notified when a session is handed off to another member, so the registry can DM the
   *  new owner. Set by the registry once the chat sockets exist; absent = no push (the transfer itself
   *  still happens and is audited regardless). */
  private transferNotifier?: (notice: TransferNotice) => void;
  setTransferNotifier(fn: (notice: TransferNotice) => void): void { this.transferNotifier = fn; }
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
    // Guided runtime-account login (Settings → Runtime accounts): short-lived panes running the runtime's
    // OWN login so an operator never has to ssh in to produce a credential dir. It lives here because
    // this is what owns the tmux backend — it has nothing to do with agent sessions and never spawns one.
    this.logins = new RuntimeLoginManager({
      backend: this.backend,
      // Empty when this instance has no data home (demo/in-memory) — the manager refuses to start there
      // rather than scattering credential dirs in the process's cwd.
      accountsDir: os.paths ? path.join(os.paths.home, 'runtime-accounts') : '',
      accounts: os.runtimeAccounts,
      audit: (type, data) => this.audit('-', 'system', type, data),
    });
    this.refreshTranscriptRoots();
    this.sweepLaunchMarkers();
    this.sweepStaleSkillProposals();
  }

  /** One-shot boot heal for review cards left open by the pre-v0.404.1 skills routes, which resolved the
   *  SKILL but never its 'skill.proposed' card — so a published draft / applied edit sat in "Needs you"
   *  forever. Re-derives each open card's fate from the library (the only source of truth left): a draft
   *  that is now published reads as approved, one whose folder is gone as rejected, and an edit card with
   *  no parked edit as `resolved` (applied vs discarded is no longer distinguishable — and the card is
   *  dead either way). Anything still genuinely pending is left alone. Cheap: open cards only, once per
   *  process. */
  private sweepStaleSkillProposals(): void {
    try {
      const rows = this.db
        .prepare(`SELECT id, args FROM messages WHERE type = 'skill.proposed' AND status = 'open'`)
        .all<{ id: string; args: string | null }>();
      if (!rows.length) return;
      const upd = this.db.prepare(`UPDATE messages SET status = ? WHERE id = ?`);
      let healed = 0;
      for (const r of rows) {
        let a: Record<string, unknown> = {};
        try { a = r.args ? JSON.parse(r.args) : {}; } catch { continue; }
        const name = String(a.skill ?? '');
        if (!name) continue;
        const skill = this.os.skills.get(name);
        let status: string | undefined;
        if (a.edit === true) { if (!skill || !this.os.skills.pendingEdit(name)) status = 'resolved'; }
        else if (!skill) status = 'rejected';
        else if (!skill.proposed) status = 'approved';
        if (!status) continue;
        upd.run(status, r.id); healed++;
      }
      if (healed) this.audit('-', 'system', 'skill.proposals.healed', { count: healed });
    } catch { /* advisory — never block boot on a heal */ }
  }

  /** Teach the transcript reader where rotated sessions wrote their conversations. Without it the console's
   *  conversation view (and the transcript fallback in `detectUsageLimit`) only ever sees the SERVER's own
   *  `~/.claude/projects`, so every run made under a pooled account reads back as "no transcript". Called
   *  again before each read rather than only at boot: a pool account added later would otherwise stay
   *  invisible for the lifetime of the process. Cheap (one small query) and idempotent. */
  private refreshTranscriptRoots(): void {
    try { for (const dir of this.os.runtimeAccounts.configDirs()) registerTranscriptRoot(dir); } catch { /* pool is optional */ }
  }

  /** The launcher "space" (member-uid identity) a session runs in: the spawning member, or a shared
   *  `automations` space for system/automation spawns. The local backend ignores it. */
  private spaceFor(spawnedBy?: string | null): string {
    // System spawns with no run-as member (an automation or an ownerless task) share the `automations`
    // space rather than minting a per-provenance uid — a `task:<id>` is unique per task, so bucketing
    // by it would leak a space per ownerless task. A task WITH an owner passes run_as here (→ the member).
    if (!spawnedBy || spawnedBy.startsWith('automation:') || spawnedBy.startsWith('task:') || spawnedBy.startsWith('poke:')) return 'automations';
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

  /** term_sessions column names, read once (PRAGMA at boot-stable schema) for the clipped projection. */
  private termCols?: string[];
  /**
   * SELECT column list for a sessions query. `undefined` clip → `*` (verbatim, full `task`, for callers
   * that read the whole prompt — e.g. `sessionsForAgent`). A numeric clip → every column verbatim EXCEPT
   * `task`, which becomes `substr(task,1,clip+1)` so the LIST path stops materialising the full prompt
   * (up to ~53 KB/row on globex; 2.1 MB → 0.2 MB per poll, ~33% off the query) out of SQLite just for
   * `server.ts` to clip it to 240. The `+1` lets the downstream `clipText()` still detect truncation and
   * keep the ellipsis, so the wire output is byte-identical.
   */
  private sessionSelectCols(taskClip?: number): string {
    if (!taskClip) return '*';
    const cols = (this.termCols ??= this.db.prepare('PRAGMA table_info(term_sessions)').all<{ name: string }>().map((c) => c.name));
    const n = Math.max(1, Math.floor(taskClip)) + 1; // integer, in-code constant — safe to inline
    return cols.map((c) => (c === 'task' ? `substr(task,1,${n}) AS task` : `"${c}"`)).join(', ');
  }
  /**
   * Sessions visible to `viewer`. owner/admin (or an omitted viewer — internal callers) see all; a
   * regular member sees only sessions they spawned, plus sessions fired by an automation they created.
   * `taskClip` (list endpoint only) fetches `task` pre-truncated to that many chars — see sessionSelectCols.
   */
  /**
   * Is a turn in flight on this row RIGHT NOW — the console's `working` (a spinner), as opposed to a live
   * pane that is merely warm (`ready`). Four conditions, each one a way the old single-expression version
   * lied:
   *
   *  1. **a turn was started** (`busy_since`). Stamped by `UserPromptSubmit` / a server-side delivery,
   *     cleared by every turn-end path (`clearTurnBusy`).
   *  2. **the row is not already finished.** `stopped`/`crashed` are terminal — whatever the flag says,
   *     nothing is generating. (`done` still counts: an agent that calls `report` flips its row to `done`
   *     MID-turn and keeps working, so excluding it would blank the spinner on a genuinely busy run.)
   *  3. **the runtime is still there to run it** — a pane that died mid-turn leaves the flag set.
   *  4. **no turn-END was recorded AFTER this turn started.** `last_activity` is stamped by every
   *     turn-end path, including the ones the old code reached without clearing `busy_since` — so
   *     `last_activity > busy_since` means "that turn is over" even on a row latched by an older build.
   *     This is what heals the existing fleet without waiting on anything.
   *  5. **the stamp is not ANCIENT.** Older than `MID_TURN_MAX_MS` = wedged, not working — the same
   *     judgement the resident reaper makes. This measures ACTIVITY, not turn age: the gate re-stamps
   *     past the ceiling (see {@link markTurnBusy}), so a genuinely long turn keeps its spinner while a
   *     wedged one — which emits nothing — ages out. The backstop for a run that produced no end signal
   *     at all, so it stops reading as "working" on its own instead of spinning forever.
   *  6. **the turn was CONFIRMED, not merely predicted.** `busy_since === created_at` is the untouched
   *     launch stamp: we assumed a turn would start and no turn signal has landed since. That assumption
   *     is wrong whenever the runtime opens without running a turn, and it used to hold the spinner for
   *     the full 2h ceiling. Give it {@link LAUNCH_TURN_GRACE_MS} — well past the ~30s in which a real
   *     turn promotes the stamp — then read it for what it is: a launch that never became work.
   */
  private isWorking(r: { id: string; tmux: string; status: string; busy_since: number | null; last_activity: number | null; created_at: number }, alive: Set<string> | null): boolean {
    if (r.busy_since == null) return false;
    if (r.status === 'stopped' || r.status === 'crashed') return false;
    if (r.last_activity != null && r.last_activity > r.busy_since) return false;
    if (r.busy_since < Date.now() - MID_TURN_MAX_MS) return false;
    if (r.busy_since === r.created_at && r.busy_since < Date.now() - LAUNCH_TURN_GRACE_MS) return false;
    return this.launching.has(r.id) || !alive || alive.has(r.tmux);
  }

  listSessions(viewer?: Member, taskClip?: number, ids?: string[]): Session[] {
    // Memoize the member/automation lookups for this call — the per-row helpers below would otherwise
    // re-query them ~2x per row. See withRowCache().
    return this.withRowCache(() => this.listSessionsUncached(viewer, taskClip, ids));
  }
  private listSessionsUncached(viewer?: Member, taskClip?: number, ids?: string[]): Session[] {
    // Archived sessions are hidden from the list (reversible soft-archive via the Insights declutter tile);
    // their rows survive for every by-id reference (task-reconcile, audit, cost).
    //   `ids` = the by-id / batch fetch (Sessions-pagination Phase 1): return exactly those sessions with
    //   the same derived fields the list carries, still viewer-scoped below. It intentionally matches by id
    //   REGARDLESS of archived_at (so a by-id/notification-open resolves an archived session too); an empty
    //   list short-circuits (`IN ()` is a syntax error). The unfiltered list keeps hiding archived rows.
    if (ids && ids.length === 0) return [];
    const where = ids ? `id IN (${ids.map(() => '?').join(',')})` : 'archived_at IS NULL';
    const rows = this.db.prepare(`SELECT ${this.sessionSelectCols(taskClip)} FROM term_sessions WHERE ${where} ORDER BY created_at DESC`).all<SessionRow>(...(ids ?? []));
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
        // `launching` shields a run whose pane is still being brought up — a RE-launch (a chat turn, a
        // revive) reuses an old row, so `created_at` grace doesn't cover it and the poll would otherwise
        // read the gap as a crash.
        if (r.status === 'running' && !alive.has(r.tmux) && r.created_at < cutoff && !this.launching.has(r.id)) this.markCrashed(r);
      }
    }
    const visible = viewer ? rows.filter((r) => this.canViewRow(r.spawned_by, r.run_as, viewer)) : rows;
    // Cost is derived from the transcript once a run is terminal, then cached on the row. Backfill any
    // still-uncosted terminal rows here (bounded per call so a first load with a large history doesn't
    // stall parsing hundreds of transcripts — newest first, the rest catch up over subsequent polls).
    this.backfillCosts(visible);
    // Outcome + governance counts: cheap indexed lookups off the audit stream (unlike cost, which parses
    // a transcript), so this isn't budgeted — terminal rows are stamped once, live rows re-tallied.
    this.stampInsights(visible);
    const resumable = this.resumableIds();
    // One query resolves the whole list's blocked-on-human state (a pending ask/approval), instead of a
    // per-row check — so the console gets an authoritative `blocked` without re-deriving it from the feed.
    const blocked = this.blockedSessionIds();
    const links = this.chainLinks(visible);
    return visible.map((r) => ({
      ...toSession(r),
      ...links.get(r.id),
      alive: this.launching.has(r.id) ? true : alive ? alive.has(r.tmux) : undefined,
      working: this.isWorking(r, alive),
      blocked: r.status === 'running' && blocked.has(r.id),
      resumable: resumable.has(r.id),
      forkable: !!r.claude_session_id && runtimeSupports(this.os.agents.get(r.agent)?.runtime, 'fork'),
      system: this.os.agents.get(r.agent)?.category === 'System',
      spawnedByLabel: this.spawnedByLabel(r.spawned_by, r.run_as),
      sourceKind: this.sourceKind(r.spawned_by),
      runAsLabel: this.runAsLabel(r.run_as),
      ratedByLabel: this.runAsLabel(r.rated_by),
    }));
  }

  /** The soft-archived sessions (hidden from `listSessions`) — for the "show archived / restore" view.
   *  Same viewer-visibility rule as the live list; no liveness/cost work (they're terminal + settled). */
  listArchivedSessions(viewer?: Member, taskClip?: number): Session[] {
    return this.withRowCache(() => {
      const rows = this.db.prepare(`SELECT ${this.sessionSelectCols(taskClip)} FROM term_sessions WHERE archived_at IS NOT NULL ORDER BY archived_at DESC`).all<SessionRow>();
      const visible = viewer ? rows.filter((r) => this.canViewRow(r.spawned_by, r.run_as, viewer)) : rows;
      return visible.map((r) => ({ ...toSession(r), spawnedByLabel: this.spawnedByLabel(r.spawned_by, r.run_as), sourceKind: this.sourceKind(r.spawned_by), runAsLabel: this.runAsLabel(r.run_as), ratedByLabel: this.runAsLabel(r.rated_by) }));
    });
  }
  /**
   * The cheap poll payload (Sessions-pagination Phase 2). Replaces the full ~950-row list the console's
   * 1.5 s poll used to ship: returns only the rows the ALWAYS-ON surfaces need — every LIVE session
   * (running, or with an attachable pane) plus the viewer's most-recent ENDED sessions (bounded, for the
   * sidebar switcher) — with the same derived fields the list carries, all viewer-scoped. Plus
   * `doneToday`, a global done-since-server-midnight count: the one always-on aggregate a live+recent set
   * can't derive, consumed only by the owner-only Overview (so a global count is correct — no per-member
   * scoping). Bounded by construction (≈ live-count + cap), so it never rebuilds the whole table.
   */
  sessionsSummary(viewer?: Member, taskClip?: number): { rows: Session[]; doneToday: number } {
    const ENDED_CAP = 60;
    // Live = every running row + every row whose tmux pane is alive (a `done` interactive session can keep
    // an attachable pane). aliveNames() is null on the launcher backend / a failed poll → status alone
    // (we never claim liveness we couldn't verify).
    const alive = this.backend.aliveNames();
    const aliveList = alive ? [...alive] : [];
    const liveIds = this.db
      .prepare(`SELECT id FROM term_sessions WHERE archived_at IS NULL AND (status = 'running'${aliveList.length ? ` OR tmux IN (${aliveList.map(() => '?').join(',')})` : ''})`)
      .all<{ id: string }>(...aliveList)
      .map((r) => r.id);
    // The viewer's most-recent ended sessions — backs the sidebar switcher's "N ended" list. Scoped to the
    // viewer's OWN runs (spawned_by / run_as); an internal caller (no viewer) gets the global recent tail.
    const endedIds = (viewer
      ? this.db.prepare(`SELECT id FROM term_sessions WHERE archived_at IS NULL AND status != 'running' AND (spawned_by = ? OR run_as = ?) ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?`).all<{ id: string }>(viewer.id, viewer.id, ENDED_CAP)
      : this.db.prepare(`SELECT id FROM term_sessions WHERE archived_at IS NULL AND status != 'running' ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?`).all<{ id: string }>(ENDED_CAP)
    ).map((r) => r.id);
    const ids = [...new Set([...liveIds, ...endedIds])];
    const rows = ids.length ? this.listSessions(viewer, taskClip, ids) : [];
    const t0 = new Date();
    t0.setHours(0, 0, 0, 0);
    const doneToday = this.db
      .prepare(`SELECT COUNT(*) AS c FROM term_sessions WHERE archived_at IS NULL AND status = 'done' AND updated_at >= ?`)
      .get<{ c: number }>(t0.getTime())!.c;
    return { rows, doneToday };
  }
  /** Soft-archive a session — hide it from the list, keep the row + transcript (reversible). */
  archiveSession(id: string, now = Date.now()): boolean {
    return this.db.prepare('UPDATE term_sessions SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(now, id).changes > 0;
  }
  /** Restore a soft-archived session back into the list. */
  unarchiveSession(id: string): boolean {
    return this.db.prepare('UPDATE term_sessions SET archived_at = NULL WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Compute + persist USD cost — and the run's SHAPE (engaged time / turns / tool calls, which come out
   * of the same walk) — for terminal rows that don't have it yet. A run's transcript is complete
   * once it reaches a terminal state (done/stopped/crashed), so we parse it once, store the result on the
   * row, and never re-read. Bounded per call (`MAX_COST_BACKFILL`) so the first list after a deploy with a
   * long history amortizes the parsing across polls instead of blocking on all of it at once. Rows are
   * newest-first (listSessions' ORDER BY), so recent sessions get costed first. Mutates the passed rows so
   * the same listSessions response already carries the cost it just computed.
   */
  private backfillCosts(rows: SessionRow[]): void {
    let budget = 20; // MAX_COST_BACKFILL — cap transcript parses per list call
    for (const r of rows) {
      if (budget <= 0) break;
      if (r.cost_usd != null && r.active_ms != null) continue; // already fully derived
      if (r.status === 'running') continue;             // transcript still growing — derive at end
      if (!r.claude_session_id) continue;               // non-claude run has no transcript to read
      budget--;
      let cost;
      try {
        cost = this.readCostFor(r.id, r.agent, r.claude_session_id);
      } catch {
        continue;                                       // transcript unreadable — retry on a later poll
      }
      if (!cost) {
        // No transcript. Two ways a row lands here, and only one of them is temporary:
        //
        //  - the run JUST ended and claude hasn't flushed its `.jsonl` yet — genuinely "not written
        //    yet", so retry on a later poll;
        //  - the transcript is never coming. Either it was pruned since (the row is ALREADY priced and
        //    we were only after its shape) or it was never written at all — a run that crashed before
        //    claude opened one, which on the live instawp tenant is 25 rows of dead `consolidator` /
        //    `qa` sessions, every one of them `cost_usd IS NULL`.
        //
        // The second case used to be handled ONLY when `cost_usd != null`, so those 25 rows re-probed
        // forever: `findTranscript` readdirs every project dir under every transcript root, they
        // consumed the whole 20-parse budget on EVERY list poll, and nothing was ever stamped to stop
        // them. Age is what separates the two cases — a transcript still absent long after the run went
        // terminal is not coming — so an unpriced row heals the same way once it is past the grace.
        const settled = r.cost_usd != null || (r.updated_at ?? r.created_at) < Date.now() - TRANSCRIPT_SETTLE_MS;
        if (settled) {
          this.db.prepare('UPDATE term_sessions SET cost_usd = COALESCE(cost_usd, 0), active_ms = 0, turns = 0, tool_calls = 0 WHERE id = ?').run(r.id);
          r.cost_usd = r.cost_usd ?? 0;
          r.active_ms = 0;
          r.turns = 0;
          r.tool_calls = 0;
        }
        continue;
      }
      this.db
        .prepare('UPDATE term_sessions SET cost_usd = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, active_ms = ?, turns = ?, tool_calls = ? WHERE id = ?')
        .run(cost.costUsd, cost.inputTokens, cost.outputTokens, cost.cacheReadTokens, cost.cacheWriteTokens, cost.activeMs, cost.turns, cost.toolCalls, r.id);
      r.cost_usd = cost.costUsd;
      r.input_tokens = cost.inputTokens;
      r.output_tokens = cost.outputTokens;
      r.cache_read_tokens = cost.cacheReadTokens;
      r.cache_write_tokens = cost.cacheWriteTokens;
      r.active_ms = cost.activeMs;
      r.turns = cost.turns;
      r.tool_calls = cost.toolCalls;
    }
  }

  /**
   * Stamp each row's OUTCOME (the agent's own verdict), GOVERNANCE FINGERPRINT (what the run did
   * through the gate), and CONTEXT (runtime tuning, human-wait latency, deliverables) — the things the
   * sessions list can't say from `status` alone.
   *
   * Both derive from the run's audit stream, an indexed point lookup per row (`idx_audit_run`). A
   * TERMINAL run's stream is complete, so it's computed once and persisted; a LIVE run is recomputed
   * each call (its tally is still moving) and never written. Counting mirrors `episodeSalience`, which
   * grades the same signals for memory — one vocabulary for "what happened in this run". The one
   * deliberate divergence: `errors` counts only `session.error` (the run itself failing), not
   * `episode.error`, which is the OS failing to WRITE the episode memory afterwards — housekeeping the
   * agent had no part in, and which would otherwise brand a clean run as errored. Salience still weighs
   * both, since an internal failure IS worth remembering; the list is about the run's own work.
   *
   * A finished run that never reported stamps `outcome = 'unknown'` rather than staying NULL, so it
   * isn't re-derived on every poll forever — and so the list can show that nobody closed the loop.
   * Mutates the rows in place, so the same response carries what it just computed.
   */
  private stampInsights(rows: SessionRow[]): void {
    // Fully stamped = both tiers present (`artifacts` is the tier-2 marker, like `gov_approvals` for
    // tier-1). A row stamped by an older build carries the gov_* set but NULL tier-2 columns, so it
    // re-stamps once to fill them, then this guard retires it. Terminal state can no longer change.
    const todo = rows.filter((r) => r.status === 'running' || r.gov_approvals == null || r.artifacts == null);
    if (!todo.length) return;
    // BATCHED, not per row: this used to fire six point queries for EVERY row it stamped, and the live
    // rows re-stamp on every poll — so the 1.5 s summary poll paid ~6 × (live rows) queries forever.
    // Each lookup below is the same query with `run_id IN (…)` + GROUP BY, chunked so the parameter list
    // stays bounded. Same indexes (`idx_audit_run_type`), same numbers, one round of work.
    const ids = todo.map((r) => r.id);
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 400) chunks.push(ids.slice(i, i + 400));
    const each = <T>(sql: (holes: string) => string, fn: (row: T) => void): void => {
      for (const page of chunks) {
        for (const row of this.db.prepare(sql(page.map(() => '?').join(','))).all<T>(...page)) fn(row);
      }
    };

    interface Counts { actions: number; approvals: number; denied: number; errors: number }
    const counts = new Map<string, Counts>();
    each<{ run_id: string; actions: number | null; approvals: number | null; gateDenied: number | null; rejected: number | null; errors: number | null }>(
      (h) => `SELECT run_id,
          SUM(type = 'gate.decision') AS actions,
          SUM(type = 'approval.requested') AS approvals,
          SUM(type = 'gate.decision' AND data LIKE '%"effect":"deny"%') AS gateDenied,
          SUM(type = 'approval.resolved' AND data LIKE '%"approved":false%') AS rejected,
          SUM(type = 'session.error') AS errors
        FROM audit_events WHERE run_id IN (${h}) GROUP BY run_id`,
      (c) => counts.set(c.run_id, {
        actions: c.actions ?? 0,
        approvals: c.approvals ?? 0,
        denied: (c.gateDenied ?? 0) + (c.rejected ?? 0),
        errors: c.errors ?? 0,
      }),
    );

    // The agent's own end-of-session verdict, and the tuning the run launched with. Latest wins — a
    // resumed run can report more than once — which the ASC scan expresses as last-write-wins.
    const reported = new Map<string, string>();
    const tuned = new Map<string, string>();
    each<{ run_id: string; type: string; data: string }>(
      (h) => `SELECT run_id, type, data FROM audit_events
               WHERE run_id IN (${h}) AND type IN ('session.reported', 'session.tuning') ORDER BY ts ASC`,
      (e) => (e.type === 'session.reported' ? reported : tuned).set(e.run_id, e.data),
    );

    // Human-wait: `ask` questions (own table carries the answered timestamp) + approval gates (no
    // resolved_at column, so pair the audit spans by approvalId). Only closed waits count — a still-
    // pending block hasn't cost a measurable duration yet, and this run is terminal by here anyway.
    const qWait = new Map<string, number>();
    each<{ run_id: string; ms: number }>(
      (h) => `SELECT run_id, COALESCE(SUM(answered_at - created_at), 0) AS ms FROM questions
               WHERE run_id IN (${h}) AND answered_at IS NOT NULL GROUP BY run_id`,
      (q) => qWait.set(q.run_id, q.ms),
    );
    const apWait = new Map<string, number>();
    const requestedAt = new Map<string, number>(); // approvalId → ts, across the whole scan
    each<{ run_id: string; ts: number; type: string; data: string }>(
      (h) => `SELECT run_id, ts, type, data FROM audit_events
               WHERE run_id IN (${h}) AND type IN ('approval.requested', 'approval.resolved') ORDER BY ts ASC`,
      (e) => {
        let id: string | undefined;
        try { id = (JSON.parse(e.data) as { approvalId?: string }).approvalId; } catch { /* skip */ }
        if (!id) return;
        if (e.type === 'approval.requested') { requestedAt.set(id, e.ts); return; }
        const t0 = requestedAt.get(id);
        if (t0 == null) return;
        apWait.set(e.run_id, (apWait.get(e.run_id) ?? 0) + Math.max(0, e.ts - t0));
        requestedAt.delete(id);
      },
    );

    const artifactCounts = new Map<string, number>();
    each<{ session_id: string; n: number }>(
      (h) => `SELECT session_id, COUNT(*) AS n FROM artifacts WHERE session_id IN (${h}) GROUP BY session_id`,
      (a) => artifactCounts.set(a.session_id, a.n),
    );

    const write = this.db.prepare('UPDATE term_sessions SET gov_actions = ?, gov_approvals = ?, gov_denied = ?, gov_errors = ?, outcome = ?, report_summary = ?, model = ?, effort = ?, output_style = ?, blocked_ms = ?, artifacts = ? WHERE id = ?');
    for (const r of todo) {
      const live = r.status === 'running';
      const c = counts.get(r.id);
      const actions = c?.actions ?? 0;
      const approvals = c?.approvals ?? 0;
      const denied = c?.denied ?? 0;
      const errors = c?.errors ?? 0;

      let outcome = live ? null : 'unknown';
      let summary: string | null = null;
      const report = reported.get(r.id);
      if (report) {
        try {
          const d = JSON.parse(report) as { outcome?: string; summary?: string };
          if (d.outcome) outcome = d.outcome;
          if (d.summary) summary = d.summary.trim() || null;
        } catch { /* malformed audit payload — fall back to 'unknown' */ }
      }

      let model: string | null = null;
      let effort: string | null = null;
      let outputStyle: string | null = null;
      const tuning = tuned.get(r.id);
      if (tuning) {
        try {
          const d = JSON.parse(tuning) as { model?: string; effort?: string; outputStyle?: string };
          model = d.model ?? null;
          effort = d.effort ?? null;
          // Absent on runs launched before the flag shipped — left NULL, which the savings comparison
          // reads as "attributable to neither arm" rather than silently counting it as normal.
          outputStyle = d.outputStyle ?? null;
        } catch { /* malformed — leave all null */ }
      }

      const blockedMs = (qWait.get(r.id) ?? 0) + (apWait.get(r.id) ?? 0);
      const artifacts = artifactCounts.get(r.id) ?? 0;

      r.gov_actions = actions;
      r.gov_approvals = approvals;
      r.gov_denied = denied;
      r.gov_errors = errors;
      r.outcome = outcome;
      r.report_summary = summary;
      r.model = model;
      r.effort = effort;
      r.output_style = outputStyle;
      r.blocked_ms = blockedMs;
      r.artifacts = artifacts;
      if (live) continue; // still moving — surface it, but don't freeze it onto the row
      write.run(actions, approvals, denied, errors, outcome, summary, model, effort, outputStyle, blockedMs, artifacts, r.id);
    }
  }

  /**
   * Flip a `running` row whose tmux pane vanished with no end signal (kill/OOM/reboot) to `crashed`, and
   * surface it: capture the pre-death episode, retire its open questions/approvals (a dead agent can't
   * answer), and — once only, guarded by `hasCompleted` + the status flip — post the owner crash card, the
   * always-on crash notification, and the chat-thread mirror. Mutates the passed row so an in-flight
   * `listSessions` response reflects the new status the same tick. Shared by the lazy read-time detection
   * (`listSessions`) and the periodic timer sweep (`sweepCrashed`) so a crash surfaces even with no console
   * open. Idempotent — a second call after the status flip is a cheap no-op.
   */
  private markCrashed(r: SessionRow): void {
    const crashedAt = Date.now();
    this.db.prepare("UPDATE term_sessions SET status = 'crashed', busy_since = NULL, updated_at = ? WHERE id = ?").run(crashedAt, r.id);
    r.status = 'crashed';
    r.updated_at = crashedAt;
    this.writeEpisode(r.id, r.agent, 'crashed');
    this.cancelPendingQuestions(r.id, 'system');
    this.cancelPendingApprovals(r.id, 'system');
    if (!this.hasCompleted(r.id)) {
      const title = `Crashed — ${r.agent}`;
      const body = 'The session ended unexpectedly (the process died).';
      this.addMessage({ type: 'completed', sessionId: r.id, agent: r.agent, title, body, status: 'open', outcome: 'crashed', audienceKind: 'sessionOwner', audienceId: r.id });
      this.fireSessionEvent(r.id, r.agent, 'crashed', title, body);
      // Close the chat loop: a crash fires no `report` (the only other mirror point), so a chat-triggered
      // run that DIED would otherwise leave its Slack/Discord thread hanging forever. No-op for non-chat runs.
      const inboxLink = consolePage(this.publicOrigin, 'inbox');
      try { this.chatMirror?.(r.id, (p) => `💥 ${r.agent} crashed — the session ended unexpectedly.\n${chatLink(p, inboxLink, 'Open in Agentric')}`); } catch { /* advisory */ }
    }
  }

  /**
   * Timer-driven crash detection — the same rule `listSessions` applies lazily on read, but run on the
   * process-wide 60s sweep so a crash (and its always-on owner/admin DM) surfaces even when nobody has the
   * console open (before this, an unattended run that OOM'd at 3am stayed `running` in the DB until the next
   * UI poll, delaying the crash notification indefinitely). A `running` row whose pane is gone past the 10s
   * grace died with no end signal → `markCrashed`. No-op when liveness can't be polled (launcher backend /
   * transient failure) so a tmux hiccup can't false-crash the fleet.
   */
  private sweepCrashed(alive: Set<string> | null): void {
    if (!alive) return;
    const cutoff = Date.now() - 10_000;
    const rows = this.db.prepare("SELECT * FROM term_sessions WHERE status = 'running'").all<SessionRow>();
    for (const r of rows) {
      if (!alive.has(r.tmux) && r.created_at < cutoff && !this.launching.has(r.id)) {
        try { this.markCrashed(r); } catch { /* one bad row must not stop the sweep */ }
      } else if (alive.has(r.tmux)) {
        try { this.guardHookTrust(r); } catch { /* one bad row must not stop the sweep */ }
      }
    }
  }

  /**
   * PANE GUARD — kill any Codex session sitting on Codex's "Hooks need review" prompt.
   *
   * We pre-seed the hook trust hash so that prompt never appears (see terminal/codex-launch.sh). But the
   * hash is derived from Codex's internals, so a future Codex release could change it. If that happens
   * the TUI does NOT silently skip the hook — it BLOCKS on a three-way prompt. The danger is entirely in
   * the third option: a human who attaches, sees the pane stuck, and picks *"Continue without trusting
   * (hooks won't run)"* now has a completely ungoverned agent.
   *
   * So we never let a person reach that choice. The sweep already reads panes for liveness; here we look
   * for the prompt and tear the session down with an explicit reason, turning a silent-governance-loss
   * risk into a loud, actionable failure ("re-derive the trust hash"). Codex-only and cheap: one
   * capture-pane per live Codex session per 60s sweep.
   */
  private guardHookTrust(r: SessionRow): void {
    if (this.os.agents.get(r.agent)?.runtime !== 'codex') return;
    const pane = this.backend.capturePane(this.spaceFor(r.run_as ?? r.spawned_by), r.tmux);
    if (!pane || !/hooks need review/i.test(pane)) return;
    const why = 'Codex asked to review its hooks, which means Agentric\'s pre-seeded trust hash is stale '
      + '(most likely after a Codex upgrade). The session was stopped rather than risk it running with the '
      + 'gate hook disabled — re-derive the hash in terminal/codex-launch.sh.';
    this.audit(r.id, r.agent, 'session.hook_trust.stale', { tmux: r.tmux });
    this.stopSession(r.id, 'system');
    this.db.prepare("UPDATE term_sessions SET status = 'crashed', busy_since = NULL, updated_at = ? WHERE id = ?").run(Date.now(), r.id);
    this.addMessage({
      type: 'completed', sessionId: r.id, agent: r.agent, title: `Stopped — ${r.agent} (hook trust stale)`,
      body: why, status: 'open', outcome: 'crashed', audienceKind: 'sessionOwner', audienceId: r.id,
    });
  }

  /** The set of session ids BLOCKED on a human right now — a pending `ask` question or a pending approval
   *  gate. One batched pass over the questions table + the tenant's pending approvals, for `listSessions`
   *  to stamp `blocked` per row without an N+1 of {@link hasPendingHumanBlock}. */
  private blockedSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const q of this.db.prepare("SELECT DISTINCT run_id FROM questions WHERE status = 'pending'").all<{ run_id: string }>()) ids.add(q.run_id);
    for (const a of this.os.approvals.pending(this.os.tenant)) ids.add(a.runId);
    return ids;
  }

  /**
   * The delegation edge for a page of rows: session → the task that dispatched it, and that task's CALLER
   * conversation. Resolved in ONE batched query over `tasks` (chunked under SQLite's variable cap) rather
   * than per row — the sessions list is a hot poll path, and an N+1 here would cost a query per delegated
   * run. Rows with no `task:`/`poke:`/`ask:` provenance simply aren't in the map.
   */
  private chainLinks(rows: SessionRow[]): Map<string, { taskId: string; parentThreadId?: string }> {
    const out = new Map<string, { taskId: string; parentThreadId?: string }>();
    for (const r of rows) {
      const taskId = taskOfProvenance(r.spawned_by);
      if (taskId) out.set(r.id, { taskId });
    }
    if (!out.size) return out;
    const ids = [...new Set([...out.values()].map((v) => v.taskId))];
    const callers = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 400) {
      const page = ids.slice(i, i + 400);
      for (const c of this.db
        .prepare(`SELECT id, caller_claude_id FROM tasks WHERE id IN (${page.map(() => '?').join(',')})`)
        .all<{ id: string; caller_claude_id: string | null }>(...page)) {
        if (c.caller_claude_id) callers.set(c.id, c.caller_claude_id);
      }
    }
    for (const link of out.values()) link.parentThreadId = callers.get(link.taskId);
    return out;
  }

  /**
   * Thread identity for a set of run ids — the feed's hook into the same hand-off chain the sessions list
   * and chain rail use. `threadId` folds a conversation's runs (a poke/continuation shares one
   * `claude_session_id`); `parentThreadId` is the caller conversation that delegated it (via `chainLinks`).
   * A self-parent (a poke waking itself) is dropped to `undefined` so it reads as a root. Batched like the
   * list path so it stays cheap on the feed poll.
   */
  threadsFor(runIds: string[]): Map<string, { threadId: string; parentThreadId?: string }> {
    const out = new Map<string, { threadId: string; parentThreadId?: string }>();
    const ids = [...new Set(runIds.filter(Boolean))];
    if (!ids.length) return out;
    const rows: SessionRow[] = [];
    for (let i = 0; i < ids.length; i += 400) {
      const page = ids.slice(i, i + 400);
      rows.push(...this.db.prepare(`SELECT * FROM term_sessions WHERE id IN (${page.map(() => '?').join(',')})`).all<SessionRow>(...page));
    }
    const links = this.chainLinks(rows);
    for (const r of rows) {
      const threadId = r.claude_session_id ?? r.id;
      const parent = links.get(r.id)?.parentThreadId;
      out.set(r.id, { threadId, parentThreadId: parent && parent !== threadId ? parent : undefined });
    }
    return out;
  }

  /**
   * The HAND-OFF CHAIN a session belongs to — the tree the console's chain rail renders, and the answer
   * to "where is this piece of work right now?" that a flat session list can't give.
   *
   * Three identities are collapsed into one view here, all of them already recorded:
   *   - a **run** is a `term_sessions` row (one pane);
   *   - a **conversation** is every run sharing a `claude_session_id` — a poke-back RESUMES a transcript,
   *     so one conversation routinely spans several rows;
   *   - the **chain** is the delegation tree over conversations: `tasks.caller_claude_id` (the caller)
   *     → the runs dispatched for that task (`task:` / `ask:` provenance).
   *
   * We walk UP from `sessionId` to the chain root, then DOWN over every descendant, folding each
   * conversation into a single node (runs counted, cost summed, newest run representative). Sibling
   * delegates to the same agent with the same task title are flagged `duplicate` — the re-dispatch that
   * is invisible in a flat list. Depth and breadth are capped so a pathological graph can't wedge the
   * request. Viewer-scoped by the same `canViewRow` rule as the list: a node the viewer can't see is
   * omitted (its subtree with it), never leaked.
   */
  sessionChain(sessionId: string, viewer?: Member): SessionChain | null {
    const seed = this.db.prepare('SELECT * FROM term_sessions WHERE id = ?').get<SessionRow>(sessionId);
    if (!seed) return null;
    if (viewer && !this.canViewRow(seed.spawned_by, seed.run_as, viewer)) return null;

    const threadOf = (r: SessionRow): string => r.claude_session_id ?? r.id;
    // MEMOIZED for the walk: the climb re-reads the same thread on every hop and the descent reads each
    // child's thread again to decide whether to visit it, so an unmemoized read ran this query several
    // times per node. The rows are a snapshot either way — the whole walk is one response.
    const threadRows = new Map<string, SessionRow[]>();
    const rowsOfThread = (threadId: string): SessionRow[] => {
      const hit = threadRows.get(threadId);
      if (hit) return hit;
      const rows = this.db
        .prepare('SELECT * FROM term_sessions WHERE claude_session_id = ? OR (claude_session_id IS NULL AND id = ?) ORDER BY created_at ASC')
        .all<SessionRow>(threadId, threadId);
      const out = viewer ? rows.filter((r) => this.canViewRow(r.spawned_by, r.run_as, viewer)) : rows;
      threadRows.set(threadId, out);
      return out;
    };
    // The task a conversation was dispatched FOR (its first `task:`/`ask:` run), and from it the caller
    // conversation one level up.
    const dispatchOf = (rows: SessionRow[]): { taskId: string; callerThreadId?: string } | undefined => {
      for (const r of rows) {
        const taskId = taskOfProvenance(r.spawned_by);
        if (!taskId || r.spawned_by?.startsWith('poke:')) continue; // a poke resumes the CALLER, not a delegate
        const t = this.db.prepare('SELECT caller_claude_id FROM tasks WHERE id = ?').get<{ caller_claude_id: string | null }>(taskId);
        return { taskId, callerThreadId: t?.caller_claude_id ?? undefined };
      }
      return undefined;
    };

    // ── walk up to the root conversation ──
    let rootThread = threadOf(seed);
    const climbed = new Set<string>([rootThread]);
    for (let hop = 0; hop < CHAIN_MAX_DEPTH; hop++) {
      const up = dispatchOf(rowsOfThread(rootThread))?.callerThreadId;
      if (!up || up === rootThread || climbed.has(up)) break;
      if (!rowsOfThread(up).length) break; // caller invisible to this viewer / pruned → stop here
      rootThread = up;
      climbed.add(up);
    }

    // ── walk down over every descendant ──
    const nodes: ChainNode[] = [];
    const seen = new Set<string>();
    const alive = this.backend.aliveNames(); // one tmux poll for the whole walk, not one per node
    const pendingApprovals = this.os.approvals.pending(this.os.tenant); // one read for the whole walk too
    const visit = (threadId: string, depth: number, parentThreadId?: string): void => {
      if (seen.has(threadId) || nodes.length >= CHAIN_MAX_NODES || depth > CHAIN_MAX_DEPTH) return;
      const rows = rowsOfThread(threadId);
      if (!rows.length) return;
      seen.add(threadId);
      const latest = rows[rows.length - 1];
      const dispatch = dispatchOf(rows);
      const task = dispatch ? this.os.tasks.get(dispatch.taskId) : undefined;
      // Cost is per-TRANSCRIPT and cumulative: every resumed row re-parses the same conversation and
      // stores the running total, so the conversation's cost is the largest of them — summing would
      // multiply one bill by the number of resumes.
      const cost = rows.reduce((n, r) => Math.max(n, r.cost_usd ?? 0), 0);
      // A resumed row's title is machine-written ("Poke ← … done: …") and its summary usually empty, so
      // the newest row is the wrong label for the conversation. Prefer the freshest real verdict — and
      // take the outcome from the SAME run as the summary, or a conversation whose last resume ended
      // quietly reads "no report" right beside the report it filed.
      const pending = this.chainPending(rows, pendingApprovals);
      const voice = [...rows].reverse();
      const reported = voice.find((r) => r.report_summary?.trim());
      const summary = reported?.report_summary ?? undefined;
      const title = voice.find((r) => !r.spawned_by?.startsWith('poke:'))?.title ?? latest.title;
      nodes.push({
        threadId,
        parentThreadId,
        depth,
        sessionId: latest.id,
        tmux: latest.tmux,
        agent: latest.agent,
        title,
        summary,
        status: latest.status,
        alive: alive ? alive.has(latest.tmux) : undefined,
        headless: !!latest.headless,
        blocked: latest.status === 'running' && pending.length > 0,
        working: this.isWorking(latest, alive),
        outcome: reported?.outcome ?? latest.outcome ?? undefined,
        runs: rows.length,
        costUsd: cost || undefined,
        createdAt: rows[0].created_at,
        updatedAt: latest.updated_at ?? latest.created_at,
        kind: depth === 0 ? 'root' : rows.some((r) => r.spawned_by?.startsWith('ask:')) ? 'answer' : 'delegate',
        taskId: dispatch?.taskId,
        taskTitle: task?.title,
        taskStatus: task?.status,
        pending,
      });
      // Children: every task this conversation delegated, and the runs dispatched for it.
      const tasks = this.db
        .prepare('SELECT id FROM tasks WHERE caller_claude_id = ? ORDER BY created_at ASC')
        .all<{ id: string }>(threadId);
      for (const t of tasks) {
        const runs = this.db
          .prepare("SELECT * FROM term_sessions WHERE spawned_by = ? OR spawned_by = ? ORDER BY created_at ASC")
          .all<SessionRow>(`task:${t.id}`, `ask:${t.id}`);
        for (const child of runs) {
          const childThread = threadOf(child);
          if (childThread === threadId) continue; // defensive: never nest a conversation under itself
          visit(childThread, depth + 1, threadId);
        }
      }
    };
    visit(rootThread, 0);
    markDuplicateDispatches(nodes);

    return {
      rootThreadId: rootThread,
      nodes,
      agents: new Set(nodes.map((n) => n.agent)).size,
      totalCostUsd: nodes.reduce((n, x) => n + (x.costUsd ?? 0), 0) || undefined,
      startedAt: Math.min(...nodes.map((n) => n.createdAt)),
      updatedAt: Math.max(...nodes.map((n) => n.updatedAt)),
    };
  }

  /** What a chain node is waiting on a human for: its unanswered `ask` questions and unresolved approval
   *  gates, over every run of the conversation. This is what makes the rail actionable — a delegate's
   *  question is answered from the CALLER's pane, instead of being hunted down in the Inbox. */
  private chainPending(rows: SessionRow[], pendingApprovals?: ReturnType<AgentOS['approvals']['pending']>): ChainPending[] {
    const ids = rows.map((r) => r.id);
    if (!ids.length) return [];
    const out: ChainPending[] = [];
    const marks = ids.map(() => '?').join(',');
    for (const q of this.db
      .prepare(`SELECT id, run_id, agent, prompt, created_at FROM questions WHERE status = 'pending' AND run_id IN (${marks}) ORDER BY created_at ASC`)
      .all<{ id: string; run_id: string; agent: string; prompt: string; created_at: number }>(...ids)) {
      out.push({ kind: 'question', id: q.id, sessionId: q.run_id, agent: q.agent, text: q.prompt, createdAt: q.created_at });
    }
    const own = new Set(ids);
    // The caller passes the tenant's pending set once for a whole chain walk; alone (the single-run
    // callers) this still reads it itself.
    for (const a of pendingApprovals ?? this.os.approvals.pending(this.os.tenant)) {
      if (!own.has(a.runId)) continue;
      out.push({ kind: 'approval', id: a.id, sessionId: a.runId, agent: rows.find((r) => r.id === a.runId)?.agent ?? '', text: a.reason || a.attempt.capabilityId, capability: a.attempt.capabilityId, level: a.level, createdAt: a.createdAt });
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
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
   * Every session belonging to a given agent — its OWN run history, newest first. The episodic
   * companion to the (semantic) memory plane: "have I done this before, and how did it go?". Reuses
   * `listSessions` so each row carries live status / rating / labels. Deliberately unscoped by a
   * `Member` viewer — the agent-facing routes gate on the CALLER'S own agent id (an agent only ever
   * sees its own sessions, never a sibling's), which the member-visibility rules can't express.
   */
  sessionsForAgent(agent: string, opts: { query?: string; excludeId?: string; limit?: number } = {}): Session[] {
    // Select the agent's OWN ids first, in SQL, then derive the full shape for only those rows. The old
    // shape — `listSessions().filter(...)` — materialised every session in the tenant (full `task` prose)
    // and ran the whole derivation chain (tmux liveness, cost backfill of up to 20 transcripts, insights
    // stamping) to then throw ~99% of it away: 18ms on a 1k-session tenant, growing with the tenant, for
    // a tool an agent calls mid-run. The filters live here rather than in the caller so the LIMIT is
    // applied before that derivation, not after.
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 100);
    const args: unknown[] = [agent];
    let where = 'agent = ? AND archived_at IS NULL';
    if (opts.excludeId) { where += ' AND id != ?'; args.push(opts.excludeId); }
    const q = opts.query?.trim().toLowerCase();
    if (q) {
      // Same substring match the route did in JS, moved into SQL so it narrows before the LIMIT.
      where += ' AND (lower(title) LIKE ? OR lower(task) LIKE ?)';
      args.push(`%${q}%`, `%${q}%`);
    }
    const ids = this.db
      .prepare(`SELECT id FROM term_sessions WHERE ${where} ORDER BY created_at DESC LIMIT ?`)
      .all<{ id: string }>(...args, limit)
      .map((r) => r.id);
    return this.listSessions(undefined, undefined, ids);
  }

  /** Does this session belong to that agent (and is it visible — not archived)? The ownership check
   *  behind `session_open`, which used to resolve the agent's ENTIRE history just to test one id. */
  sessionBelongsToAgent(sessionId: string, agent: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM term_sessions WHERE id = ? AND agent = ? AND archived_at IS NULL')
      .get(sessionId, agent);
  }

  /**
   * Session ids that have a persisted launch env (`session-<id>.env`) — i.e. a session the ttyd attach
   * wrapper can resurrect via `claude --resume` (see `writeEnvFile`/`terminal/attach.sh`). Every
   * claude-code launch writes one, unattended included; runtimes with no resurrect env (and sessions
   * predating that change) are absent and correctly report `resumable:false`. One readdir serves the
   * whole list; no data home (demo/tests) → nothing resumable.
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
      const a = this.lookupAutomation(spawnedBy.slice('automation:'.length));
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
   * Resolve a session's **run-as identity** — the ONE place `term_sessions.run_as` is derived, and the
   * guarantee that the column only ever holds a real member id.
   *
   * `spawnedBy` is PROVENANCE and may be a bare member id OR a prefixed system trigger
   * (`automation:` / `task:` / `chat:` / `poke:` / `ask:` / `goal:`). Only the bare-member case is a
   * human to act as, so the fallback resolves against the team rather than blocklisting prefixes — a
   * new provenance kind can't leak into the identity column by being forgotten here. An explicit
   * `runAs` is canonicalised the same way (id or email → id), so a caller that hands over an email or
   * a stale member never writes a value the rest of the system silently fails to match.
   *
   * Returning undefined (→ NULL) is the correct answer for a run with no accountable human: it degrades
   * to the company identity, which is exactly what an ownerless automation/task run should use. The old
   * behavior instead stored the provenance string itself, so `run_as = 'chat:triage'` looked like an
   * identity to every consumer and matched none — silently costing that run the member's GitHub token,
   * connectors, member-scoped secrets and inbox ownership.
   */
  private resolveActingMember(runAs?: string, spawnedBy?: string): string | undefined {
    const asMember = (v?: string): string | undefined => {
      const raw = (v ?? '').trim();
      if (!raw) return undefined;
      return this.os.team.resolveMemberRef(raw)?.id;
    };
    return asMember(runAs) ?? asMember(spawnedBy);
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

  /**
   * Memoized lookup tables for the duration of ONE synchronous list call — see {@link withRowCache}.
   * `null` outside such a call, which is what keeps every other caller byte-identical.
   */
  private rowCache: { members?: Map<string, Member>; autos?: Map<string, AutomationLookup> } | null = null;

  /**
   * Run `fn` with the per-row member/automation lookups memoized.
   *
   * The row helpers below (`spawnedByLabel`, `sourceKind`, `runAsLabel`, `canViewSpawn`) each re-query
   * SQLite per row. That's fine for one row and quadratic-feeling for a list: on the live globex tenant
   * `listSessions` walks 950 sessions and fired ~1900 point lookups to resolve a grand total of **14
   * members and 40 automations** — the lookup tables are tiny and bounded, the row count is not. Loading
   * each table once per call replaces all of them with two queries, and was over half of `listSessions`'
   * wall time (18 ms of 35 ms measured on that tenant's data).
   *
   * Safe because the whole scope is SYNCHRONOUS — no await, so no other request can interleave and no
   * write can land mid-call — and nothing inside the scope mutates `members` or `automations`
   * (`markCrashed`/`backfillCosts`/`stampInsights` write `term_sessions` and the audit log only).
   * Re-entrant: a nested call reuses the outer scope rather than rebuilding, and the previous scope is
   * always restored, so an exception can't strand a stale cache on the instance.
   */
  private withRowCache<T>(fn: () => T): T {
    const outer = this.rowCache;
    if (outer) return fn(); // already inside a scope — share it
    this.rowCache = {};
    try {
      return fn();
    } finally {
      this.rowCache = outer;
    }
  }
  /** `getMember`, served from the per-call cache when inside a {@link withRowCache} scope. */
  private lookupMember(id: string): Member | undefined {
    const c = this.rowCache;
    if (!c) return this.os.team.getMember(id);
    if (!c.members) {
      c.members = new Map();
      // `listMembers()` selects the same rows `getMember` does (no filter), so this is a complete index.
      for (const m of this.os.team.listMembers()) c.members.set(m.id, m);
    }
    return c.members.get(id);
  }
  /** The automation row the label/source/authz helpers need, cached the same way. */
  private lookupAutomation(id: string): AutomationLookup | undefined {
    const c = this.rowCache;
    if (!c) return this.db.prepare('SELECT name, type, created_by FROM automations WHERE id = ?').get<AutomationLookup>(id);
    if (!c.autos) {
      c.autos = new Map();
      for (const a of this.db.prepare('SELECT id, name, type, created_by FROM automations').all<AutomationLookup & { id: string }>()) c.autos.set(a.id, a);
    }
    return c.autos.get(id);
  }

  /** Resolve a session's provenance (+ run-as) to a console-friendly label: member name/email, or
   *  automation — and "Automation · X · as Alice" when it ran as a resolved member. */
  private spawnedByLabel(spawnedBy: string | null, runAs?: string | null): string | undefined {
    const asMember = runAs ? this.lookupMember(runAs) : undefined;
    const asSuffix = asMember && asMember.id !== spawnedBy ? ` · as ${asMember.name || asMember.email}` : '';
    if (!spawnedBy) return asMember ? `as ${asMember.name || asMember.email}` : undefined;
    if (spawnedBy.startsWith('automation:')) {
      const auto = this.lookupAutomation(spawnedBy.slice('automation:'.length));
      return `${auto ? `Automation · ${auto.name}` : 'Automation'}${asSuffix}`;
    }
    // Generic chat-router run (`chat:<agent>`) — a Slack/Discord message addressed to an agent, no automation.
    if (spawnedBy.startsWith('chat:')) return `Chat · ${spawnedBy.slice('chat:'.length)}${asSuffix}`;
    // Auto-dispatched from the Tasks board (`task:<id>`) — a durable unit of work spawned a session.
    if (spawnedBy.startsWith('task:')) return `Task · ${spawnedBy.slice('task:'.length)}${asSuffix}`;
    // One-off ask_agent delegate (`ask:<caller>`) — another agent asked this one a question and is waiting.
    if (spawnedBy.startsWith('ask:')) return `Ask · ${spawnedBy.slice('ask:'.length)}${asSuffix}`;
    // Async poke-back (`poke:<task>`) — this caller was resumed because a delegate it handed off finished.
    if (spawnedBy.startsWith('poke:')) return `Poke · ${spawnedBy.slice('poke:'.length)}${asSuffix}`;
    const m = this.lookupMember(spawnedBy);
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
      const auto = this.lookupAutomation(spawnedBy.slice('automation:'.length));
      switch (auto?.type) {
        case 'cron': return 'cron';
        case 'webhook': return 'webhook';
        case 'slack': return 'slack';
        case 'discord': return 'discord';
        case 'telegram': return 'telegram';
        case 'composio': return 'composio';
        case 'once': return 'scheduled';
        default: return 'cron'; // deleted/unknown automation → treat as a generic scheduled trigger
      }
    }
    // A bare principal: a console member spawned it manually, or an internal system principal.
    return this.lookupMember(spawnedBy) ? 'manual' : 'system';
  }

  /** The run-as member's display name (name → email), for the sessions-list Owner filter. Undefined
   *  when the session has no run-as identity or the member no longer exists. */
  private runAsLabel(runAs: string | null): string | undefined {
    if (!runAs) return undefined;
    const m = this.lookupMember(runAs);
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

  /**
   * Sessions occupying a **work slot** — the number the spawn cap should compare against, as opposed to
   * {@link aliveSessionCount}, which counts every live pane.
   *
   * The two differ because an **interactive** session stays alive until a human closes it, by design. A
   * TUI someone opened, used for ten minutes and walked away from is indistinguishable, to a pane count,
   * from an agent working flat out. On the live fleet that difference took out the entire scheduled lane:
   * a tenant accumulated ~13 parked TUIs (nine claimed by one person, seven untouched for over a week),
   * the pane count sat permanently above the cap, and every cron was deferred for a month — 31,570
   * consecutive `scheduler.deferred` events, no cron fired, nobody noticed. Raising the cap only buys
   * time, because parked panes keep accumulating; they must stop counting as work.
   *
   * A session holds a slot when it is alive AND any of:
   *   - **headless** — an unattended run is working from spawn to exit by definition (a wedged one is the
   *     unattended reapers' problem, not the cap's).
   *   - **a turn is in flight** — {@link isWorking}, the same predicate the console's spinner uses. A
   *     human actively driving a TUI is real load and must still count.
   *   - **recently active** — within {@link PARKED_IDLE_MS}, so a human thinking between turns keeps
   *     their slot rather than losing it to a scheduled spawn mid-conversation.
   *
   * Everything else is parked: alive, costing almost nothing, and no reason to block scheduled work.
   * Falls back to the pure DB count when liveness can't be polled, for the same fail-safe reason
   * {@link aliveSessionCount} does.
   */
  admissionSessionCount(): number {
    const alive = this.backend.aliveNames();
    if (!alive) return this.runningSessionCount();
    const rows = this.db
      .prepare(
        "SELECT id, tmux, status, headless, busy_since, last_activity, created_at FROM term_sessions WHERE status = 'running'",
      )
      .all<{ id: string; tmux: string; status: string; headless: number | null; busy_since: number | null; last_activity: number | null; created_at: number }>();
    const now = Date.now();
    let n = 0;
    for (const r of rows) {
      if (!alive.has(r.tmux) && !this.launching.has(r.id)) continue; // row says running, pane says otherwise
      if (r.headless) { n++; continue; }
      if (this.isWorking(r, alive)) { n++; continue; }
      if (now - (r.last_activity ?? r.created_at) <= PARKED_IDLE_MS) n++;
    }
    return n;
  }

  /** How many live sessions are parked — alive but holding no work slot. Observability only (the Settings
   *  concurrency panel), so "running: 34 / cap 25" can explain itself instead of looking like an overload. */
  parkedSessionCount(): number {
    const alive = this.backend.aliveNames();
    if (!alive) return 0;
    return Math.max(0, this.aliveSessionCount() - this.admissionSessionCount());
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

  /**
   * Is this session's claude still up? — the ONE liveness predicate. Every caller that asks "can I type
   * into this run / is this agent already working / did that delegate die" asks this.
   *
   * It asks the **pane**, never the row's `status`, because `status` reports what the run last *said
   * about itself*: an agent that calls `report` is stamped `done` (see `reportSession`) while its claude
   * keeps running. That is not an edge case — it is the normal shape of a long-lived run, which is why
   * the idle reaper has a whole "DONE ORPHAN" branch for a `done` row still holding a pane, and why
   * `isWorking` (the console's spinner) already ignored status.
   *
   * There used to be a second, status-folding predicate (`isAlive`: `status !== 'running' → false`).
   * Every one of its ten call sites was wrong in the same direction — it declares a session with a live
   * REPL dead — and the failures were the expensive kind, because the fallback for "dead" is almost
   * always `claude --resume`, i.e. a SECOND claude on a transcript the first still holds. Live on
   * northwind 2026-08-10: `ses_f4535e8f` reported at 16:13 and worked until 16:34; its 16:31 poke-back
   * saw `done`, skipped the live pane, and spawned `ses_441cec`, which died 28s later — the poke was
   * never seen. So the two were folded into this one; don't reintroduce a status-based variant.
   *
   * Refuses only a status that means someone ended the run deliberately (`stopped`) or the sweep buried
   * it (`crashed`) — a pane surviving either is a leftover, not a destination.
   */
  reachable(sessionId: string): boolean {
    if (this.launching.has(sessionId)) return true; // scheduled; its pane is imminent
    const r = this.db.prepare('SELECT tmux, status FROM term_sessions WHERE id = ?').get<{ tmux: string; status: string }>(sessionId);
    if (!r) return false;
    if (r.status === 'stopped' || r.status === 'crashed') return false; // deliberately ended — don't revive by keystroke
    const alive = this.backend.aliveNames();
    if (!alive) return r.status === 'running'; // launcher backend: can't poll the pane, so fall back to the row
    return alive.has(r.tmux);
  }

  /**
   * The agents whose `task:<id>` run still holds a live pane — the per-agent pile-up guard the scheduler
   * consults before dispatching more board work. Same predicate as {@link reachable}, evaluated for the
   * whole board in ONE query and ONE liveness poll.
   *
   * The batch shape is the point. The scheduler used to call `reachable()` per row over
   * `spawned_by LIKE 'task:%' AND status IN ('running','done')` — a set that only ever GROWS, because a
   * `done` row is never deleted. On the live fleet that reached 924 rows (918 of them long-finished), so
   * every 20s tick fork+exec'd tmux ~900 times and blocked the single-threaded server for **7.3s** —
   * a third of all wall-clock, on work whose answer was identical every time. Cost per completed task
   * session was permanent and additive: the longer a tenant had been useful, the slower everything got.
   * Keep this batched; a future caller wanting one agent should still come through here.
   */
  busyTaskAgents(): Set<string> {
    const busy = new Set<string>();
    const rows = this.db
      .prepare("SELECT id, agent, tmux, status FROM term_sessions WHERE spawned_by LIKE 'task:%' AND status IN ('running','done')")
      .all<{ id: string; agent: string; tmux: string; status: string }>();
    if (!rows.length) return busy;
    const alive = this.backend.aliveNames();
    for (const r of rows) {
      // `launching`: a scheduled run whose pane is imminent still owns the agent (mirrors `reachable`).
      if (this.launching.has(r.id)) { busy.add(r.agent); continue; }
      // No poll possible (launcher backend / failed poll) → trust the row, like `reachable` does.
      if (!alive) { if (r.status === 'running') busy.add(r.agent); continue; }
      if (alive.has(r.tmux)) busy.add(r.agent);
    }
    return busy;
  }

  /**
   * The still-live run for each of `taskIds` — one query and ONE liveness poll for the whole set, keyed by
   * task id. The batch shape is the point (same lesson as {@link busyTaskAgents}): the goal room asks this
   * about every task under a goal on a 5s refresh, and a per-row `reachable()` would fork+exec tmux once
   * per task, forever, for an answer that is identical across the set.
   *
   * "Live" is `reachable`'s predicate on the task's CURRENT run (`last_session_id`) — the same one the
   * dispatch pile-up guard uses, so what the console shows as running is exactly what the server would
   * refuse to double-dispatch.
   */
  liveTaskRuns(taskIds: string[]): Record<string, { sessionId: string; agent: string; since: number }> {
    const out: Record<string, { sessionId: string; agent: string; since: number }> = {};
    const ids = taskIds.filter(Boolean);
    if (!ids.length) return out;
    const rows = this.db
      .prepare(`SELECT t.id AS task_id, s.id AS id, s.agent AS agent, s.tmux AS tmux, s.status AS status,
                       s.created_at AS created_at
                  FROM tasks t JOIN term_sessions s ON s.id = t.last_session_id
                 WHERE t.id IN (${ids.map(() => '?').join(',')})`)
      .all<{ task_id: string; id: string; agent: string; tmux: string; status: string; created_at: number }>(...ids);
    if (!rows.length) return out;
    const alive = this.backend.aliveNames();
    for (const r of rows) {
      const live = this.launching.has(r.id) // scheduled; its pane is imminent (mirrors `reachable`)
        || (r.status !== 'stopped' && r.status !== 'crashed'
          && (alive ? alive.has(r.tmux) : r.status === 'running')); // no poll possible → trust the row
      if (live) out[r.task_id] = { sessionId: r.id, agent: r.agent, since: r.created_at };
    }
    return out;
  }

  /**
   * The goal room's CHAT conversation for `goalId` — the newest resident run spawned under this goal.
   *
   * Provenance `goal:<id>` is already what a plan run carries, so the discriminator is `resident`: a plan
   * run is a headless one-shot that files tasks and exits, while the chat is a warm conversation a person
   * keeps talking to. That keeps one provenance vocabulary (a session under a goal is `goal:<id>`, full
   * stop) instead of minting a second prefix every decoder would have to learn.
   */
  goalChatSession(goalId: string): { sessionId: string; agent: string; alive: boolean; working: boolean; createdAt: number } | undefined {
    const r = this.db
      .prepare(`SELECT id, agent, tmux, status, busy_since, last_activity, created_at FROM term_sessions
                 WHERE spawned_by = ? AND resident = 1 AND archived_at IS NULL
                 ORDER BY created_at DESC LIMIT 1`)
      .get<{ id: string; agent: string; tmux: string; status: string; busy_since: number | null; last_activity: number | null; created_at: number }>(`goal:${goalId}`);
    if (!r) return undefined;
    return {
      sessionId: r.id, agent: r.agent, alive: this.reachable(r.id),
      working: this.isWorking(r, this.backend.aliveNames()), createdAt: r.created_at,
    };
  }

  /**
   * A session we just delivered into was stamped `done` by its own `report` but is demonstrably still
   * running — put the row back in step with reality so the console spins on `working` and the crash
   * sweep watches it again. Terminal states set by a human (`stopped`) or the sweep (`crashed`) are
   * never touched: `reachable` already refuses to deliver into those.
   */
  private restoreRunningAfterDelivery(sessionId: string): void {
    this.db.prepare("UPDATE term_sessions SET status = 'running', updated_at = ? WHERE id = ? AND status = 'done'")
      .run(Date.now(), sessionId);
  }

  /**
   * The MOST RECENT session bound to a Slack thread (`channel` + `thread_ts`), for thread continuity:
   * a follow-up message in a thread resumes THAT run's agent + claude conversation. Returns the agent,
   * its run-as, and the pinned `claudeSessionId` needed to `--resume`. Undefined when nothing is bound
   * (the first mention — the thread isn't bound yet) or the newest run predates the claude-id column
   * (unresumable → the caller falls back to a fresh spawn).
   */
  sessionForSlackThread(channel: string, threadTs: string): { sessionId: string; agent: string; runAs?: string; claudeSessionId?: string } | undefined {
    // UNION of the two bindings: `slack_threads` (the run's reply target, written when a message
    // triggered it) and `slack_bot_threads` (every thread the bot has spoken in, including ones IT
    // opened with a proactive post). The second is what makes a reply under a cron report continue the
    // run that wrote the report instead of dying as unaddressed chatter.
    const row = this.db
      .prepare(
        `SELECT t.id AS id, t.agent AS agent, t.run_as AS runAs, t.claude_session_id AS claudeSessionId, t.created_at AS createdAt
           FROM slack_threads s JOIN term_sessions t ON t.id = s.session_id
          WHERE s.channel = ? AND s.thread_ts = ?
          UNION
         SELECT t.id AS id, t.agent AS agent, t.run_as AS runAs, t.claude_session_id AS claudeSessionId, t.created_at AS createdAt
           FROM slack_bot_threads b JOIN term_sessions t ON t.id = b.session_id
          WHERE b.channel = ? AND b.thread_ts = ?
          ORDER BY createdAt DESC LIMIT 1`,
      )
      .get<{ id: string; agent: string; runAs: string | null; claudeSessionId: string | null }>(channel, threadTs, channel, threadTs);
    if (!row) return undefined;
    return { sessionId: row.id, agent: row.agent, runAs: row.runAs ?? undefined, claudeSessionId: row.claudeSessionId ?? undefined };
  }

  /**
   * Record that the bot has spoken in a Slack thread — the thread-keyed index behind
   * {@link knowsSlackThread}. Called when a session is bound at spawn AND when an agent's own post
   * (`slack_reply` / `slack_send`) opens a NEW thread, which is the case `slack_threads` structurally
   * cannot cover (it is keyed by session, one reply target per run). Newest writer wins the row, so a
   * later run replying in the same thread becomes the one a follow-up continues.
   */
  noteSlackThread(sessionId: string, channel: string, threadTs: string): void {
    if (!sessionId || !channel || !threadTs) return;
    try {
      this.db.prepare('INSERT OR REPLACE INTO slack_bot_threads (channel, thread_ts, session_id, created_at) VALUES (?, ?, ?, ?)')
        .run(channel, threadTs, sessionId, Date.now());
    } catch { /* best-effort index; never break a post over it */ }
  }

  /** Point a session's Slack reply target at a (possibly newly created) thread. Used by the slash-command
   *  path, which can only learn the thread root by posting it — the session is already spawned by then. */
  rebindSlackThread(sessionId: string, channel: string, threadTs: string): void {
    if (!sessionId || !channel || !threadTs) return;
    try {
      this.db.prepare('INSERT OR REPLACE INTO slack_threads (session_id, channel, thread_ts, created_at) VALUES (?, ?, ?, ?)')
        .run(sessionId, channel, threadTs, Date.now());
      this.noteSlackThread(sessionId, channel, threadTs);
    } catch { /* best-effort */ }
  }

  /** Has the bot spoken in this Slack thread? The deterministic "is this addressed to us" test the
   *  socket uses before dropping an untagged channel message: a reply under something we posted is a
   *  reply to us, whether or not the run behind it is still alive. */
  knowsSlackThread(channel: string, threadTs: string): boolean {
    if (!channel || !threadTs) return false;
    return !!this.db
      .prepare('SELECT 1 FROM slack_bot_threads WHERE channel = ? AND thread_ts = ? UNION SELECT 1 FROM slack_threads WHERE channel = ? AND thread_ts = ? LIMIT 1')
      .get(channel, threadTs, channel, threadTs);
  }

  /**
   * Drop inbound chat attachments into a session's agent folder, under the same `.inbox/` the console's
   * paste-a-file path uses — so an agent Reads `.inbox/<name>` by a relative path inside its own
   * workspace and the gate's containment rules hold unchanged. `name` is sanitized to a basename here;
   * the caller has already bounded the count and size. Returns the relative paths actually written.
   */
  stageInboundFiles(sessionId: string, files: { name: string; data: Buffer }[]): string[] {
    if (!files.length) return [];
    const row = this.db.prepare('SELECT agent FROM term_sessions WHERE id = ?').get<{ agent: string }>(sessionId);
    const dir = row ? this.os.agents.get(row.agent)?.dir : undefined;
    if (!dir) return [];
    const written: string[] = [];
    for (const f of files) {
      const clean = inboxFileName(f.name);
      try {
        const target = path.join(dir, '.inbox');
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, clean), f.data);
        written.push(path.join('.inbox', clean));
      } catch { /* one unwritable file must not lose the rest */ }
    }
    if (written.length) this.audit(sessionId, 'chat', 'session.attachment', { paths: written, source: 'chat' });
    return written;
  }
  /**
   * The MOST RECENT session bound to a Discord channel — the thread-continuity twin of
   * {@link sessionForSlackThread}. For a guild @mention the socket branches a real thread and binds the
   * session to the THREAD's channel id, so a plain follow-up posted in that thread (which carries the
   * thread's channel id) resumes the same agent + claude conversation. Undefined when nothing is bound
   * (the first mention) or the newest run predates the claude-id column (unresumable → fresh spawn).
   */
  sessionForDiscordThread(channel: string): { sessionId: string; agent: string; runAs?: string; claudeSessionId?: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT t.id AS id, t.agent AS agent, t.run_as AS runAs, t.claude_session_id AS claudeSessionId
           FROM discord_threads d JOIN term_sessions t ON t.id = d.session_id
          WHERE d.channel = ?
          ORDER BY t.created_at DESC LIMIT 1`,
      )
      .get<{ id: string; agent: string; runAs: string | null; claudeSessionId: string | null }>(channel);
    if (!row) return undefined;
    return { sessionId: row.id, agent: row.agent, runAs: row.runAs ?? undefined, claudeSessionId: row.claudeSessionId ?? undefined };
  }
  /**
   * The session that posted a given Discord message — the reply-reference continuity key. A guild
   * message that doesn't @mention us but REPLIES to something an agent wrote is addressed to that
   * agent; `discord_threads` (channel-keyed) can't see it, because a proactive `discord_send` posts
   * into a channel with no thread and binding the whole channel would make every unrelated message in
   * it continue the run.
   */
  sessionForDiscordMessage(channel: string, messageId: string): { sessionId: string; agent: string; runAs?: string; claudeSessionId?: string } | undefined {
    if (!channel || !messageId) return undefined;
    const row = this.db
      .prepare(
        `SELECT t.id AS id, t.agent AS agent, t.run_as AS runAs, t.claude_session_id AS claudeSessionId
           FROM discord_bot_messages m JOIN term_sessions t ON t.id = m.session_id
          WHERE m.channel = ? AND m.message_id = ?
          ORDER BY t.created_at DESC LIMIT 1`,
      )
      .get<{ id: string; agent: string; runAs: string | null; claudeSessionId: string | null }>(channel, messageId);
    if (!row) return undefined;
    return { sessionId: row.id, agent: row.agent, runAs: row.runAs ?? undefined, claudeSessionId: row.claudeSessionId ?? undefined };
  }

  /** Record that an agent posted this Discord message, so a reply to it routes back to that run.
   *  Written by `discord_reply` and `discord_send` — the agent's own voice. */
  noteDiscordMessage(sessionId: string, channel: string, messageId: string): void {
    if (!sessionId || !channel || !messageId) return;
    try {
      this.db.prepare('INSERT OR REPLACE INTO discord_bot_messages (channel, message_id, session_id, created_at) VALUES (?, ?, ?, ?)')
        .run(channel, messageId, sessionId, Date.now());
    } catch { /* best-effort index; never break a post over it */ }
  }

  /** Did an agent post the message this one replies to? The deterministic "is this addressed to us"
   *  test the Discord socket uses before dropping a guild message that carries no @mention. */
  knowsDiscordMessage(channel: string, messageId: string): boolean {
    if (!channel || !messageId) return false;
    return !!this.db.prepare('SELECT 1 FROM discord_bot_messages WHERE channel = ? AND message_id = ?').get(channel, messageId);
  }

  /**
   * The MOST RECENT session bound to a ClickUp task — the thread-continuity twin of
   * {@link sessionForSlackThread}, keyed on the task id (the natural ClickUp "thread"). A follow-up
   * `/agentname` comment on the same task resumes THAT run's agent + claude conversation. Undefined when
   * nothing is bound (the first command on the task) or the newest run is unresumable (→ fresh spawn).
   */
  sessionForClickupThread(taskId: string): { sessionId: string; agent: string; runAs?: string; claudeSessionId?: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT t.id AS id, t.agent AS agent, t.run_as AS runAs, t.claude_session_id AS claudeSessionId
           FROM clickup_threads c JOIN term_sessions t ON t.id = c.session_id
          WHERE c.task_id = ?
          ORDER BY t.created_at DESC LIMIT 1`,
      )
      .get<{ id: string; agent: string; runAs: string | null; claudeSessionId: string | null }>(taskId);
    if (!row) return undefined;
    return { sessionId: row.id, agent: row.agent, runAs: row.runAs ?? undefined, claudeSessionId: row.claudeSessionId ?? undefined };
  }
  /**
   * The MOST RECENT session bound to a Telegram chat (+ forum topic) — the thread-continuity twin of
   * {@link sessionForDiscordThread}. Telegram bots can't branch a thread off a message, so continuity is
   * keyed on the chat id (+ the supergroup forum-topic id when present, so distinct topics stay distinct).
   * A plain follow-up in that chat resumes the same agent + claude conversation. Undefined when nothing is
   * bound (the first mention) or the newest run predates the claude-id column (unresumable → fresh spawn).
   */
  sessionForTelegramThread(chatId: string, messageThreadId: string): { sessionId: string; agent: string; runAs?: string; claudeSessionId?: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT t.id AS id, t.agent AS agent, t.run_as AS runAs, t.claude_session_id AS claudeSessionId
           FROM telegram_threads g JOIN term_sessions t ON t.id = g.session_id
          WHERE g.chat_id = ? AND g.message_thread_id = ?
          ORDER BY t.created_at DESC LIMIT 1`,
      )
      .get<{ id: string; agent: string; runAs: string | null; claudeSessionId: string | null }>(chatId, messageThreadId || '');
    if (!row) return undefined;
    return { sessionId: row.id, agent: row.agent, runAs: row.runAs ?? undefined, claudeSessionId: row.claudeSessionId ?? undefined };
  }
  /** Detach every session bound to a Telegram chat (+ forum topic), so the NEXT message in that chat
   *  starts a FRESH run instead of continuing/reviving the last one — the `/new` reset. Removes only the
   *  reply bindings; the session rows themselves stay for history (the caller stops the live one first). */
  clearTelegramBinding(chatId: string, messageThreadId: string): void {
    this.db.prepare('DELETE FROM telegram_threads WHERE chat_id = ? AND message_thread_id = ?').run(chatId, messageThreadId || '');
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
         WHERE m.dismissed_at IS NULL AND ms.dismissed_at IS NULL AND m.type NOT IN ('task.chat', 'task.mention')
         ORDER BY m.created_at DESC
         LIMIT 500`,
      )
      // Bound the newest 500 non-dismissed cards. This poll runs every 1.5s per open console tab and,
      // on a busy tenant, the un-capped scan (+4 joins) grew with all-time inbox history — the synchronous
      // node:sqlite call blocking the whole event loop. 500 far exceeds what the inbox usefully renders;
      // owner/admin see all and the `mine` scope narrows further below, so this only caps a pathological
      // backlog of undismissed cards (mark-all-read/dismiss iterate this list — capped to the same 500).
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
  createSession(agent: string, title: string, task: string, spawnedBy?: string, headless = false, slack?: { channel: string; threadTs: string }, discord?: { channel: string; messageId: string }, runAs?: string, resumeClaudeId?: string, resident = false, tuning?: RuntimeTuning, clickup?: { taskId: string; commentId: string }, telegram?: { chat: string; messageThreadId?: string; messageId: string }): Session {
    const id = newId('session');
    const tmux = `aos-${id}`;
    // The conversation this run drives. A thread follow-up passes the PRIOR run's id so the launcher
    // resumes the same transcript and keeps context. Persisted on the row so a later follow-up can look
    // it up (see sessionForSlackThread).
    //
    // For a fresh run we may only MINT the id when the runtime lets us PIN it (`claude --session-id`).
    // Codex mints its own rollout UUID and has no such flag, so pre-filling the column here would store
    // a random id that matches no real transcript — and, because `recordRuntimeSessionId` is
    // first-write-wins, it would then REJECT the real id the launcher reports, silently breaking
    // resume/fork for every Codex run. Leave it NULL and let the launcher's report be the first write.
    const runtimeOf = this.os.agents.get(agent)?.runtime;
    const claudeSessionId = resumeClaudeId || (runtimeSupports(runtimeOf, 'pinnedSessionId') ? randomUUID() : null);
    // P2 — provenance vs identity:
    //   `spawnedBy`     = what TRIGGERED this run (an `automation:<id>` or the console member). Stays
    //                     provenance: drives the inbox source label, the audit principal, isolation
    //                     fallback, and the automation-creator's visibility.
    //   `actingMember`  = whose IDENTITY the agent acts under (connectors / Composio / inbox / uid).
    //                     `runAs` when a trigger resolved a member, else the console member who spawned.
    // When no runAs is given this collapses to today's behavior (identity = the spawning member).
    const actingMember = this.resolveActingMember(runAs, spawnedBy);
    // Per-session bearer (0d): exported into the session env and required on the loopback agent
    // endpoints, so one session's runtime can't gate/recall/report AS another by forging its id.
    const secret = randomBytes(24).toString('hex');
    const session: Session = { id, agent, title, task, tmux, status: 'running', createdAt: Date.now(), updatedAt: Date.now() };
    this.db
      .prepare('INSERT INTO term_sessions (id, agent, title, task, tmux, status, spawned_by, run_as, secret, claude_session_id, resident, last_activity, headless, busy_since, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(session.id, agent, title, task, tmux, 'running', spawnedBy ?? null, actingMember ?? null, secret, claudeSessionId, resident ? 1 : 0, resident ? session.createdAt : null, headless ? 1 : 0, session.createdAt, session.createdAt, session.createdAt);
    // No spawn card — the Inbox is a feed of agent-authored signals (progress / questions / approvals /
    // completions / artifacts), not a session lifecycle log. A run that never speaks stays off the feed
    // and lives only on the Sessions page.

    // Native Slack egress: bind this session to the channel/thread it should reply into, so the
    // agentos `slack_reply` tool can post back without the agent supplying (or spoofing) a channel.
    if (slack?.channel) {
      this.db.prepare('INSERT OR REPLACE INTO slack_threads (session_id, channel, thread_ts, created_at) VALUES (?, ?, ?, ?)')
        .run(id, slack.channel, slack.threadTs || '', Date.now());
      if (slack.threadTs) this.noteSlackThread(id, slack.channel, slack.threadTs);
    }
    // Native Discord egress: the exact analogue — bind the channel + triggering message for discord_reply.
    if (discord?.channel) {
      this.db.prepare('INSERT OR REPLACE INTO discord_threads (session_id, channel, message_id, created_at) VALUES (?, ?, ?, ?)')
        .run(id, discord.channel, discord.messageId || '', Date.now());
    }
    // Native ClickUp egress: bind the task (+ triggering comment) for clickup_reply — the agent posts
    // its answer back as a comment on the SAME task, without supplying (or spoofing) a task id.
    if (clickup?.taskId) {
      this.db.prepare('INSERT OR REPLACE INTO clickup_threads (session_id, task_id, comment_id, created_at) VALUES (?, ?, ?, ?)')
        .run(id, clickup.taskId, clickup.commentId || '', Date.now());
    }
    // Native Telegram egress: bind the chat (+ forum topic + triggering message) for telegram_reply — the
    // agent posts its answer back into the SAME chat as a reply, without supplying (or spoofing) a chat id.
    if (telegram?.chat) {
      this.db.prepare('INSERT OR REPLACE INTO telegram_threads (session_id, chat_id, message_thread_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, telegram.chat, telegram.messageThreadId || '', telegram.messageId || '', Date.now());
    }

    // Pick the runtime from the agent's manifest: a coding runtime (claude-code / codex) → that real
    // CLI in the agent's folder; anything else (incl. unknown/demo names) → the scripted mock runner.
    const manifest = this.os.agents.get(agent);
    const runtime = manifest?.runtime ?? 'mock';
    // Audit records BOTH provenance and the run-as principal — when they differ (a trigger acting as
    // a member), the trail shows what fired it AND whose identity it used.
    this.audit(id, agent, 'session.created', { tmux, task, runtime, dir: manifest?.dir, headless, resident, spawnedBy: spawnedBy ?? null, runAs: actingMember ?? null });

    // "Picked up" beat for a DELEGATED, unattended run (automation/task provenance): its owner isn't
    // watching the console, so without this they learn nothing until it finishes, asks, or crashes. Fire a
    // `started` lifecycle event → an opt-in DM to the run's owner (gated on their `dm` pref; no inbox card,
    // to keep the feed agent-authored). Deliberately scoped: a console-spawned run (the operator is right
    // there) and a chat run (its thread already gets an "on it" ack) skip this, so it's a signal, not noise.
    if (spawnedBy && (spawnedBy.startsWith('automation:') || spawnedBy.startsWith('task:'))) {
      this.fireSessionEvent(id, agent, 'started', `Started — ${agent}`, task || 'A delegated run began.');
    }

    if (isCodingRuntime(runtime) && manifest?.dir) {
      this.launchAgentRuntime({ id, agent, task, secret, actingMember, spawnedBy, hasSlack: !!slack?.channel, hasDiscord: !!discord?.channel, hasClickup: !!clickup?.taskId, hasTelegram: !!telegram?.chat, headless, resident, resume: !!resumeClaudeId, claudeSessionId, tuning });
    } else {
      this.backend.spawn(this.spaceFor(actingMember ?? spawnedBy), { sessionId: id, agent, tmuxName: tmux, env: this.sessionEnv(id, agent, task, secret), argv: ['bash', this.runner] });
    }
    return session;
  }

  /**
   * FORK a session: start a NEW, independent session that BRANCHES from an existing conversation. The
   * fork inherits the parent's full context (`claude --resume <parent> --fork-session`) but gets its own
   * session id, tmux pane, and a NEW claude session id — so it diverges from the branch point while the
   * parent transcript is left completely untouched. Always an interactive, attachable run (a human is
   * branching to explore/steer), optionally seeded with a `task` (the follow-up that kicks off the
   * branch). Same agent + folder as the parent (the transcript is keyed to that folder); run-as identity
   * is inherited from the parent (it's the same conversation continued), with the forking member as
   * provenance. Returns the new session, or an error when the parent isn't a forkable claude-code run.
   */
  forkSession(sourceId: string, by: string, task?: string): { ok: boolean; session?: Session; error?: string } {
    const src = this.db.prepare('SELECT agent, claude_session_id, run_as FROM term_sessions WHERE id = ?')
      .get<{ agent: string; claude_session_id: string | null; run_as: string | null }>(sourceId);
    if (!src) return { ok: false, error: 'unknown session' };
    const manifest = this.os.agents.get(src.agent);
    if (!runtimeSupports(manifest?.runtime, 'fork') || !manifest?.dir) return { ok: false, error: `forking is not supported by this agent's runtime` };
    if (!src.claude_session_id) return { ok: false, error: 'this session has no conversation to fork yet' };

    const id = newId('session');
    const tmux = `aos-${id}`;
    // The fork's OWN new conversation id (distinct from the parent's) — `--fork-session --session-id`
    // copies the parent history into it, leaving the parent's transcript intact. Only mint it when the
    // runtime lets us pin it: `codex fork <parent>` mints the branch's id ITSELF, so pre-filling the
    // column would store an id matching no transcript AND block the launcher's real report (see the
    // same trap in createSession).
    const claudeSessionId = runtimeSupports(manifest.runtime, 'pinnedSessionId') ? randomUUID() : null;
    // Inherit the branch identity (connectors/Composio/uid follow run_as); fall back to the forker when
    // the parent had none. Provenance (`spawned_by`) is the forking member — this fork was console-driven.
    const actingMember = this.resolveActingMember(src.run_as ?? undefined, by);
    const secret = randomBytes(24).toString('hex');
    const seed = (task || '').trim();
    const title = `fork of ${sourceId}${seed ? ' · ' + (seed.length > 48 ? seed.slice(0, 47) + '…' : seed) : ''}`;
    const now = Date.now();
    const session: Session = { id, agent: src.agent, title, task: seed, tmux, status: 'running', createdAt: now, updatedAt: now };
    this.db
      .prepare('INSERT INTO term_sessions (id, agent, title, task, tmux, status, spawned_by, run_as, secret, claude_session_id, resident, last_activity, headless, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, src.agent, title, seed, tmux, 'running', by ?? null, actingMember ?? null, secret, claudeSessionId, 0, null, 0, now, now);
    this.audit(id, src.agent, 'session.forked', { from: sourceId, fromClaudeId: src.claude_session_id, claudeSessionId, runAs: actingMember ?? null, by });
    this.launchAgentRuntime({
      id, agent: src.agent, task: seed, secret, actingMember, spawnedBy: by,
      hasSlack: false, hasDiscord: false, hasClickup: false, hasTelegram: false, headless: false, resident: false, resume: false,
      claudeSessionId, forkFrom: src.claude_session_id,
    });
    return { ok: true, session };
  }

  /**
   * Start the runtime for a session row WITHOUT blocking the caller. Every caller (createSession, a
   * chat turn, a revive, a fork) has already written the row and has nothing left to decide, so the
   * actual launch — which does real I/O (Composio mints, file materialisation, tmux) — is handed to
   * the next tick and the caller returns immediately. That is what lets `POST /api/chat/start` answer
   * in milliseconds instead of after the mints, and it keeps one launch from stalling other requests.
   *
   * The row is registered in {@link launching} for the gap between "scheduled" and "pane exists", so
   * `reachable` reports the session as live throughout and the busy/pile-up guards that depend on it
   * (chatSend, dispatchTask) can't double-launch into the same transcript. Errors are audited rather
   * than thrown: there is no caller left to catch them.
   */
  private launchAgentRuntime(o: LaunchSpec): void {
    if (!this.os.agents.get(o.agent)?.dir) return;
    this.launching.add(o.id);
    this.markLaunching(o.id, true);
    setImmediate(() => {
      void this.launchAgentRuntimeNow(o)
        .catch((e) => {
          this.audit(o.id, o.agent, 'session.launch.failed', { error: e instanceof Error ? e.message : String(e) });
          this.db.prepare("UPDATE term_sessions SET status = 'crashed', busy_since = NULL, updated_at = ? WHERE id = ?").run(Date.now(), o.id);
        })
        .finally(() => { this.launching.delete(o.id); this.markLaunching(o.id, false); });
    });
  }

  /** Path of a session's "pane is coming up" marker (see {@link markLaunching} / attach.sh). */
  private launchMarkerPath(sessionId: string): string | null {
    return this.os.paths ? path.join(this.os.paths.connectors, `session-${sessionId}.launching`) : null;
  }

  /**
   * Mirror {@link launching} onto disk for the ttyd attach wrapper. attach.sh runs in its own process
   * and can't see this Set, so before it existed the wrapper guessed the launch window with a fixed
   * ~3s timer — which is a guess about how fast the box is, and on a loaded host it loses: at load 76
   * an instawp spawn took 13.3s, the guess expired, and the user got tmux's raw "can't find session"
   * for a run that went on to succeed. With the marker the wrapper waits exactly as long as a launch
   * is actually in flight. Cleared in the launch's `finally` (so a FAILED launch releases it too) and
   * swept at boot by {@link sweepLaunchMarkers}, so the only way to orphan one is `kill -9` mid-launch
   * — which the wrapper's own ceiling then bounds. Best-effort: never fail a launch over a marker.
   */
  private markLaunching(sessionId: string, on: boolean): void {
    const p = this.launchMarkerPath(sessionId);
    if (!p || !this.os.paths) return;
    try {
      if (!on) { fs.rmSync(p, { force: true }); return; }
      this.ensureSecureDir(this.os.paths.connectors);
      fs.writeFileSync(p, '', { mode: 0o600 });
    } catch { /* best-effort */ }
  }

  /** Drop launch markers orphaned by a server killed mid-launch. Runs once at construction: nothing is
   *  launching yet, so every marker on disk is by definition stale, and leaving one would make the next
   *  attach to that dead session sit through attach.sh's ceiling before giving up. */
  private sweepLaunchMarkers(): void {
    if (!this.os.paths) return;
    try {
      for (const f of fs.readdirSync(this.os.paths.connectors)) {
        if (f.startsWith('session-') && f.endsWith('.launching')) fs.rmSync(path.join(this.os.paths.connectors, f), { force: true });
      }
    } catch { /* dir may not exist yet — nothing to sweep */ }
  }

  /**
   * Spawn the claude-code runtime for a session row (in its agent folder, governed by the gate hook).
   * Factored out of `createSession` so `reviveResident` can re-launch the SAME row (same id/tmux/secret/
   * claude id) after the warm session was reaped — with `resume: true` it continues the transcript.
   * Memory + connectors are delivered purely as MCP tools via the per-session `.mcp.json`; the
   * orchestrator injects nothing into the prompt.
   */
  private async launchAgentRuntimeNow(o: LaunchSpec): Promise<void> {
    const manifest = this.os.agents.get(o.agent);
    if (!manifest?.dir) return;
    const tmux = `aos-${o.id}`;
    const env = this.sessionEnv(o.id, o.agent, o.task, o.secret);
    // Build the per-session connector + company payloads once (Composio is minted here).
    // An ask_agent delegate (provenance `ask:<caller>`) gets the `answer` tool to close the loop back to
    // its caller — keyed on provenance so no other session is cluttered by it.
    const askAnswer = (o.spawnedBy ?? '').startsWith('ask:');
    const mcpJson = await this.buildMcpConfigJson(o.id, o.agent, o.actingMember, o.secret, o.hasSlack, o.hasDiscord, askAnswer, o.hasClickup, o.hasTelegram);
    const runtime: CodingRuntimeId = isCodingRuntime(manifest.runtime) ? manifest.runtime : 'claude-code';
    const caps = CODING_RUNTIMES[runtime].capabilities;
    const tuning = resolveRuntimeTuning(manifest, this.os.settings.runtimeDefaults(), o.tuning, runtime);
    // The unattended brief rides the same appended prompt, on exactly the lane `markTurnIdle` tears down
    // at turn-end (headless, non-resident) — a resident chat pane and a member's own session both survive
    // a turn boundary, so telling them "this run ends when your turn ends" would simply be false.
    // The memory preamble is I/O (a recall against the live store), so it is resolved HERE — in the
    // async launcher — and handed to `buildCompanyMd`, which stays a pure synchronous assembly of the
    // prompt. Keeps every other caller (and four governance tests) on the sync signature.
    const preamble = await this.memoryPreamble(o.agent, o.task);
    const companyMd = this.buildCompanyMd(o.agent, o.actingMember, !!o.headless && !o.resident, preamble);
    // Skills + sub-agents are materialised as native filesystem conventions (`.claude/skills`,
    // `.claude/agents`), so they only apply to a runtime that discovers them. Codex has its own
    // (differently-shaped) skills mechanism — not wired yet, so we skip rather than write files it
    // would ignore. The agent still gets its persona + Company context via the launcher's AGENTS.md.
    if (caps.nativeSkills) this.materializeSkills(o.id, o.agent, manifest.dir);
    // Custom output styles are the same filesystem convention (`.claude/output-styles/`), and only the
    // SELECTED one applies — so the whole library is synced and no per-agent allowlist is needed.
    if (caps.outputStyle) this.materializeOutputStyles(o.id, o.agent, manifest.dir);
    if (caps.nativeSubagents) this.materializeSubagents(o.id, o.agent, manifest);
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
    env.HOOK = this.gateHookFor(runtime);
    // Tells the shared gate hook which tool→capability routing table to use.
    env.AOS_RUNTIME = runtime;
    // No OS sandbox env: the gate hook (PreToolUse) is the sole authority for governed side effects, so
    // we don't wrap the shell in Seatbelt/bubblewrap. Real OS containment is the Linux uid-isolation path.
    // Per-agent model / effort / permission-mode fall back to the workspace default; the launcher maps
    // them onto `--model`/`--effort`/`--permission-mode` (permission-mode on the interactive lane only).
    if (runtime === 'codex') {
      // Codex reads model/effort from the config.toml the launcher generates; it has no
      // --permission-mode (Agentric is the sole authority there via approval_policy = "never"), so
      // permissionMode is deliberately not forwarded.
      if (tuning.model) env.CODEX_MODEL = tuning.model;
      if (tuning.effort) env.CODEX_EFFORT = tuning.effort;
    } else if (runtime === 'opencode') {
      // opencode takes `provider/model` on --model. Effort is a per-provider `--variant` rather than
      // a portable scale, and permission-mode has no analogue (Agentric is the sole authority via the
      // generated config's `permission: allow`), so neither is forwarded.
      if (tuning.model) env.OPENCODE_MODEL = tuning.model;
    } else {
      if (tuning.model) env.CLAUDE_MODEL = tuning.model;
      if (tuning.effort) env.CLAUDE_EFFORT = tuning.effort;
      if (tuning.permissionMode) env.CLAUDE_PERMISSION_MODE = tuning.permissionMode;
      // Not a CLI flag — the launcher writes it into the `--settings` JSON as `outputStyle`, which is
      // how Claude Code takes a style. `Default` is left unset: naming it is a no-op, and an absent key
      // keeps a lower settings layer (or a plugin's forced style) doing whatever it already did.
      if (tuning.outputStyle && tuning.outputStyle !== 'Default') env.CLAUDE_OUTPUT_STYLE = tuning.outputStyle;
    }
    this.audit(o.id, o.agent, 'session.tuning', { runtime, model: tuning.model, effort: tuning.effort, permissionMode: caps.permissionMode ? tuning.permissionMode : undefined, outputStyle: tuning.outputStyle, override: o.tuning ?? null });
    // Account rotation: if a POOL is configured for this runtime, pick an available account and point the
    // session at its credentials via the runtime's own env vars (CODING_RUNTIMES[runtime].credentialEnv).
    // INERT when the pool is empty — pick() returns null, we set nothing, the CLI uses the box default (i.e.
    // today's behavior). pick() also returns null when every account is limited; a member launch then still
    // proceeds on the default (better than blocking the human), while the scheduler defers cron upstream.
    this.applyRuntimeAccount(env, o.id, o.agent, runtime, o.resident);
    // Then, only if rotation left the credentials on the box default, swap the USER-SCOPE config layer for
    // a tenant-owned one (opt-in) — see applyConfigIsolation.
    this.applyConfigIsolation(env, o.id, o.agent, runtime);
    // Credentials are now settled (pool account, isolated dir, or the box default) — so this is the one
    // place that can ask the question that actually matters: can this environment authenticate? A locked
    // macOS login keychain answers no for every claude run on the box, and answers it INVISIBLY unless we
    // check: the CLI starts, burns a turn, exits at $0, and the pool badge still shows the usage snapshot
    // it took before the lock. Refuse instead — one crashed session that says why beats an unbounded run
    // of them that don't. See preflightCredential.
    if (!this.assertCredentialsUsable(env, o, runtime)) return;
    if (caps.pinnedSessionId) {
      // A stable claude session id we choose (vs letting claude mint its own), so a stopped session can be
      // resumed in-place with `claude --resume <id>`. `resume` continues that transcript (a thread
      // follow-up or a console reconnect) instead of starting fresh.
      if (o.claudeSessionId) env.CLAUDE_SESSION_ID = o.claudeSessionId;
    } else {
      // Codex mints its OWN rollout id, so there is nothing to pin: the launcher discovers it from the
      // per-session CODEX_HOME and POSTs it to /api/runtime-session. On a resume we hand back whatever
      // it reported (persisted in the same column) so it can continue that transcript.
      if (o.resume && o.claudeSessionId) env.RUNTIME_SESSION_ID = o.claudeSessionId;
      // The per-session CODEX_HOME is how the CODEX launcher discovers that id. opencode reports its
      // own from the gate plugin (every hook carries `sessionID`), so it needs no such dir.
      if (runtime === 'codex') env.AOS_CODEX_HOME = this.ensureCodexHome(o.id);
    }
    if (o.resume) env.RESUME = '1';
    // Fork: on FIRST launch, branch off the parent conversation. RESUME is never set alongside forkFrom
    // (a fork's first run resumes nothing), and the launcher checks RESUME before FORK_FROM, so a later
    // reattach — which sets RESUME=1 from the persisted env — resumes THIS branch instead of re-forking.
    if (o.forkFrom) env.FORK_FROM = o.forkFrom;
    // The agent's opt-in shell secrets (vault keys → shell env vars, e.g. GH_TOKEN for `gh`).
    this.injectShellSecrets(env, o.agent, manifest, o.id);
    // Secrets ASSIGNED to this agent from the Secrets page — the inverse view of `shellSecrets`,
    // granted centrally rather than declared in the manifest. Same env-var injection, additive.
    this.injectAssignedSecrets(env, o.agent, o.id);
    // Company-bot git baseline: when the App is configured, fill GH_TOKEN with a short-lived, org-scoped
    // installation token so EVERY session can push — no per-agent PAT needed. Only fills the gap: an
    // explicit agent GH_TOKEN (shellSecret/assigned) still wins, and a connected member overrides below.
    this.injectGithubBaseline(env, o.agent, o.id);
    // Per-member git: if THIS run's run-as human has linked their own GitHub account, their token
    // OVERRIDES the bot/agent GH_TOKEN — so git push / gh pr are authored as the actual person.
    this.injectMemberGithub(env, o.agent, o.actingMember, o.id);
    // Whatever set GH_TOKEN above (member token or agent bot), teach plain `git` to use it too — `gh`
    // reads GH_TOKEN natively but `git push` over HTTPS does not, so without this only half the toolchain
    // authenticates. A github.com-scoped credential helper closes that gap.
    this.configureGitCredentials(env);
    // Phase 2c: granted Host connections' SSH keys → a session ssh_config + ssh/scp PATH shim, so the
    // agent's plain `ssh` authenticates to a host without ever handling the key. (Local-lane only.)
    this.injectHostCredentials(env, o.agent, o.actingMember, o.id);
    const launchScript = this.launchScriptFor(runtime);
    if (this.uidIsolation) {
      // Flag on: the launcher writes the files INTO the member's home and sets MCP_CONFIG/COMPANY_FILE/
      // TASK_FILE itself. The task rides as a FILE (not the inline TASK_B64 env) for the same reason as the
      // local lane below — see the delete note there; the launcher points TASK_FILE at the member-home copy.
      //
      // Codex is LOCAL-LANE ONLY for now: the Phase A launcher materialises a fixed set of files into the
      // member home and knows nothing about a per-session CODEX_HOME, so the config/hooks the codex
      // launcher needs would land outside the member's reach. Fail loudly rather than spawn a session
      // whose gate hook was never wired — an ungoverned agent is the one outcome we never allow.
      if (runtime !== 'claude-code') {
        const why = `${CODING_RUNTIMES[runtime].label} sessions are not supported under AOS_UID_ISOLATION yet`;
        this.audit(o.id, o.agent, 'session.launch.refused', { runtime, reason: why });
        this.db.prepare("UPDATE term_sessions SET status = 'crashed', busy_since = NULL, updated_at = ? WHERE id = ?").run(Date.now(), o.id);
        this.addMessage({ type: 'completed', sessionId: o.id, agent: o.agent, title: `Could not start — ${o.agent}`, body: why, status: 'open', outcome: 'crashed', audienceKind: 'sessionOwner', audienceId: o.id });
        return;
      }
      delete env.TASK_B64;
      this.backend.spawn(this.spaceFor(o.actingMember ?? o.spawnedBy), { sessionId: o.id, agent: o.agent, tmuxName: tmux, env, argv: ['bash', launchScript], files: { mcp: mcpJson || undefined, company: companyMd || undefined, task: o.task || undefined }, agentSrc: manifest.dir });
    } else {
      // Flag off: materialise into the app's connectors dir and persist the launch context so the ttyd
      // attach wrapper can resurrect a dead session.
      const mcpFile = this.writeSessionFile(o.id, 'mcp.json', mcpJson);
      if (mcpFile) env.MCP_CONFIG = mcpFile;
      const companyFile = this.writeSessionFile(o.id, 'company.md', companyMd);
      if (companyFile) env.COMPANY_FILE = companyFile;
      // The task rides as a FILE, not the inline TASK_B64 env. LocalSessionBackend.spawn puts EVERY env var
      // on the `tmux new-session` command line, and tmux hard-caps that command at ~16KB ("command too
      // long") — so a base64'd task over ~10KB (e.g. the consolidator's 40-episode batch, or any long
      // chat/automation prompt) made new-session fail SILENTLY: no pane, no transcript, then the liveness
      // sweep flipped the never-launched row to `crashed`. Passing the task by path keeps the command line
      // tiny regardless of task size; the launcher reads TASK_FILE (falling back to TASK_B64 for old
      // persisted resume envs). Drop TASK_B64 once the file is written so it can't re-inflate the cmdline.
      const taskFile = this.writeSessionFile(o.id, 'task', o.task);
      if (taskFile) { env.TASK_FILE = taskFile; delete env.TASK_B64; }
      // Persist the launch env for EVERY run, unattended ones included. This used to be interactive-only,
      // which quietly made `resumable` ("this id has an env file") double as "this run is attended" — so a
      // headless run taken over while its pane was STILL LIVE stayed non-resumable forever: `claimSession`
      // relaunches nothing, so nothing ever wrote the env, and the console's Reload / Reload-on-another-
      // account items were permanently hidden for it (live instawp run, 2026-08-27). The two lanes are told
      // apart by the `headless` COLUMN now, never by the presence of this file. Safe on the teardown side:
      // `teardownUnattended` → `markEnded` → `blockResume` drops the stay-stopped sentinel, so a reaped
      // unattended run can't be resurrected behind our back by ttyd's silent auto-reconnect.
      this.writeEnvFile(o.id, env);
      this.backend.spawn(this.spaceFor(o.actingMember ?? o.spawnedBy), { sessionId: o.id, agent: o.agent, tmuxName: tmux, env, argv: ['bash', launchScript] });
    }
  }

  /**
   * Create (0700) the per-session `$CODEX_HOME` a Codex run redirects all of its config + state into,
   * and return its path. Two reasons it is per-SESSION rather than per-agent:
   *  - the generated config.toml/hooks.json can't disturb the operator's own `~/.codex`; and
   *  - `sessions/` then holds EXACTLY ONE rollout file, which is how the launcher discovers the id
   *    Codex minted (there is no `--session-id` to pin) before POSTing it to /api/runtime-session.
   * It lives beside the other `session-<id>.*` artefacts, so `removeSessionFiles` — which is prefix
   * matched and recursive — already cleans it up when the session is deleted.
   */
  /** The per-session `$CODEX_HOME` path WITHOUT creating it — for readers that only want to look. */
  private codexHomePath(sessionId: string): string | undefined {
    return this.os.paths ? path.join(this.os.paths.connectors, `session-${sessionId}.codex`) : undefined;
  }

  /**
   * Cost + shape for a session, read from whichever transcript its runtime writes. Claude Code's lives
   * in the global `~/.claude/projects` tree keyed by the pinned id; Codex's is a rollout inside the run's
   * own `$CODEX_HOME`. One dispatcher so every caller (the sweep, the console, insights) stays runtime-
   * agnostic. `null` = no transcript yet / unreadable, exactly as before.
   */
  private readCostFor(sessionId: string, agent: string, runtimeSessionId: string) {
    const runtime = this.os.agents.get(agent)?.runtime;
    if (runtime === 'codex') {
      const home = this.codexHomePath(sessionId);
      const file = home ? findCodexRollout(home) : undefined;
      return file ? readCodexCost(file) : null;
    }
    // A runtime with no transcript reader (opencode) must report "unknown", NOT fall through to the
    // Claude reader — that one resolves an id against `~/.claude/projects`, where a foreign session id
    // simply is not, so the honest `null` would arrive as a confidently wrong zero.
    if (!runtimeSupports(runtime, 'transcript')) return null;
    return readSessionCost(runtimeSessionId);
  }

  /**
   * The friendly chat timeline for a session, from whichever transcript its runtime writes. Returns the
   * same `Conversation` shape for both, so the console renders them identically.
   */
  sessionConversation(sessionId: string): Conversation {
    const row = this.db.prepare('SELECT agent, claude_session_id FROM term_sessions WHERE id = ?')
      .get<{ agent: string; claude_session_id: string | null }>(sessionId);
    if (!row) return { turns: [], found: false };
    const runtime = this.os.agents.get(row.agent)?.runtime;
    if (runtime === 'codex') {
      const home = this.codexHomePath(sessionId);
      const file = home ? findCodexRollout(home) : undefined;
      return file ? readCodexConversation(file) : { turns: [], found: false };
    }
    // Same reasoning as readCostFor: no reader → an empty timeline, never the Claude tree.
    if (!runtimeSupports(runtime, 'transcript')) return { turns: [], found: false };
    this.refreshTranscriptRoots(); // an account added since boot writes somewhere the reader doesn't know yet
    return row.claude_session_id ? readConversation(row.claude_session_id) : { turns: [], found: false };
  }

  private ensureCodexHome(sessionId: string): string {
    if (!this.os.paths) return '';
    const dir = path.join(this.os.paths.connectors, `session-${sessionId}.codex`);
    this.ensureSecureDir(dir);
    return dir;
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
    // Any LIVE claude pane can be typed into — `resident` marks a warm chat session, not "reachable".
    // Gating on it made every unattended (task/automation) run unreachable: a task-discussion HOLD could
    // not reach the agent executing the task, and `continueTaskThread` fell through to spawning a SECOND
    // agent on the same task while the first kept working. Observed live on northwind 2026-08-06
    // (tsk_67de2dfe): the stand-down went to a fresh run, the real one ran on for 25+ minutes.
    // Liveness is the PANE, not the row's `status` — the same lesson one layer up. An agent that called
    // `report` reads `done` with its claude still running, and gating on `status = 'running'` made those
    // sessions unreachable exactly like the `resident` gate above did (see `reachable`).
    if (!row || !this.reachable(sessionId)) return false;
    const body = (text || '').replace(/\r?\n+/g, ' ').trim(); // one-line: a stray newline would submit early
    if (!body) return false;
    const space = this.spaceFor(row.run_as ?? row.spawned_by);
    const turn: 'idle' | 'busy' | 'blocked' | 'unknown' =
      this.hasPendingHumanBlock(sessionId) ? 'blocked' : this.residentTurnState(space, row.tmux);
    const ok = this.backend.injectText(space, row.tmux, body, true);
    if (ok) {
      // `busy_since` = a turn is in flight. On a WARM session the pane outlives the turn, so this (not
      // pane liveness) is what "working" means; the Stop-hook beacon clears it. Set on delivery even when
      // the message QUEUES behind a running turn — the session is busy either way.
      this.db.prepare('UPDATE term_sessions SET last_activity = ?, busy_since = COALESCE(busy_since, ?), updated_at = ? WHERE id = ?')
        .run(Date.now(), Date.now(), Date.now(), sessionId);
      this.restoreRunningAfterDelivery(sessionId); // a reported-but-warm session is working again
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
    if (this.reachable(sessionId)) return false; // caller should have delivered instead
    const body = (text || '').trim();
    if (!body) return false;
    const actingMember = this.resolveActingMember(runAs ?? row.run_as ?? undefined);
    const hasSlack = !!this.db.prepare('SELECT 1 FROM slack_threads WHERE session_id = ?').get(sessionId);
    const hasDiscord = !!this.db.prepare('SELECT 1 FROM discord_threads WHERE session_id = ?').get(sessionId);
    const hasClickup = !!this.db.prepare('SELECT 1 FROM clickup_threads WHERE session_id = ?').get(sessionId);
    const hasTelegram = !!this.db.prepare('SELECT 1 FROM telegram_threads WHERE session_id = ?').get(sessionId);
    this.db.prepare("UPDATE term_sessions SET status = 'running', resident = 1, task = ?, run_as = ?, last_activity = ?, busy_since = ?, updated_at = ? WHERE id = ?")
      .run(body, actingMember ?? null, Date.now(), Date.now(), Date.now(), sessionId);
    this.audit(sessionId, row.agent, 'chat.revived', { runAs: actingMember ?? null });
    this.launchAgentRuntime({
      id: sessionId, agent: row.agent, task: body, secret: row.secret ?? randomBytes(24).toString('hex'),
      actingMember, spawnedBy: row.spawned_by ?? undefined, hasSlack, hasDiscord, hasClickup, hasTelegram,
      headless: false, resident: true, resume: true, claudeSessionId: row.claude_session_id,
    });
    return true;
  }

  /**
   * Send the human's next turn into a NATIVE-CONSOLE chat session — WARM when the pane is still up.
   *
   * Console chat used to relaunch the runtime for every turn (a headless `--resume` seeded with the
   * message). That was a deliberate trade at the time: the message-as-launch-prompt reliably starts a
   * turn where injected keystrokes might not, and a run that tears itself down keeps `alive` honest.
   * It also cost a full cold start on EVERY turn — measured 3.7–6.7s to first token on the live tenant,
   * paid again for every "and one more thing".
   *
   * So this now takes Slack's warm path first (`deliverToResident` — send-keys into the live claude,
   * which is why chat sessions are spawned RESIDENT) and keeps the two properties that motivated the
   * cold design:
   *  - **`alive` stays honest** because it is no longer the signal: `busy_since` marks a turn in flight
   *    and the Stop-hook beacon (`markTurnIdle`) clears it, so the console spins on `working`, not on
   *    "a pane exists".
   *  - **A keystroke that doesn't take is repaired, not lost**: `confirmWarmTurn` re-checks the
   *    transcript shortly after delivery and falls back to the cold relaunch if nothing started.
   *
   * A message typed while a turn is generating is DELIVERED, not refused — claude queues it and reads it
   * at the turn boundary (the same hand-off Slack threads rely on), so 'busy' is no longer returned for
   * a live pane. Returns 'sent', or 'error' for an unknown / non-resumable session.
   */
  chatSend(sessionId: string, message: string, runAs?: string): 'sent' | 'busy' | 'error' {
    const row = this.db.prepare('SELECT agent, secret, claude_session_id, run_as, spawned_by, tmux FROM term_sessions WHERE id = ?')
      .get<{ agent: string; secret: string | null; claude_session_id: string | null; run_as: string | null; spawned_by: string | null; tmux: string }>(sessionId);
    if (!row || !row.claude_session_id) return 'error';
    const body = (message || '').trim();
    if (!body) return 'error';
    const actingMember = this.resolveActingMember(runAs ?? row.run_as ?? undefined);

    // WARM — the pane is still up, so the turn costs nothing but the model. Checked on the PANE (the rule
    // `reachable` now carries everywhere): a chat session that ended its last turn with `report` reads
    // `done` while its claude is very much alive, and a new human turn is what makes it running again.
    if (this.paneAlive(row.tmux)) {
      const before = this.transcriptMark(row.claude_session_id);
      this.db.prepare("UPDATE term_sessions SET status = 'running', headless = 0, resident = 1, task = ?, run_as = ?, updated_at = ? WHERE id = ?")
        .run(body, actingMember ?? null, Date.now(), sessionId);
      if (this.deliverToResident(sessionId, body)) {
        this.audit(sessionId, row.agent, 'chat.turn', { runAs: actingMember ?? null, mode: 'warm' });
        this.confirmWarmTurn(sessionId, body, before, runAs);
        return 'sent';
      }
      // Delivery failed on a live pane (a wedged TUI, an unreadable socket). Kill it before relaunching —
      // two claudes on one transcript is the one outcome worse than a slow turn.
      this.audit(sessionId, row.agent, 'chat.deliver.failed', { action: 'relaunch' });
      this.backend.kill(this.spaceFor(actingMember ?? row.spawned_by), row.tmux);
    }

    // COLD — no pane (reaped, crashed, or just killed above): relaunch in place, resuming the same
    // transcript and seeded with the message. Stays RESIDENT, so the NEXT turn is warm again.
    const hasSlack = !!this.db.prepare('SELECT 1 FROM slack_threads WHERE session_id = ?').get(sessionId);
    const hasDiscord = !!this.db.prepare('SELECT 1 FROM discord_threads WHERE session_id = ?').get(sessionId);
    const hasClickup = !!this.db.prepare('SELECT 1 FROM clickup_threads WHERE session_id = ?').get(sessionId);
    const hasTelegram = !!this.db.prepare('SELECT 1 FROM telegram_threads WHERE session_id = ?').get(sessionId);
    this.db.prepare("UPDATE term_sessions SET status = 'running', headless = 0, resident = 1, task = ?, run_as = ?, last_activity = ?, busy_since = ?, updated_at = ? WHERE id = ?")
      .run(body, actingMember ?? null, Date.now(), Date.now(), Date.now(), sessionId);
    this.audit(sessionId, row.agent, 'chat.turn', { runAs: actingMember ?? null, mode: 'cold' });
    this.launchAgentRuntime({
      id: sessionId, agent: row.agent, task: body, secret: row.secret ?? randomBytes(24).toString('hex'),
      actingMember, spawnedBy: row.spawned_by ?? undefined, hasSlack, hasDiscord, hasClickup, hasTelegram,
      headless: false, resident: true, resume: true, claudeSessionId: row.claude_session_id,
    });
    return 'sent';
  }

  /** Is this tmux pane up? The raw question behind {@link reachable}, minus the row entirely — no
   *  `launching` grace and no `stopped`/`crashed` veto, so `chatSend` can ask about a pane it may be
   *  about to kill. `aliveNames()` is null when liveness can't be polled (launcher backend / failed
   *  poll); we then answer false so the caller takes the cold path, which is correct-by-relaunch rather
   *  than a send-keys into the dark. */
  private paneAlive(tmux: string): boolean {
    const alive = this.backend.aliveNames();
    return alive ? alive.has(tmux) : false;
  }

  /** Size + mtime of a transcript, or null when it doesn't exist yet. The cheap "did anything happen"
   *  probe behind {@link confirmWarmTurn} — parsing the file would cost more and answer the same. */
  private transcriptMark(claudeSessionId: string): { size: number; mtime: number } | null {
    const file = findTranscript(claudeSessionId);
    if (!file) return null;
    try {
      const st = fs.statSync(file);
      return { size: st.size, mtime: st.mtimeMs };
    } catch {
      return null;
    }
  }

  /**
   * The warm path's safety net. Keystrokes are typed into a TUI, and a TUI can be in a state that
   * swallows them (mid-render, a stray modal, a pane that died between the liveness poll and the
   * send) — the exact failure mode that justified relaunching for every turn. So we check: a short
   * while after delivery, has the transcript grown? If not, the turn never started, and we relaunch
   * cold with the same message rather than leave the human watching a spinner that will never resolve.
   *
   * Deliberately conservative — a growing transcript, a killed session, or a newer message all cancel
   * the recovery, so it can only ever fire on a turn that genuinely went nowhere.
   */
  private confirmWarmTurn(sessionId: string, body: string, before: { size: number; mtime: number } | null, runAs?: string): void {
    const timer = setTimeout(() => {
      this.warmChecks.delete(sessionId);
      try {
        const row = this.db.prepare('SELECT agent, claude_session_id, task, status, tmux, run_as, spawned_by FROM term_sessions WHERE id = ?')
          .get<{ agent: string; claude_session_id: string | null; task: string | null; status: string; tmux: string; run_as: string | null; spawned_by: string | null }>(sessionId);
        if (!row || !row.claude_session_id) return;
        if (row.task !== body) return;                       // a newer message superseded this one
        if (row.status === 'stopped' || row.status === 'crashed') return; // deliberately torn down meanwhile
        const after = this.transcriptMark(row.claude_session_id);
        // Anything at all landed → the turn started. (A brand-new transcript counts: before was null.)
        if (after && (!before || after.size > before.size || after.mtime > before.mtime)) return;
        this.audit(sessionId, row.agent, 'chat.deliver.unconfirmed', { afterMs: WARM_CONFIRM_MS });
        if (this.paneAlive(row.tmux)) this.backend.kill(this.spaceFor(row.run_as ?? row.spawned_by), row.tmux);
        // Re-enter the cold branch of chatSend: the pane is gone now, so it relaunches with this message.
        if (this.chatSend(sessionId, body, runAs) === 'sent') this.audit(sessionId, row.agent, 'chat.deliver.recovered', {});
      } catch { /* a failed self-heal must never take the server down */ }
    }, WARM_CONFIRM_MS);
    timer.unref?.();
    const prev = this.warmChecks.get(sessionId);
    if (prev) clearTimeout(prev);
    this.warmChecks.set(sessionId, timer);
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
    // Take-over needs a runtime whose UNATTENDED lane is a live, attachable TUI. Claude Code qualifies;
    // Codex's unattended lane is `codex exec`, a one-shot process that exits at turn end, so there is no
    // pane to claim (and mock has no pane at all).
    const manifest = this.os.agents.get(row.agent);
    if (!runtimeSupports(manifest?.runtime, 'attachableUnattended') || !manifest?.dir) {
      return { ok: false, error: `this agent's runtime has no attachable session to take over` };
    }
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
    // The row now says attended, so the persisted launch env must agree: strip its UNATTENDED marker or a
    // later reattach/Reload would resurrect this run on the unattended lane the turn-end reaper owns. The
    // dead-run take-over below gets this for free (it relaunches with `headless:false`); the live path
    // relaunches nothing, so patch the file in place.
    this.attendLaunchEnv(sessionId);
    // No kill, no relaunch — the live pane keeps streaming; the caller opens ttyd and attaches to it.
    this.audit(sessionId, by, 'session.claimed', { agent: row.agent });
    return { ok: true };
  }

  /**
   * Take over a run REGARDLESS of whether it is still live — the unified "Take over" entry point the
   * console's take-over action hits. Two cases, one call:
   *  - LIVE → delegate to {@link claimSession}: nothing to relaunch, just mark it claimed and the caller
   *    attaches to the still-streaming pane.
   *  - ENDED/STOPPED/CRASHED HEADLESS run (an unattended automation/task/cron/chat turn that already
   *    exited — no live pane, no persisted launch env, so it is NOT `resumable`) → RESURRECT it in place:
   *    `claude --resume` the SAME transcript as a claimed, non-resident interactive TUI, seeded with no
   *    prompt (drop the human straight into a steerable claude). Writes the launch env (so ttyd can attach
   *    + later reattach → it becomes `resumable` from here on) and marks it claimed/sticky (non-resident +
   *    claimed → the reapers all skip it, only the long idle-interactive janitor reclaims it). The caller
   *    then opens the terminal on `aos-<id>` and lands in the resumed conversation.
   * Returns an error only for an unknown / non-claude-code run, or a dead run with no conversation to
   * resume (a headless run that never got a pinned claude session id — nothing to `--resume`).
   */
  takeoverRun(sessionId: string, by: string): { ok: boolean; error?: string } {
    const row = this.db.prepare('SELECT agent, secret, claude_session_id, run_as, spawned_by FROM term_sessions WHERE id = ?')
      .get<{ agent: string; secret: string | null; claude_session_id: string | null; run_as: string | null; spawned_by: string | null }>(sessionId);
    if (!row) return { ok: false, error: 'unknown session' };
    const manifest = this.os.agents.get(row.agent);
    if (!runtimeSupports(manifest?.runtime, 'attachableUnattended') || !manifest?.dir) {
      return { ok: false, error: `this agent's runtime has no attachable session to take over` };
    }
    // The pane is still up → attach to it, no relaunch (identical to a live take-over). Pane, not status:
    // a run that already called `report` still owns its claude, and relaunching over it is the two-claudes
    // outcome — a take-over must claim what is there.
    if (this.reachable(sessionId)) return this.claimSession(sessionId, by);
    // Dead → resurrect the transcript. Needs the pinned claude session id to `--resume` from.
    if (!row.claude_session_id) return { ok: false, error: 'this run has no conversation to resume yet' };
    this.allowResume(sessionId);
    // Mirror claimSession's end-state (headless→0, running, claimed/sticky) but non-resident, so the run
    // is owned by the human and reaped only by the long idle-interactive janitor — never the chat-idle or
    // turn-end reapers. Then actually relaunch claude (unlike the live path, there is a dead pane here).
    this.db.prepare("UPDATE term_sessions SET status = 'running', headless = 0, resident = 0, claimed_by = ?, claimed_at = ?, last_activity = ?, updated_at = ? WHERE id = ?")
      .run(by, Date.now(), Date.now(), Date.now(), sessionId);
    const hasSlack = !!this.db.prepare('SELECT 1 FROM slack_threads WHERE session_id = ?').get(sessionId);
    const hasDiscord = !!this.db.prepare('SELECT 1 FROM discord_threads WHERE session_id = ?').get(sessionId);
    const hasClickup = !!this.db.prepare('SELECT 1 FROM clickup_threads WHERE session_id = ?').get(sessionId);
    const hasTelegram = !!this.db.prepare('SELECT 1 FROM telegram_threads WHERE session_id = ?').get(sessionId);
    this.audit(sessionId, by, 'session.claimed', { agent: row.agent, via: 'takeover-resume' });
    this.launchAgentRuntime({
      id: sessionId, agent: row.agent, task: '', secret: row.secret ?? randomBytes(24).toString('hex'),
      actingMember: row.run_as ?? undefined, spawnedBy: row.spawned_by ?? undefined, hasSlack, hasDiscord, hasClickup, hasTelegram,
      headless: false, resident: false, resume: true, claudeSessionId: row.claude_session_id,
    });
    return { ok: true };
  }

  /**
   * Take a native-console CHAT session over into the Terminal. A chat session is headless per-turn (no
   * persisted launch env, and between turns its pane is gone), so unlike {@link claimSession} we can't
   * always just attach. Two cases:
   *  - a turn is still running → `claimSession` the live pane (zero disruption, attach to the stream);
   *  - idle/dead → resurrect it as an interactive RESIDENT TUI that resumes the SAME transcript with no
   *    seed prompt (drops the human straight into a steerable claude), writes the launch env (so ttyd can
   *    attach + later reattach), and marks it claimed/sticky so the reapers leave it alone.
   * The caller then opens the terminal on `aos-<id>`. Returns an error only for an unknown / non-resumable
   * / non-claude-code session.
   */
  takeoverToTerminal(sessionId: string, by: string): { ok: boolean; error?: string } {
    const row = this.db.prepare('SELECT agent, secret, claude_session_id, run_as, spawned_by FROM term_sessions WHERE id = ?')
      .get<{ agent: string; secret: string | null; claude_session_id: string | null; run_as: string | null; spawned_by: string | null }>(sessionId);
    if (!row) return { ok: false, error: 'unknown session' };
    const manifest = this.os.agents.get(row.agent);
    // Resurrecting a chat as a warm resident TUI needs the resident-chat capability, not just resume.
    if (!runtimeSupports(manifest?.runtime, 'residentChat') || !manifest?.dir) {
      return { ok: false, error: `this agent's runtime does not support resident chat sessions` };
    }
    if (!row.claude_session_id) return { ok: false, error: 'this chat has no conversation to open yet' };
    // The pane is still up → attach to it, no relaunch (see `takeOverSession` — same reasoning).
    if (this.reachable(sessionId)) return this.claimSession(sessionId, by);
    // Idle/dead → resurrect as an interactive resident TUI (resumes the transcript, no seed prompt).
    this.allowResume(sessionId);
    this.db.prepare("UPDATE term_sessions SET status = 'running', headless = 0, resident = 1, claimed_by = ?, claimed_at = ?, last_activity = ?, updated_at = ? WHERE id = ?")
      .run(by, Date.now(), Date.now(), Date.now(), sessionId);
    const hasSlack = !!this.db.prepare('SELECT 1 FROM slack_threads WHERE session_id = ?').get(sessionId);
    const hasDiscord = !!this.db.prepare('SELECT 1 FROM discord_threads WHERE session_id = ?').get(sessionId);
    const hasClickup = !!this.db.prepare('SELECT 1 FROM clickup_threads WHERE session_id = ?').get(sessionId);
    const hasTelegram = !!this.db.prepare('SELECT 1 FROM telegram_threads WHERE session_id = ?').get(sessionId);
    this.audit(sessionId, by, 'session.claimed', { agent: row.agent, via: 'chat-takeover' });
    this.launchAgentRuntime({
      id: sessionId, agent: row.agent, task: '', secret: row.secret ?? randomBytes(24).toString('hex'),
      actingMember: row.run_as ?? undefined, spawnedBy: row.spawned_by ?? undefined, hasSlack, hasDiscord, hasClickup, hasTelegram,
      headless: false, resident: true, resume: true, claudeSessionId: row.claude_session_id,
    });
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
    // One liveness poll for the whole sweep (crash detection + the unattended backstop both need it).
    const alive = this.backend.aliveNames();

    // (0) crash detection on the timer — flip any running row whose pane vanished with no end signal to
    // `crashed` and fire its (always-on) notification NOW, instead of waiting for the next console poll.
    this.sweepCrashed(alive);

    // (0b) …and the inverse. A crash mark is a CLAIM ("the pane is gone"), and unlike a human `stop` it
    // plants no stay-stopped sentinel — deliberately, because a crash should be recoverable. So ttyd's
    // reconnect re-runs `attach.sh`, whose `new-session -A` revives the pane and `claude --resume`s the
    // transcript, and the work simply carries on. Nothing put the ROW back: the only restore path,
    // `restoreRunningAfterDelivery`, is scoped `AND status = 'done'` on purpose. The result is a session
    // that is alive, attached and billing while the console renders it dead, `canResume` refuses it, and
    // the concurrency cap under-counts it. Live insta-ai (2026-08-31): THREE such rows, two with a human
    // attached at that moment, the oldest crash-marked 577 h earlier.
    this.restoreResurrectedCrashes(alive);

    // (1) resident warm-chat idle reap. This is what BOUNDS the warm-pane model: a chat session holds a
    // live claude (hundreds of MB) between turns, so it must give the box back when the conversation
    // goes quiet — the next message revives it in place, resuming the same transcript.
    //   - `status IN ('running','done','crashed')`: a chat turn that ends by calling `report` flips the
    //     row to `done` while its pane keeps running. Reaping only `running` left those panes alive forever
    //     (sweep 3, the interactive janitor, excludes `resident = 1`), which is precisely the leak the
    //     cold-per-turn design never had. `crashed` rides along for the same reason it does in sweeps 2
    //     and 3 — see the note there: the status is terminal, the pane isn't necessarily gone.
    //   - `busy_since`: never reap a turn that is actually generating. A long turn's `last_activity` is
    //     the moment the message was delivered, so a slow one would otherwise be killed mid-answer. The
    //     ceiling keeps that from becoming a way to never reap: a "turn" still running after
    //     MID_TURN_MAX_MS is wedged, not working.
    const midTurnFloor = Date.now() - MID_TURN_MAX_MS;
    const residents = this.db.prepare("SELECT id, tmux, run_as, spawned_by, agent FROM term_sessions WHERE resident = 1 AND status IN ('running','done','crashed') AND COALESCE(last_activity, created_at) < ? AND (busy_since IS NULL OR busy_since < ?)")
      .all<{ id: string; tmux: string; run_as: string | null; spawned_by: string | null; agent: string }>(cutoff, midTurnFloor);
    for (const r of residents) {
      try {
        this.backend.kill(this.spaceFor(r.run_as ?? r.spawned_by), r.tmux);
        this.db.prepare("UPDATE term_sessions SET status = 'stopped', busy_since = NULL, updated_at = ? WHERE id = ?").run(Date.now(), r.id);
        this.cancelPendingQuestions(r.id, 'system');
        this.cancelPendingApprovals(r.id, 'system');
        // A reaped session must stay reaped — otherwise ttyd's reconnect on the still-open tab would
        // resurrect it and defeat the reap. A later Slack reply still revives it (a fresh session), and a
        // deliberate console re-open clears the block.
        this.blockResume(r.id);
        this.audit(r.id, r.agent, 'chat.reaped', { idleMin: timeoutMin });
      } catch { /* one bad row must not stop the sweep */ }
    }

    // (2) DONE-ORPHAN + unattended-straggler backstop — the safety net for markTurnIdle. Two ways a run leaks
    // a live pane:
    //   (a) TERMINAL ORPHAN — an UNATTENDED (chat/automation/task/ask) run that ended via `report`, which flips
    //       the row to 'done' while its interactive TUI pane is still live; such a run has no human owning its
    //       lifecycle, so a terminal row should hold NO pane — reap on sight. `crashed` counts as terminal
    //       here for the same reason (see the note in the loop). This catches an unattended run whose
    //       Stop beacon never landed. **Excluded here: a MEMBER's own console session** (`headless=0`,
    //       `spawned_by` = a bare member id, no `chat:`/`automation:`/`task:`/`ask:` colon). The human opened
    //       that TUI and owns its lifecycle — calling `report` is a status signal, not "kill my terminal" — so
    //       reaping it seconds later yanks a live pane out from under an active user ("my headed session got
    //       killed on its own"). The idle-interactive janitor (sweep 3) reclaims it on the long timeout instead.
    //       Only detectable when we can poll liveness (see below).
    //   (b) IDLE STRAGGLER — an UNATTENDED (`headless=1`) run still 'running' with a turn-end beacon seen
    //       (`last_activity` set) and idle past the timeout: the classic lost-Stop-beacon / attach-then-detach
    //       case. (Interactive stragglers are sweep (3)'s job, on the longer interactive timeout.)
    // `aliveNames()` returns the live tmux set, or NULL when the backend can't report liveness (the Linux
    // LauncherSessionBackend always; a transient local poll failure). When we CAN poll, gate on true pane
    // liveness so a cleanly-reaped row is never re-killed / re-audited on a later tick (a `done` row keeps its
    // status forever once torn down) — this is what lets us sweep 'done' orphans safely. When we CAN'T, fall
    // back to the classic time-based rule for RUNNING rows only (never blind-sweep a 'done' row, or we'd
    // re-teardown it every tick with no way to know its pane already died). Uses the single `alive` poll
    // taken at the top of the sweep.
    // Hard runtime ceiling for a headless run (stuck-mid-turn backstop, Settings → Runtime; default 24h). A
    // headless run that hangs mid-turn never beacons a turn-end, so `last_activity` stays NULL — invisible to
    // the idle-straggler rule below, which requires a beacon. Without this it lingers for DAYS holding a
    // ~500MB claude process + a cap slot (confirmed on globex: unattended runs stuck at 60h+). `0` disables.
    const maxHours = this.os.settings.unattendedMaxHours();
    const maxAgeCutoff = maxHours > 0 ? Date.now() - maxHours * 3600_000 : null;
    // No-progress backstop (fast net for a run that never STARTED — usage-limit / trust-hang / lost prompt).
    // A headless run stuck this way looks identical to the 24h ceiling case (last_activity NULL, never
    // beacons) but should not have to wait a full day: it made ZERO governed tool calls, so once it's older
    // than this short window we know it never got going and reap it. A busy long first turn is EXCLUDED — it
    // fires gate.attempt on its first tool (see hasMadeProgress). Settings → Runtime; default 30m, 0 = off.
    const noProgMin = this.os.settings.unattendedNoProgressMinutes();
    const noProgCutoff = noProgMin > 0 ? Date.now() - noProgMin * 60_000 : null;
    const unattended = this.db.prepare("SELECT id, tmux, run_as, spawned_by, agent, status, headless, last_activity, created_at FROM term_sessions WHERE resident = 0 AND claimed_by IS NULL AND (status IN ('done','crashed') OR (headless = 1 AND status = 'running'))")
      .all<{ id: string; tmux: string; run_as: string | null; spawned_by: string | null; agent: string; status: string; headless: number; last_activity: number | null; created_at: number }>();
    for (const r of unattended) {
      try {
        // TERMINAL = the run is over, whichever way it ended. `crashed` used to be missing from every
        // reaper's query (this one, sweep 1 and sweep 3 alike), and a crashed row is exactly as capable of
        // holding a live pane as a done one: the sweep marks `crashed` when a liveness poll can't see the
        // pane, so a TRANSIENT poll failure — or ttyd's auto-reconnect re-running attach.sh afterwards —
        // leaves a terminal row whose pane is alive and which no query could ever select again. Live
        // stayflexi (2026-08): a `crashed` row holding a pane and ~430MB of `claude` for 93 HOURS.
        const terminal = r.status === 'done' || r.status === 'crashed';
        // A MEMBER's own interactive console session is never a done-orphan: the human owns its lifecycle,
        // so its agent calling `report` (which flips the row to 'done') must not cost it its live pane. Its
        // spawn provenance is a bare member id (no colon), unlike chat:/automation:/task:/ask: runs. Leave it
        // to the idle-interactive janitor (sweep 3); reaping it here yanks the TUI out from under an active
        // user seconds after the agent reports. Unattended-lane done runs fall through and are reaped below.
        if (terminal && !r.headless && r.spawned_by && !r.spawned_by.includes(':')) continue;
        // A headless run past the hard runtime ceiling is reaped on wall-clock age ALONE — no turn-end beacon
        // required (that's the whole point: it's stuck mid-turn). Headed sessions never reach here (the query
        // only pulls headless running rows besides done orphans), so this can't cut a member mid-work.
        const overMaxAge = maxAgeCutoff != null && r.headless === 1 && r.status === 'running' && r.created_at < maxAgeCutoff;
        // A headless run past the short no-progress window that never completed a turn (last_activity NULL)
        // AND never made a governed tool call — it never actually started. Reap fast, like overMaxAge but on a
        // 30-min clock. hasMadeProgress keeps a genuinely-busy long turn (which fires gate.attempt) safe.
        const noProgress = noProgCutoff != null && r.headless === 1 && r.status === 'running'
          && r.last_activity == null && r.created_at < noProgCutoff && !this.hasMadeProgress(r.id);
        const forceReap = overMaxAge || noProgress;
        if (alive) {
          if (!alive.has(r.tmux)) continue;                          // pane already gone — nothing to reap
          // a 'running' straggler is only idle-reaped once it has seen a turn-end beacon AND gone quiet past the
          // cutoff; a 'done' orphan is reaped on sight — it should never still be holding an interactive pane.
          // The hard-age (overMaxAge) and no-progress backstops reap regardless of the beacon.
          if (r.status === 'running' && !forceReap && (r.last_activity == null || r.last_activity >= cutoff)) continue;
        } else {
          // no liveness signal: classic straggler rule, running-only, so we can't re-sweep a done row blind.
          if (r.status !== 'running' || (!forceReap && (r.last_activity == null || r.last_activity >= cutoff))) continue;
        }
        const space = this.spaceFor(r.run_as ?? r.spawned_by);
        if (this.backend.hasClient(space, r.tmux) === true) continue; // a human is still watching — leave it
        // The idle-straggler path keeps a run that's legitimately blocked on a person; but a run past the hard
        // ceiling is abandoned by definition (nobody has answered in a full day), so the backstop reaps it
        // anyway — teardownUnattended cancels its dangling question/approval so nothing is left waiting. A
        // no-progress run CAN legitimately be blocked (it may have called `ask` — an MCP tool, no gate.attempt),
        // so it keeps the block-skip; only overMaxAge overrides it.
        //
        // A `done` ORPHAN is the third override, and the one that leaked. An unattended run whose gate hit
        // the 180s fail-closed deny (or whose `ask` parked) is TOLD to wrap up: it calls `report`, the row
        // flips to 'done' — while the approval/question row stays `pending` forever, because nothing expires
        // an unanswered card. So the block-skip fired on a run whose turn was already OVER, markTurnIdle had
        // already bailed on the same check, and neither force-reap could reach it (both require
        // status='running'). Net effect on live northwind (2026-08): five `done` rows still holding a live
        // tmux pane + ~430MB of `claude` each, the oldest 3 days old, pinned open by cards nobody could
        // deliver an answer to. A finished run cannot consume one — reap it and let teardownUnattended cancel
        // the card, which is what makes it dismissable in the Inbox instead of hanging there.
        if (!overMaxAge && !terminal && this.hasPendingHumanBlock(r.id)) continue;
        this.teardownUnattended(r.id, space, r.tmux, overMaxAge ? 'max-runtime' : noProgress ? 'stuck-no-progress' : r.status === 'crashed' ? 'crashed-orphan' : terminal ? 'done-orphan' : 'idle-backstop');
      } catch { /* one bad row must not stop the sweep */ }
    }

    // (3) idle INTERACTIVE (member) sessions — running, done OR crashed. A member's own attachable session holds a
    // `claude` process too, but — unlike a resident chat (sweep 1) or an unattended run (turn-end / sweep 2) —
    // nothing else reaps it. It's the ONLY reaper for a member's `done` session now that sweep 2 leaves those
    // to the human (a report-ended member run keeps its live TUI so a follow-up still works). A forgotten,
    // detached one lingers for DAYS, wasting RAM and (now that the cap is on) permanently hogging a
    // concurrency-cap slot so scheduled work starves. Reap one idle past the configurable timeout (Settings,
    // default 48 h) with NO client attached and no pending human block; it stays Resumable (a deliberate
    // console re-open clears `blockResume`), so this is a janitor, not a guillotine. Skip claimed take-overs —
    // a human owns that lifecycle. `0` disables. Uses COALESCE(last_activity, created_at): a member session
    // rarely stamps last_activity, so age is the fallback clock.
    //
    // BLOCKED CEILING. "No pending human block" was an unconditional exemption, and that is the same
    // mistake the done-orphan leak was: nothing expires an unanswered card, so a session waiting on one
    // waits FOREVER. Live initech: a `support` session blocked on a question asked 2026-07-31 was
    // still holding its pane 66 h later, with two more questions unanswered since 07-28. Past
    // `blockedMaxHours` (default 72 h — the age at which `escalateStalePrompts` already stops nagging and
    // treats a prompt as dead) the wait is not a wait, it's an abandonment, so reap and cancel the card.
    // Measured from when the OLDEST pending card was RAISED, not from session idleness — "nobody answered
    // this in three days" is the actual claim. Attached sessions are still skipped: someone is right there.
    const idleHours = this.os.settings.interactiveIdleTimeoutHours();
    if (idleHours > 0) {
      const idleCutoff = Date.now() - idleHours * 3600_000;
      const blockedHours = this.os.settings.blockedMaxHours();
      const blockedCutoff = blockedHours > 0 ? Date.now() - blockedHours * 3600_000 : null;
      // CLAIM CEILING. `claimed_by IS NULL` was the third unconditional exemption in this sweep, and it
      // leaked exactly like the other two: claiming hands a session's lifecycle to a human, but nothing
      // ever expires a claim, so someone who takes a session over and closes the tab creates an immortal
      // pane. Live instawp: seven sessions claimed by one member, idle 143–168 h, skipped by the 72 h
      // reaper every tick for a week — until they and their peers filled the concurrency cap and starved
      // every scheduled run on the tenant for a month. The exemption stays; it just gets a ceiling, like
      // `blockedMaxHours` above. `0` restores the old forever-exemption. Someone actually ATTACHED is
      // still never cut (checked below) — that is what "a human owns it" should have meant all along.
      const claimedHours = this.os.settings.claimedMaxHours();
      const claimedCutoff = claimedHours > 0 ? Date.now() - claimedHours * 3600_000 : null;
      // LIFETIME CEILING. Every clock above measures IDLENESS, and `markTurnBusy` stamps `last_activity`
      // on every tool call — so a session whose agent still works never goes idle, however old it gets,
      // and none of them can ever see it. Live instawp after the wake-queue fix: 15 interactive sessions
      // `running` at 1007 h / 266 h / 263 h / 166 h / 120 h, every one reporting 18–24 h idle, skipped on
      // every tick. Age answers what idleness cannot. See `interactiveMaxHours`.
      const lifetimeHours = this.os.settings.interactiveMaxHours();
      const lifetimeCutoff = lifetimeHours > 0 ? Date.now() - lifetimeHours * 3600_000 : null;
      // Widen the scan to the more permissive of the two IDLE clocks, then decide per row — otherwise a
      // claim ceiling SHORTER than the idle timeout would never see its own rows. The lifetime ceiling is
      // ORed in rather than folded into that max: it reads `created_at`, and the rows it exists for are
      // precisely the ones a `last_activity` filter excludes.
      const scanCutoff = claimedCutoff == null ? idleCutoff : Math.max(idleCutoff, claimedCutoff);
      const stale = this.db.prepare("SELECT id, tmux, run_as, spawned_by, agent, status, claimed_by, last_activity, created_at FROM term_sessions WHERE headless = 0 AND resident = 0 AND status IN ('running','done','crashed') AND (COALESCE(last_activity, created_at) < ? OR (? IS NOT NULL AND created_at < ?))")
        .all<{ id: string; tmux: string; run_as: string | null; spawned_by: string | null; agent: string; status: string; claimed_by: string | null; last_activity: number | null; created_at: number }>(scanCutoff, lifetimeCutoff, lifetimeCutoff);
      for (const r of stale) {
        try {
          const idleSince = r.last_activity ?? r.created_at;
          const terminal = r.status === 'done' || r.status === 'crashed'; // see sweep 2 — a crashed row can still hold a pane
          // Claimed: exempt unless the claim itself has gone stale. Unclaimed: the ordinary idle clock —
          // re-checked here because the scan may have been widened past it for the claimed rows.
          // Past the lifetime ceiling every idle-based exemption is moot — that is the point of it.
          const overLifetime = lifetimeCutoff != null && r.created_at < lifetimeCutoff;
          if (r.claimed_by) {
            if (!overLifetime && (claimedCutoff == null || idleSince >= claimedCutoff)) continue;
          } else if (!overLifetime && idleSince >= idleCutoff) {
            continue;
          }
          // A reaped 'running' row flips to 'stopped' and drops out of the query next tick; a 'done' row keeps
          // its status (below), so skip one whose pane is already gone to avoid re-killing / re-auditing it
          // every tick. Only applies when we can poll liveness (local backend); null → fall through as before.
          if (terminal && alive && !alive.has(r.tmux)) continue;
          const space = this.spaceFor(r.run_as ?? r.spawned_by);
          if (this.backend.hasClient(space, r.tmux) === true) continue; // someone's attached — it's in use
          // Blocked on a person: leave it — unless nobody has answered inside the ceiling above, at which
          // point it is abandoned, not waiting.
          let reason = overLifetime ? 'max-lifetime' : r.claimed_by ? 'claimed-abandoned' : 'idle-interactive';
          const blockedAt = this.oldestPendingBlockAt(r.id);
          if (blockedAt !== undefined) {
            // Blocked on a person: leave it — unless nobody answered inside the ceiling, or the session is
            // past its lifetime, at which point it is abandoned rather than waiting.
            if (!overLifetime && (blockedCutoff == null || blockedAt >= blockedCutoff)) continue;
            if (!overLifetime) reason = 'blocked-timeout';
          }
          // Remember the run before killing it. Every OTHER teardown path writes an episode —
          // `markEnded` (normal end, and `teardownUnattended` through it), `markCrashed`, and
          // `stopSession` (the human kill button) — but this janitor did its own teardown and skipped it,
          // so an abandoned interactive session evaporated. Measured over 30 days: 3 of 29 reaped
          // sessions on instapods and 18 of 136 on instawp had an episode, and those came from a `report`
          // earlier in the run, not from the reap.
          //
          // The point is NOT recall value — these take the audit branch (no `report` was ever filed), so
          // they read "Task: … / Outcome: stopped / Activity: 315 governed actions". It is that episodes
          // are what Dreaming and the consolidator READ, and they were seeing only sessions that ended
          // tidily. Every abandoned interactive run — and those carry the fleet's human-initiated work,
          // "How are we doing marketing-wise", "give me the top gainers of the past 10 days" — was
          // invisible to topic extraction. A biased sample is worse than a thin one.
          this.writeEpisode(r.id, r.agent, terminal ? undefined : 'stopped');
          this.backend.kill(space, r.tmux);
          // Preserve a completed session's outcome — only a still-running one becomes 'stopped'.
          this.db.prepare("UPDATE term_sessions SET status = ?, busy_since = NULL, updated_at = ? WHERE id = ?").run(terminal ? r.status : 'stopped', Date.now(), r.id);
          this.cancelPendingQuestions(r.id, 'system');
          this.cancelPendingApprovals(r.id, 'system');
          this.blockResume(r.id); // stay reaped against a ttyd auto-reconnect; a deliberate Resume clears it
          this.audit(r.id, r.agent, 'session.reaped', reason === 'blocked-timeout'
            ? { reason, blockedHours, blockedForMs: Date.now() - (blockedAt as number), status: r.status }
            // Name WHO abandoned it: a claim reaped out from under someone should be traceable to the
            // person who took it over, not read as the janitor closing an ownerless pane.
            : reason === 'claimed-abandoned'
              ? { reason, claimedHours, claimedBy: r.claimed_by, idleForMs: Date.now() - idleSince, status: r.status }
              : { reason, idleHours, status: r.status });
        } catch { /* one bad row must not stop the sweep */ }
      }
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
    const r = this.db.prepare('SELECT tmux, status, headless, resident, claimed_by, run_as, spawned_by, agent, claude_session_id FROM term_sessions WHERE id = ?')
      .get<{ tmux: string; status: string; headless: number; resident: number; claimed_by: string | null; run_as: string | null; spawned_by: string | null; agent: string; claude_session_id: string | null }>(sessionId);
    if (!r) return;
    // A goal-plan run files all its tasks within the turn, so once the turn ends the auto-dispatch flag has
    // done its job — drop it (bounds the in-memory set; a no-op for every non-plan session).
    this.clearPlanAutoDispatch(sessionId);
    // ── The turn is OVER for every lane, whatever happens to the pane below. ──
    // This clear used to live inside the `resident` branch only, which made `busy_since` a ONE-WAY LATCH
    // for every other kind of run: a member's own interactive session returned at `!r.headless` before
    // reaching it, so the flag stamped at spawn was never cleared and the console showed that session as
    // "working" forever (live northwind: 24 of 25 recent rows, `done` and `stopped` ones included, still
    // carried a `busy_since` hours old). A turn that has ended is not busy — the lane only decides what
    // happens to the PANE, never whether the flag is honest.
    this.clearTurnBusy(sessionId);
    if (r.resident) {
      // A RESIDENT (warm chat) run is never torn down here — its whole point is to stay up for the next
      // turn. Stamping `last_activity` is what its idle reaper clocks from.
      if (r.status !== 'running' && r.status !== 'done') return;
      this.db.prepare('UPDATE term_sessions SET last_activity = ?, updated_at = ? WHERE id = ?')
        .run(Date.now(), Date.now(), sessionId);
      this.audit(sessionId, this.sessionAgent(sessionId) ?? '', 'chat.turn.idle', {});
      return;
    }
    if (!r.headless) return;                                           // only unattended, non-resident runs
    if (r.status !== 'running' && r.status !== 'done') return;         // stopped/crashed are already torn down
    // Record the turn-end time regardless of the decision below — it's the idle backstop's clock and the
    // signal that this run has completed at least one turn (so the backstop won't reap a mid-turn run).
    this.db.prepare('UPDATE term_sessions SET last_activity = ? WHERE id = ?').run(Date.now(), sessionId);
    if (r.claimed_by) return;                       // taken over → sticky, the human owns its lifecycle
    if (this.hasPendingHumanBlock(sessionId)) return; // waiting on an answer/approval → keep the pane alive
    // A message was typed in moments ago (a HOLD, a correction, a thread follow-up) — tearing the pane
    // down now would silently swallow it. Give it one grace window to start the turn that reads it.
    if (this.deliveredWithin(sessionId, DELIVERY_GRACE_MS)) return;
    const space = this.spaceFor(r.run_as ?? r.spawned_by);
    const alive = this.backend.aliveNames();
    if (alive && !alive.has(r.tmux)) return;         // pane already gone (already reaped) — nothing to do
    if (this.backend.hasClient(space, r.tmux) === true) return; // a human is watching live → don't close on them
    // BACKGROUND CHILDREN — the turn ended, but the RUN hasn't. An agent that launches a subagent or a
    // `run_in_background` command and then hands the turn back is waiting to be woken by the harness (a
    // `<task-notification>` starts a new turn); tearing down here kills both it and its children mid-work,
    // which is how a run that did everything but the last step lands as "no report". See
    // `src/edge/background-work.ts` for the incident this comes from.
    //   - Only for a run that has NOT reported: `report` flips the row to `done`, and that is the agent
    //     saying it is finished — a stray `tail -f` it forgot to kill must not buy it another 15 minutes.
    //   - Bounded by BACKGROUND_GRACE_MS from the FIRST defer, and audited both ways, so "we waited and it
    //     still didn't finish" is a queryable event and not an immortal pane. A never-ending sleep loop
    //     (the original incident had two) therefore costs one grace window, once.
    if (r.status === 'running') {
      const bg = pendingBackgroundWork(r.claude_session_id ? findTranscript(r.claude_session_id) : undefined);
      if (bg) {
        const firstDefer = this.turnEndDeferred.get(sessionId) ?? Date.now();
        this.turnEndDeferred.set(sessionId, firstDefer);
        const waitedMs = Date.now() - firstDefer;
        if (waitedMs < BACKGROUND_GRACE_MS) {
          this.audit(sessionId, r.agent, 'session.turnend.deferred', { ...bg, waitedMs, graceMs: BACKGROUND_GRACE_MS });
          return;
        }
        this.turnEndDeferred.delete(sessionId);
        this.teardownUnattended(sessionId, space, r.tmux, 'turn-end-grace-expired');
        return;
      }
    }
    this.turnEndDeferred.delete(sessionId);
    this.teardownUnattended(sessionId, space, r.tmux, 'turn-end');
  }

  /**
   * The rest of the Claude Code turn/session state machine (POST /api/session-event, fired by
   * terminal/lifecycle-hook.sh). `Stop` keeps its own beacon — it carries the unattended teardown
   * decision — so this handles the three events that had no home:
   *
   *  - **`UserPromptSubmit`** — a turn is STARTING. Until now `busy_since` was stamped only when the
   *    SERVER delivered a message, so a human typing straight into an attached TUI ran turns the console
   *    could not see. This is the missing half of the flag.
   *  - **`StopFailure`** — the turn ended because the API errored (rate_limit / overloaded / …). Claude
   *    fires NO `Stop` in that case, so without this the turn never ends server-side: the run keeps
   *    reading "working", the pile-up guard stays held, and an unattended run parks as a zombie until a
   *    24h reaper finds it. We end the turn exactly as `Stop` would (`markTurnIdle` → teardown for an
   *    unattended run) and audit WHY.
   *  - **`SessionEnd`** — the run is over, with claude's own `reason`. Only the reasons that really are
   *    the end (`prompt_input_exit` = the human quit the TUI, `logout`, `bypass_permissions_disabled`)
   *    mark the row terminal; `clear` / `resume` / `compact` are mid-run events and must NOT (a `/clear`
   *    is not a finished session). `other` is deliberately not terminal — it's the catch-all, and the
   *    existing pane-liveness sweep already catches a genuinely dead run.
   *
   * Unknown event names are ignored, so a future claude release can add events without breaking this.
   */
  recordLifecycle(sessionId: string, event: string, detail: { reason?: string; errorType?: string } = {}): void {
    if (!this.hasSession(sessionId)) return;
    const agent = this.sessionAgent(sessionId) ?? '';
    if (event === 'UserPromptSubmit') { this.markTurnBusy(sessionId); return; }
    if (event === 'StopFailure') {
      this.audit(sessionId, agent, 'session.turn.failed', { errorType: detail.errorType || 'unknown' });
      this.markTurnIdle(sessionId);       // clears `busy_since` + tears an unattended run down, like Stop
      return;
    }
    if (event === 'SessionEnd') {
      const reason = detail.reason || 'other';
      this.clearTurnBusy(sessionId);      // whatever the reason, no turn is in flight once the session ends
      this.audit(sessionId, agent, 'session.runtime.end', { reason });
      if (reason === 'prompt_input_exit' || reason === 'logout' || reason === 'bypass_permissions_disabled') this.markEnded(sessionId);
      return;
    }
  }

  /**
   * A turn is RUNNING — stamp `busy_since` (the console's "working") and the idle clock with it. Two
   * callers, because a turn announces itself two ways and old sessions only have the second:
   *   - `UserPromptSubmit` (`answered: true`) — the turn's actual start, for sessions launched since the
   *     lifecycle hook shipped;
   *   - the GATE, on every tool call (`answered: false`) — the universal heartbeat. A tool call is proof
   *     a turn is running, and the gate hook is wired into every session that exists, so this is what
   *     keeps an already-running session honest.
   *
   * `busy_since IS NULL` makes it idempotent within a turn: a queued prompt or the 40th tool call must
   * not restart the staleness window, and must certainly not move `last_activity` past `busy_since`,
   * which is how {@link isWorking} recognises a turn that has already ended.
   *
   * The `OR busy_since = created_at` arm PROMOTES the launch-time prediction into an observed turn.
   * `createSession` stamps `busy_since = created_at` on the assumption that the launch seeds a prompt, and
   * that stamp is neither NULL nor stale — so it SHADOWED every signal of the first turn: `UserPromptSubmit`
   * and the first 40 tool calls were all no-ops, and the row looked identical whether the runtime was
   * working hard or had opened on an empty composer and never started. This arm is what makes those two
   * distinguishable (see {@link isWorking} condition 6). It fires at most once per run — the promoted stamp
   * is `now`, never again equal to `created_at` — so mid-turn idempotence is untouched.
   *
   * The `OR busy_since < <stale floor>` arm is what turns the `MID_TURN_MAX_MS` ceiling from a dumb
   * timer into an honest wedged-turn test. A turn that is genuinely still running keeps producing tool
   * calls, so it re-stamps and never ages out; a turn that is wedged produces nothing, so its flag goes
   * stale and {@link isWorking} drops it. Without this arm a real 2h+ turn would silently read `ready`.
   *
   * `answered` says whether a HUMAN produced this signal. Only then is an open "waiting on you" card
   * retired — otherwise a session would keep reading `needs you` (which outranks `working`) through the
   * whole turn it just started. That closes the loop the interrupt case opens: interrupt → idle_prompt
   * card → you type → card gone, spinner back. A tool call is not an answer, so it never clears a card.
   */
  markTurnBusy(sessionId: string, opts: { answered?: boolean } = {}): void {
    const now = Date.now();
    // The gate calls this on EVERY tool call, and `node:sqlite` is synchronous — a write that takes a
    // lock on the gate's hot path is exactly the event-loop blocking that made a busy box feel
    // unresponsive before. The DB statement is already a no-op mid-turn (the WHERE matches nothing), so
    // skip even issuing it when we stamped this session moments ago. `clearTurnBusy` drops the entry, so
    // the first tool call of the NEXT turn always reaches the DB however soon it arrives.
    if (opts.answered === false && now - (this.busyStamped.get(sessionId) ?? 0) < BUSY_STAMP_THROTTLE_MS) return;
    this.busyStamped.set(sessionId, now);
    this.db.prepare('UPDATE term_sessions SET busy_since = ?, last_activity = ?, updated_at = ? WHERE id = ? AND (busy_since IS NULL OR busy_since < ? OR busy_since = created_at)')
      .run(now, now, now, sessionId, now - MID_TURN_MAX_MS);
    if (opts.answered !== false) this.clearNotifications(sessionId);
  }

  /** A turn ENDED — drop `busy_since`. The one place that clears it, so every end path (Stop hook,
   *  StopFailure, SessionEnd, a terminal status transition) agrees. */
  private clearTurnBusy(sessionId: string): void {
    this.db.prepare('UPDATE term_sessions SET busy_since = NULL WHERE id = ? AND busy_since IS NOT NULL').run(sessionId);
    this.busyStamped.delete(sessionId);   // so the next turn's first tool call isn't swallowed by the throttle
  }

  /** Was text delivered into this session within `ms`? Reads the `chat.delivered` / `session.inject`
   *  audit rows the two delivery paths already write, so nothing new is stored. Guards the turn-end
   *  teardown against swallowing a message that arrived a second before the Stop hook fired. */
  private deliveredWithin(sessionId: string, ms: number): boolean {
    const row = this.db
      .prepare("SELECT 1 AS hit FROM audit_events WHERE run_id = ? AND type IN ('chat.delivered','session.inject') AND ts > ? LIMIT 1")
      .get<{ hit: number }>(sessionId, Date.now() - ms);
    return !!row;
  }

  /** Close a finished unattended run: snapshot its pane for the console transcript view, mark it done
   *  (blocks resurrection + writes the episode), then kill the pane so tmux drops and the pile-up guard
   *  releases. Shared by the Stop-hook fast path and the idle backstop. */
  private teardownUnattended(sessionId: string, space: string, tmux: string, reason: string): void {
    this.turnEndDeferred.delete(sessionId); // this run is over however it got here — don't leak the clock
    this.captureTranscript(sessionId, space, tmux);
    // Before killing the pane, check whether this run died on a usage-limit refusal; if so park the account
    // it used so the next launch rotates away from it (rotation's detection point).
    this.detectUsageLimit(sessionId, space, tmux);
    this.markEnded(sessionId);   // status → done (if still running), blockResume, writeEpisode
    // Release any dangling human-block so nothing is left waiting on a reaped run. A no-op for the
    // idle-backstop/turn-end paths (they skip a blocked run upstream), but essential for the hard
    // max-runtime backstop, which reaps an abandoned run that IS still blocked on a person.
    this.cancelPendingQuestions(sessionId, 'system');
    this.cancelPendingApprovals(sessionId, 'system');
    this.backend.kill(space, tmux);
    this.audit(sessionId, 'system', 'session.reaped', { reason });
  }

  /**
   * Put back a `crashed` row whose pane is demonstrably alive AND in use — the crash claim has been
   * falsified by evidence, exactly as {@link restoreRunningAfterDelivery} does for a `done` row that kept
   * running. Two independent proofs, either sufficient:
   *   · a client is ATTACHED — someone is looking at it right now;
   *   · `last_activity` is NEWER than `updated_at`, which `markCrashed` stamps at the moment of the mark —
   *     i.e. the session has done governed work SINCE being declared dead.
   * Both are needed: a member's interactive session rarely stamps `last_activity` (so attachment covers
   * it), and a detached-but-working run has no client (so the activity clock covers it).
   *
   * This deliberately does NOT fight the crashed-orphan reap added alongside it. A genuinely abandoned
   * crashed pane satisfies neither proof, stays `crashed`, and is reaped on sight; only a resurrected one
   * is restored, and it then lives or dies by the ordinary idle clock like any other running session.
   * Requires a real liveness poll — with none we can falsify nothing, so we leave every row alone.
   *
   * What it does NOT undo: the questions/approvals `markCrashed` cancelled stay cancelled (someone may
   * have acted on that), and the episode stays written. Only the row's status, the stale "Crashed" inbox
   * card, and the audit trail are corrected.
   */
  private restoreResurrectedCrashes(alive: Set<string> | null): void {
    if (!alive) return; // no liveness signal — nothing can be falsified
    const rows = this.db.prepare("SELECT id, tmux, agent, run_as, spawned_by, last_activity, updated_at FROM term_sessions WHERE status = 'crashed'")
      .all<{ id: string; tmux: string; agent: string; run_as: string | null; spawned_by: string | null; last_activity: number | null; updated_at: number }>();
    for (const r of rows) {
      try {
        if (!alive.has(r.tmux)) continue;                       // pane really is gone — the mark was right
        const attached = this.backend.hasClient(this.spaceFor(r.run_as ?? r.spawned_by), r.tmux) === true;
        const workedSince = r.last_activity != null && r.last_activity > r.updated_at;
        if (!attached && !workedSince) continue;
        const restored = this.db.prepare("UPDATE term_sessions SET status = 'running', updated_at = ? WHERE id = ? AND status = 'crashed'")
          .run(Date.now(), r.id);
        if (!restored.changes) continue;                        // raced with another writer — leave it be
        // The "Crashed — <agent>" card is now a lie about a live session; close it rather than leave the
        // owner's Inbox asserting a death that didn't stick.
        this.db.prepare("UPDATE messages SET status = 'resolved' WHERE session_id = ? AND type = 'completed' AND outcome = 'crashed' AND status = 'open'")
          .run(r.id);
        this.audit(r.id, r.agent, 'session.restored', { from: 'crashed', via: attached ? 'attached' : 'activity' });
      } catch { /* one bad row must not stop the sweep */ }
    }
  }

  /** Is this session blocked on a human right now (a pending question OR a pending approval)? Used to
   *  keep an unattended run's pane alive while it legitimately waits, instead of reaping mid-`ask`. */
  private hasPendingHumanBlock(sessionId: string): boolean {
    const q = this.db.prepare("SELECT 1 FROM questions WHERE run_id = ? AND status = 'pending' LIMIT 1").get(sessionId);
    if (q) return true;
    return this.os.approvals.pending(this.os.tenant).some((a) => a.runId === sessionId);
  }

  /** WHEN this session started waiting on a person — the creation time of its OLDEST still-pending question
   *  or approval, or undefined when it isn't blocked. The clock for the blocked ceiling (sweep 3): what
   *  matters is how long the CARD has gone unanswered, not how long the session has been quiet. */
  private oldestPendingBlockAt(sessionId: string): number | undefined {
    const q = this.db.prepare("SELECT MIN(created_at) AS at FROM questions WHERE run_id = ? AND status = 'pending'")
      .get<{ at: number | null }>(sessionId)?.at ?? undefined;
    const a = this.os.approvals.pending(this.os.tenant)
      .filter((x) => x.runId === sessionId)
      .reduce<number | undefined>((min, x) => (min === undefined || x.createdAt < min ? x.createdAt : min), undefined);
    if (q === undefined) return a;
    if (a === undefined) return q;
    return Math.min(q, a);
  }

  /** Has this run made any real PROGRESS — i.e. attempted at least one governed tool call (a `gate.attempt`
   *  audit event)? The no-progress backstop (sweep 2) uses this to tell a run that never STARTED (usage-limit
   *  refusal / trust-hang / lost prompt → zero tools) apart from a genuinely-busy long first turn (which fires
   *  gate.attempt on its first Bash/tool). Best-effort: if the audit table can't be read (demo `:memory:` db
   *  with no sink, a transient error), return TRUE so a read failure can never trigger a mass reap. Note: a
   *  hypothetical MCP-only run that does real work via un-gated loopback tools would read as no-progress, but
   *  such a run either completes its turn (stamps last_activity → excluded) or is blocked on `ask` (excluded
   *  by hasPendingHumanBlock) — so the 30-min window makes a false reap vanishingly unlikely. */
  private hasMadeProgress(sessionId: string): boolean {
    try {
      const row = this.db.prepare("SELECT 1 FROM audit_events WHERE run_id = ? AND type = 'gate.attempt' LIMIT 1").get(sessionId);
      return !!row;
    } catch {
      return true; // can't tell → assume progress; never let a read error reap live runs
    }
  }

  /** Point a claude-code session at a TENANT-OWNED config dir instead of the box owner's `~/.claude`, so
   *  their user-scope settings — above all `enabledPlugins`, which drags in a plugin's subagents, skills
   *  and SessionStart prompt hooks — stop applying to governed runs. See src/edge/config-isolation.ts for
   *  what is carried across (credentials + transcripts, by symlink) and why.
   *
   *  Called AFTER applyRuntimeAccount so ROTATION WINS: a pooled account IS a config dir, already isolated
   *  and holding its own credentials, and overwriting it would launch the run on the wrong account.
   *
   *  Behind `AOS_CLAUDE_CONFIG_ISOLATION=1` while it proves out on one tenant — a mistake here hangs every
   *  unattended run on the box (the failure mode the trust-dialog and rotation bugs both took), so the
   *  default stays off. Off, or unable to set up safely, the session launches on the box config unchanged. */
  private applyConfigIsolation(env: Record<string, string>, sessionId: string, agent: string, runtime: CodingRuntimeId): void {
    if (process.env.AOS_CLAUDE_CONFIG_ISOLATION !== '1') return;
    if (runtime !== 'claude-code') return;               // codex reads a different config dir (CODEX_HOME)
    if (env.CLAUDE_CONFIG_DIR) return;                   // rotation already picked a credential dir
    if (!this.os.paths) return;
    const r = isolateClaudeConfig(this.os.paths.home);
    if (!r.isolated) { this.audit(sessionId, agent, 'claude.config.isolation.skipped', { reason: r.reason }); return; }
    env.CLAUDE_CONFIG_DIR = r.dir;
    // `detached` credentials / `own` projects are the two ways this degrades silently — a divergent token
    // and transcripts the console can't resolve. Both are visible in the audit rather than inferred later.
    this.audit(sessionId, agent, 'claude.config.isolated', { dir: r.dir, credentials: r.credentials, projects: r.projects });
  }

  /** Wall-clock of the last keychain-locked alert, so a locked box pings the owner once rather than once
   *  per spawn. In-memory on purpose: a restart re-alerting is the correct behaviour, since a restart is
   *  also the moment an operator is most likely to believe the box was fixed. */
  private lastCredentialAlertAt = 0;
  private static readonly CREDENTIAL_ALERT_COOLDOWN_MS = 30 * 60_000;

  /** Launch pre-flight for the run's credentials. True = proceed. False = the launch was REFUSED and the
   *  session has already been marked crashed and explained to its owner; the caller must return.
   *
   *  Fails CLOSED, unlike every other credential path here, because the alternative isn't a degraded run —
   *  it's a run that cannot authenticate at all. Falling through to the box default (the fail-open move
   *  everywhere else) does not help either: on macOS the box default reads through the SAME locked
   *  keychain. */
  private assertCredentialsUsable(env: Record<string, string>, o: { id: string; agent: string }, runtime: CodingRuntimeId): boolean {
    let blocked: { dir: string; service: string } | null = null;
    try { blocked = preflightCredential(runtime, env); }
    catch { return true; }                              // a probe that can't run must never block a launch
    if (!blocked) return true;
    this.refuseForLockedCredential(o.id, o.agent, runtime, blocked.dir, blocked.service);
    return false;
  }

  /**
   * The same question, asked by the RESUME path instead of the launch path.
   *
   * A resurrection does not go through `launch()` at all: `attach.sh` re-execs `claude-launch.sh` with
   * `RESUME=1`, which sources the persisted env file and starts claude directly — pure shell, no server
   * decision in the middle. So the launch pre-flight cannot see it, and on 2026-09-02 a session
   * resurrected that way came up `Not logged in` and burned a turn 34 minutes after the operator believed
   * the box was fixed. The launcher now asks HERE, over the same loopback + session-secret channel it
   * already uses for `/api/ended` and `/api/resumed`, so detection stays in one implementation rather
   * than being re-written in bash.
   *
   * `configDir` is whatever the resumed environment carries (empty → the box default). Returns the
   * blocking condition, having already recorded it, or null to proceed.
   */
  checkResumeCredentials(sessionId: string, configDir: string, runtime: CodingRuntimeId = 'claude-code'): { reason: 'keychain_locked'; dir: string; message: string } | null {
    const agent = this.sessionAgent(sessionId) ?? 'system';
    let blocked: { dir: string; service: string } | null = null;
    try { blocked = preflightCredential(runtime, configDir ? { [CODING_RUNTIMES[runtime].credentialEnv.configDirVar]: configDir } : {}); }
    catch { return null; }
    if (!blocked) return null;
    this.refuseForLockedCredential(sessionId, agent, runtime, blocked.dir, blocked.service);
    return { reason: 'keychain_locked', dir: blocked.dir, message: TerminalManager.lockedCredentialWhy(runtime, blocked.dir) };
  }

  private static lockedCredentialWhy(runtime: CodingRuntimeId, dir: string): string {
    return `the macOS login keychain is locked, so ${CODING_RUNTIMES[runtime].label} cannot read the credential for ${dir} — this run would start, authenticate as nobody and end with no work done`;
  }

  /** Record a refused run: audit, crash the row, tell its owner, badge the pool account, alert admins.
   *  Shared by the launch and resume pre-flights so the two can never disagree about what a refusal is. */
  private refuseForLockedCredential(sessionId: string, agent: string, runtime: CodingRuntimeId, dir: string, service: string): void {
    const why = TerminalManager.lockedCredentialWhy(runtime, dir);
    this.audit(sessionId, agent, 'session.launch.refused', { runtime, reason: 'credential unreadable: keychain locked', dir, service });
    this.db.prepare("UPDATE term_sessions SET status = 'crashed', busy_since = NULL, updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
    this.addMessage({ type: 'completed', sessionId, agent, title: `Could not start — ${agent}`, body: `Did not launch: ${why}.`, status: 'open', outcome: 'crashed', audienceKind: 'sessionOwner', audienceId: sessionId });
    // Badge the pool row this dir belongs to, so Settings → Runtime shows the cause where an operator
    // would go looking for it rather than only in one session's card.
    try {
      const acct = this.os.runtimeAccounts.list().find((a) => a.runtime === runtime && a.configDir === dir);
      if (acct) this.os.runtimeAccounts.recordCheck(runtime, acct.name, { ok: false, note: 'macOS login keychain is locked — the credential cannot be read from this security session' });
    } catch { /* badging is a nicety */ }
    this.alertCredentialsLocked(dir);
  }

  /** Tell a human, once per cooldown. This is the half the 2026-09-01 incident was missing: the refusal
   *  above makes each run honest, but nothing about a crashed session reaches someone who is not looking. */
  private alertCredentialsLocked(dir: string): void {
    const now = Date.now();
    if (now - this.lastCredentialAlertAt < TerminalManager.CREDENTIAL_ALERT_COOLDOWN_MS) return;
    this.lastCredentialAlertAt = now;
    try {
      this.postSystemCard({
        topic: 'credentials-locked',
        type: 'notification',
        title: 'Agent runs are blocked — the macOS login keychain is locked',
        body: `Claude Code stores this box's logins in the macOS Keychain, and its value cannot be read right now, so no session can authenticate (${dir}). Runs are being refused rather than started and left to fail silently. Unlock it on the box itself:\n\n    security unlock-keychain ~/Library/Keychains/login.keychain-db\n\nThen re-run the check from Settings → Runtime → Runtime accounts.`,
        audience: { kind: 'admins' },
      });
    } catch { /* the audit line above is the durable record */ }
  }

  /** Select a rotation-pool account for this runtime and point the session's credentials at it, via the
   *  runtime's own env vars (`CODING_RUNTIMES[runtime].credentialEnv`). Records which account the run used
   *  (`term_sessions.runtime_account`) so limit detection at teardown can park the right one. No-op — leaving
   *  the box's default credentials in place — when the pool is empty or exhausted, or when the selected
   *  account's credential can't be resolved (fail-open: better to launch on the default than not at all).
   *
   *  `runtime_account` is stamped ONLY once the credential has actually been put in the environment in a
   *  form the runtime honours. It is read back as ground truth (teardown parks the limited account; the
   *  console shows which account a run burned), so a stamp for a credential that silently didn't apply is
   *  worse than no stamp: it hides the box default being drained and sends limit-parking to the wrong row. */
  private applyRuntimeAccount(env: Record<string, string>, sessionId: string, agent: string, runtime: CodingRuntimeId, resident: boolean): void {
    try {
      // `pick` already restricts to the kinds this runtime's launch lane authenticates with
      // (`liveCredentialKinds`). A RESIDENT session narrows further: kept warm for hours/days (a
      // Discord/Slack chat), it outlives the access window of a static injected `token`, which carries no
      // refresh token into the process — claude can't renew it in place and hits "OAuth access token has
      // expired" → /login mid-chat. Credential dirs refresh themselves, and an api key doesn't expire.
      const acct = this.os.runtimeAccounts.pick(runtime, Date.now(), resident ? { kinds: ['oauth', 'apikey'] } : undefined);
      if (!acct) {
        // Distinguish "no pool" (inert by design, silent) from "a pool exists but nothing in it is usable
        // here" — the latter looks like working rotation in the console while every run quietly lands on the
        // box account, which is exactly the failure this audit line exists to make visible.
        if (this.os.runtimeAccounts.enabledCount(runtime, { anyKind: true }) > 0 && this.os.runtimeAccounts.enabledCount(runtime) === 0) {
          this.audit(sessionId, agent, 'runtime.account.unusable', { runtime, resident, kinds: CODING_RUNTIMES[runtime].liveCredentialKinds, reason: 'no enabled account of a kind this runtime can launch with — using the box default' });
        }
        return;
      }
      const resolved = this.credentialEnvFor(acct, runtime, sessionId, agent);
      if (!resolved) return;
      Object.assign(env, resolved.vars);
      this.db.prepare('UPDATE term_sessions SET runtime_account = ? WHERE id = ?').run(acct.name, sessionId);
      this.audit(sessionId, agent, 'runtime.account.selected', { runtime, account: acct.name, kind: acct.kind, via: resolved.varName });
    } catch { /* rotation must never break a launch — fall through to the box default */ }
  }

  /** Turn a selected pool account into the env vars that authenticate a launch under it, or null when it
   *  can't be resolved (audited). Shared by the launch path and the rotate-on-reload path so the two can
   *  never disagree about which var carries which kind. */
  private credentialEnvFor(acct: RuntimeAccount, runtime: CodingRuntimeId, sessionId: string, agent: string): { vars: Record<string, string>; varName: string } | null {
    const { configDirVar, apiKeyVar, tokenVar } = CODING_RUNTIMES[runtime].credentialEnv;
    if (acct.kind === 'oauth') {
      // Require the credential FILE, not just the path: an empty/never-logged-in dir doesn't fall back to
      // the box login, it drops the session onto the CLI's interactive login picker, where it hangs until
      // the reaper. Falling through to the box default is the strictly better failure.
      if (!acct.configDir || !credentialDirHasLogin(runtime, acct.configDir)) {
        this.audit(sessionId, agent, 'runtime.account.unresolved', { runtime, account: acct.name, kind: acct.kind, dir: acct.configDir ?? null, reason: 'no readable .credentials.json in the credential dir' });
        return null;
      }
      // A dir we're about to run under is a dir whose `projects/` will hold this run's transcript.
      registerTranscriptRoot(acct.configDir);
      return { vars: { [configDirVar]: acct.configDir }, varName: configDirVar };
    }
    // apikey | token: the value lives in the vault; the KIND picks which env var carries it (a usage-billed
    // API key vs. a long-lived OAuth token). A runtime that has no tokenVar can't honour a token account.
    const varName = acct.kind === 'token' ? tokenVar : apiKeyVar;
    const value = varName && acct.apiKeyRef ? this.os.secrets.getSync(this.os.tenant, agent, acct.apiKeyRef) : undefined;
    if (!varName || !value) {
      this.audit(sessionId, agent, 'runtime.account.unresolved', { runtime, account: acct.name, kind: acct.kind, ref: acct.apiKeyRef, var: varName ?? null });
      return null;
    }
    return { vars: { [varName]: value }, varName };
  }

  /**
   * Credential env for an OUT-OF-BAND runtime call that belongs to no session — today, the session
   * summarizer's throwaway `claude -p`.
   *
   * It exists because that call used to run on `{...process.env}`, i.e. always the BOX DEFAULT account,
   * while every governed launch goes through {@link applyRuntimeAccount} and rotates off an exhausted
   * one. On live instawp that split silently degraded the summarizer for three weeks: `runtime.usage_limited`
   * ran 2026-07-30 → 08-15 and `runtime.account.limited` from 08-04, and across exactly that band 43 of
   * 97 `session.summarized` events came back `via:'fallback'` — sessions kept working on rotated
   * accounts while the summarizer kept calling the limited default and quietly returned the
   * deterministic recap instead. `pick()` already skips a limited account, so routing this through the
   * same pool is the whole fix.
   *
   * Fail-open like the launch path: no pool, nothing usable, or an unresolvable credential → null, and
   * the caller runs on the box default exactly as before. Audited under a synthetic run id so a pool
   * that can't serve this call is visible rather than inferred from a fallback rate.
   */
  outOfBandCredentialEnv(runtime: CodingRuntimeId = 'claude-code'): { vars: Record<string, string>; account: string } | null {
    try {
      // `pick` already restricts to the runtime's `liveCredentialKinds` and can only be narrowed, never
      // widened — for claude-code that is `['oauth']`, i.e. the same credential DIRS the TUI lane rotates
      // through, which is exactly what we want here. The extra narrowing drops a static `token` on
      // runtimes that do accept one: it carries no refresh token, and a summarizer that trips "OAuth
      // access token has expired" is the same silent degradation this method exists to end.
      const acct = this.os.runtimeAccounts.pick(runtime, Date.now(), { kinds: ['oauth', 'apikey'] });
      if (!acct) return null;
      const resolved = this.credentialEnvFor(acct, runtime, '-', 'summarizer');
      if (!resolved) return null;
      return { vars: resolved.vars, account: acct.name };
    } catch {
      return null; // rotation must never break an out-of-band call — fall through to the box default
    }
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

  // Signature of a usage-limit refusal in a session's pane, and the reset-time parse. Covers the shapes the
  // CLIs print — claude: "you've hit your weekly limit", "usage limit reached", "resets Jul 30, 10am (UTC)";
  // a generic "rate limit" catch covers codex / future runtimes. Best-effort text scan, no API dependency.
  private static readonly USAGE_LIMIT_RE = /\b(weekly limit|usage limit|rate limit|hit your .{0,20}limit|limit reached|out of (?:usage|credits))\b/i;

  // Signature of a CREDENTIAL rejection (as opposed to a usage limit): the CLI got a 401 / bad-token banner,
  // meaning the injected account's token is invalid/revoked/expired and will NOT self-heal at a reset. These
  // phrases are the runtime's own auth-failure banners — specific enough not to trip on ordinary output.
  private static readonly AUTH_FAIL_RE = /\b(invalid bearer token|oauth token (?:has )?expired|invalid api key|failed to authenticate)\b/i;

  /** How this unattended run ended, credentials-wise — scanned from the final pane. Two distinct outcomes for
   *  a rotation-pool account:
   *   • usage-limit refusal → the token is fine but EXHAUSTED: park it `limited` until reset (self-heals,
   *     next launch rotates on), with a 1 h fallback when the reset can't be parsed.
   *   • auth failure (401 / invalid-bearer) → the token is BAD: DISABLE the account (it won't recover at a
   *     reset) so it drops out of the pool until a human replaces it — the launch-time backstop to add-time
   *     validation, for a token that was good when added but got revoked/expired since.
   *  No pool account (box default) → nothing to rotate; still audited so the box's own limit state is visible.
   *  Best-effort — never throws, never blocks teardown. */
  private detectUsageLimit(sessionId: string, space: string, tmux: string): void {
    try {
      const row = this.db.prepare('SELECT agent, runtime_account FROM term_sessions WHERE id = ?')
        .get<{ agent: string; runtime_account: string | null }>(sessionId);
      if (!row) return;
      // The pane is the fast path, but it is VOLATILE — a run killed on its first API call has usually
      // already lost its pane by teardown, and `capturePane` then returns nothing. Measured on the live
      // corpus: of 31 runs the derived outcome identifies as quota/auth deaths (from the
      // transcript, which is durable), this detector had fired on **3**, and the pool recorded ZERO
      // `runtime.account.limited` / `.invalid` events in 30 days. So the remediation machinery below was
      // right and simply wasn't being reached. Fall back to the transcript tail, which says the same thing
      // and outlives the pane. See docs/insights-revisit.md Step 2.
      let text = this.backend.capturePane(space, tmux);
      let via = 'pane';
      if (!text || !(TerminalManager.USAGE_LIMIT_RE.test(text) || TerminalManager.AUTH_FAIL_RE.test(text))) {
        const claudeId = this.db.prepare('SELECT claude_session_id FROM term_sessions WHERE id = ?')
          .get<{ claude_session_id: string | null }>(sessionId)?.claude_session_id;
        const end = claudeId ? readTranscriptEnd(claudeId) : undefined;
        if (end?.died) {
          // Hand the classifier the phrase it expects rather than re-deriving here, so the two sources
          // can never disagree about what counts as a limit vs a bad token.
          text = end.deathKind === 'auth' ? 'oauth token expired' : 'hit your weekly limit';
          via = 'transcript';
        }
      }
      if (!text) return;
      const usageLimited = TerminalManager.USAGE_LIMIT_RE.test(text);
      // A usage-limit banner is checked first — it's the benign, self-healing case; an auth failure is only
      // acted on when there's no usage-limit signature, so an exhausted-but-valid token is never disabled.
      const authFailed = !usageLimited && TerminalManager.AUTH_FAIL_RE.test(text);
      if (!usageLimited && !authFailed) return;
      const manifest = this.os.agents.get(row.agent);
      const runtime: CodingRuntimeId = isCodingRuntime(manifest?.runtime) ? manifest!.runtime : 'claude-code';
      if (authFailed) {
        if (row.runtime_account) {
          this.os.runtimeAccounts.markInvalid(runtime, row.runtime_account, 'auto-disabled: a run authenticated with this token and was rejected (401)');
          this.audit(sessionId, 'system', 'runtime.account.invalid', { runtime, account: row.runtime_account, via });
        } else {
          this.audit(sessionId, 'system', 'runtime.auth_failed', { runtime, via });
        }
        return;
      }
      const until = this.parseLimitReset(text) ?? Date.now() + 60 * 60_000; // 1h fallback keeps it parked but self-heals
      if (row.runtime_account) {
        this.os.runtimeAccounts.markLimited(runtime, row.runtime_account, until);
        this.audit(sessionId, 'system', 'runtime.account.limited', { runtime, account: row.runtime_account, until, via });
      } else {
        // No pool account → the box's single default hit its limit; surface it (an operator adds accounts to rotate).
        this.audit(sessionId, 'system', 'runtime.usage_limited', { runtime, until, via });
      }
    } catch { /* detection is best-effort — never block teardown */ }
  }

  /** Best-effort parse of a reset time from a limit message ("resets Jul 30, 10am (UTC)" / "resets 3:10pm").
   *  Returns epoch ms, or null when nothing parseable is found (caller applies a fallback). Timezone-naive
   *  parses are fine — a slightly-off reset just means one extra retry, which re-parks the account. */
  private parseLimitReset(text: string): number | null {
    const m = /\bresets?\b[^.\n]*/i.exec(text);
    if (!m) return null;
    // Pull a date-ish or time-ish fragment out of the "resets …" clause and let Date parse it.
    const frag = m[0].replace(/^resets?\s*/i, '').replace(/\(([^)]*)\)/, '$1').trim();
    const t = Date.parse(frag);
    return Number.isFinite(t) ? t : null;
  }

  /** `{ AOS_URL, SESSION, AGENT, TASK_B64, AOS_SECRET }` — the base env every runner/launcher inherits. */
  private sessionEnv(id: string, agent: string, task: string, secret: string): Record<string, string> {
    const env: Record<string, string> = {
      AOS_URL: this.baseUrl,
      // The tenant's REAL external origin (FQDN/Tailscale), for human-facing deep-links agents emit.
      // AOS_URL above is the loopback base the tools call the API on — never show it to a human. Falls
      // back to the loopback base when no public origin is configured (dev/demo), so a link still forms.
      AOS_PUBLIC_URL: this.publicOrigin || this.baseUrl,
      // A human-facing deep-link back to THIS session's console page (the tmux is `aos-<id>`, which is the
      // sessions route's detail segment). Handed to agents so a PR/report/artifact can point a reviewer at
      // the run that produced it — the traceability spine from an external artifact back into the audited OS.
      AOS_SESSION_URL: `${this.publicOrigin || this.baseUrl}/#/sessions/aos-${id}`,
      AOS_TENANT: this.os.tenant, // routes loopback agent calls to THIS tenant's runtime (multi-tenant)
      SESSION: id,
      AGENT: agent,
      TASK_B64: Buffer.from(task, 'utf8').toString('base64'),
      AOS_SECRET: secret,
      // The `agent-browser` skill starts a persistent headless-Chrome daemon that double-forks to init and
      // so escapes the session's tmux process group — `tmux kill-session` at teardown can't reach it, and
      // it (plus its swiftshader Chrome, which burns CPU) survives for days until reboot/OOM. Two env knobs
      // let the SESSION clean up after ITSELF (root cause) instead of a process-scanning GC:
      //  • NAMESPACE per session isolates its daemon + socket + saved state, so the launcher's exit trap
      //    (`agent-browser close --all`, terminal/claude-launch.sh) shuts down THIS session's browser on
      //    any trappable exit — including the SIGHUP `tmux kill-session` sends — without touching another
      //    live session's browser.
      //  • IDLE_TIMEOUT is the last-resort net for the ONE exit the trap can't catch: an un-trappable
      //    SIGKILL (OOM). The daemon self-exits after this many ms with no commands. Operator-overridable;
      //    5 min is long enough not to interrupt a multi-step browse (LLM think-time between commands).
      AGENT_BROWSER_NAMESPACE: `aos-${id}`,
      AGENT_BROWSER_IDLE_TIMEOUT_MS: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS || '300000',
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

  /** Sessions whose filed tasks should auto-dispatch (a goal plan run the requester chose to auto-run).
   *  In-memory + short-lived: a plan session files its tasks within one run, so this needn't survive a
   *  restart — if the server bounces mid-plan the remaining tasks are simply filed file-only (safe
   *  degradation, never an accidental dispatch). Set by Strategist.plan, read by /api/tasks/create. */
  private planAutoDispatchSessions = new Set<string>();
  markPlanAutoDispatch(id: string): void { this.planAutoDispatchSessions.add(id); }
  isPlanAutoDispatch(id: string): boolean { return this.planAutoDispatchSessions.has(id); }
  clearPlanAutoDispatch(id: string): void { this.planAutoDispatchSessions.delete(id); }

  /** The member id a session acts as (run-as), if any — so a deferred task it schedules runs as the
   *  same identity. NULL for company-identity runs. */
  sessionRunAs(id: string): string | undefined {
    return this.db.prepare('SELECT run_as FROM term_sessions WHERE id = ?').get<{ run_as: string | null }>(id)?.run_as ?? undefined;
  }

  /** The runtime transcript id for a session — so a self-scheduled follow-up can resume this same
   *  conversation (context continuity) instead of starting fresh.
   *
   *  NOTE ON THE COLUMN NAME: `claude_session_id` predates multi-runtime support and now holds the
   *  transcript id for WHICHEVER runtime drove the run — Claude Code's pinned `--session-id` or the
   *  Codex rollout UUID captured via `/api/runtime-session`. Both are consumed the same way (resume /
   *  fork by id), so the column is generic in meaning if not in name; it is left un-renamed on purpose
   *  to avoid a migration + ~25-callsite churn for zero behavioural gain. */
  sessionClaudeId(id: string): string | undefined {
    return this.db.prepare('SELECT claude_session_id FROM term_sessions WHERE id = ?').get<{ claude_session_id: string | null }>(id)?.claude_session_id ?? undefined;
  }

  /**
   * Record a runtime-minted transcript id (Codex). FIRST WRITE WINS: once a session has an id, a later
   * report is ignored, so a resumed run can't silently re-point an existing conversation at a different
   * transcript (which would strand the original and break `resume`/`fork`). Returns whether it stored.
   */
  recordRuntimeSessionId(sessionId: string, runtimeSessionId: string): boolean {
    const id = runtimeSessionId.trim();
    // Codex rollout ids are UUIDs; reject anything else so a malformed scrape can't poison the column.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
    const row = this.db.prepare('SELECT agent, claude_session_id FROM term_sessions WHERE id = ?')
      .get<{ agent: string; claude_session_id: string | null }>(sessionId);
    if (!row || row.claude_session_id) return false;
    this.db.prepare('UPDATE term_sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?')
      .run(id, Date.now(), sessionId);
    this.audit(sessionId, row.agent, 'session.runtime_id', { runtimeSessionId: id });
    return true;
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

  /** How much of a task is used as the retrieval query. A cron/standing-order task can be 2KB of
   *  procedure; feeding all of it to a semantic search returns the fleet's most generic memories,
   *  because the distinctive words are buried under boilerplate. The first sentences carry the subject. */
  private static readonly PRELOAD_QUERY_MAX = 400;
  /** Over-fetch factor for the preamble. Episodes are filtered out AFTER retrieval (no backend expresses
   *  "exclude this tag" — automem's tag_mode is `all`), so ask for more than we need and keep the first
   *  `count` that survive. */
  private static readonly PRELOAD_OVERFETCH = 4;
  /** A launch must never wait on the memory store. Past this, fall back to the local ranking and go. */
  private static readonly PRELOAD_TIMEOUT_MS = 2_500;

  /**
   * The launch-time memory preamble (Settings → Memory `preload`, off by default): seed a cold session
   * with what this agent already knows, instead of relying on it to call `recall` itself.
   *
   * Ranked **against this session's task** when there is one. The first version of this ordered by
   * `importance DESC, last_recalled_at DESC` with no query at all — the same 8 memories on every launch
   * regardless of the work. On live instapods that put "Never auto-send email as the marketing agent"
   * (importance 0.95, tenant-shared) at the top of the ENGINEER's prompt, and spent two of eight slots on
   * marketing copy rules; below the top ~70 rows the order was decided almost entirely by the tiebreaker,
   * since 893 memories share importance 0.8 and 912 share 0.7. A head start that ignores the task is a
   * weak one.
   *
   * Now the task text (first `PRELOAD_QUERY_MAX` chars — see the constant) is the recall query, through
   * the real provider, so the backend's own ranking picks the memories that bear on THIS work. Going
   * through the provider also means the hits are reinforced (`recall_count`/`last_recalled_at`), so
   * preloaded memories participate in the usage signal that prune and re-ranking read, rather than being
   * invisible to it.
   *
   * Falls back to the old importance ordering whenever the task-ranked path can't answer — no task text
   * (a bare interactive session), a recall that throws, times out, or returns nothing. So the preamble is
   * never worse than it was, and a slow or unreachable backend costs a launch at most PRELOAD_TIMEOUT_MS.
   *
   * **Episodes are excluded.** An episode's text OPENS with the session's task line, so a task-shaped
   * query matches episodes better than it matches the lessons distilled from them — measuring 8 realistic
   * agent/task pairs against the live instapods store, **44% of preamble slots (28/64)** came back as raw
   * past task prompts, and one agent spent 4 of 8 slots on near-identical replays of the same daily sweep
   * while the reconciliation lesson it has been recalled on 185 times was crowded out. Task-ranking made
   * that bias systematic, so the retrieval has to correct for it. Episodes exist for Dreaming and the
   * consolidation gardener, which read them from the ledger directly; "what you already know" should be
   * the conclusions, not a transcript of past assignments. Same reason near-identical survivors are
   * collapsed: v0.396.0 stops byte-identical episodes being STORED, but older rows differing by a few
   * characters would otherwise take several slots to say one thing.
   */
  private async memoryPreamble(selfAgent?: string, task?: string): Promise<string> {
    const preload = this.os.settings.memoryConfig()?.preload;
    if (!preload?.enabled || !selfAgent) return '';
    const n = Math.max(1, Math.min(Math.floor(preload.count ?? 8), 25));

    const query = (task ?? '').replace(/\s+/g, ' ').trim().slice(0, TerminalManager.PRELOAD_QUERY_MAX);
    let lines: string[] = [];
    let relevant = false;

    if (query) {
      // The timer is deliberately NOT unref'd: a recall that never settles leaves the event loop with
      // nothing else pending, so an unref'd timer lets node exit before the timeout can fire — the launch
      // would die silently rather than fall back. Cleared as soon as the race settles either way.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error('preload recall timed out')), TerminalManager.PRELOAD_TIMEOUT_MS);
        });
        const hits = await Promise.race([
          // Over-fetch: episodes and near-duplicates are dropped below, and no backend can express
          // "exclude this tag" in the query itself (automem's tag_mode is `all`, an AND-filter).
          this.os.memory.recall({
            tenant: this.os.tenant,
            agentId: selfAgent,
            query,
            limit: Math.min(n * TerminalManager.PRELOAD_OVERFETCH, 100),
            scope: 'all',
          }),
          timeout,
        ]);
        lines = distinctLines(hits.filter((h) => !isPreambleNoise(h)).map((h) => h.content), n);
        relevant = lines.length > 0;
      } catch {
        /* fall through to the salience ordering below */
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    if (!lines.length) {
      try {
        // Same exclusion on the fallback path (`tags` is a JSON array in the ledger), so which path
        // answered never changes WHAT KIND of memory an agent is seeded with.
        lines = distinctLines(
          this.db
            .prepare(
              `SELECT content FROM memories
               WHERE tenant = ? AND (scope = 'tenant' OR (scope = 'agent' AND agent_id = ?))
                 AND COALESCE(tags, '') NOT LIKE '%"episode"%'
                 AND COALESCE(tags, '') NOT LIKE '%"dreaming"%'
               ORDER BY COALESCE(importance, 0.5) DESC, COALESCE(last_recalled_at, created_at) DESC
               LIMIT ?`,
            )
            .all<{ content: string }>(this.os.tenant, selfAgent, n * TerminalManager.PRELOAD_OVERFETCH)
            .map((r) => r.content),
          n,
        );
      } catch {
        return ''; // preamble is best-effort; a query failure must never block a session launch
      }
    }
    if (!lines.length) return '';

    const heading = relevant
      ? '# What you already know — your memories most relevant to this task'
      : '# What you already know — your most salient memories';
    return (
      `${heading}\n\n` +
      "Surfaced from your persistent memory so you don't start blind. This is a HEAD START, not the " +
      'whole picture — `recall` for more on any specific topic before non-trivial work.\n\n' +
      lines.map((c) => `- ${c.replace(/\s+/g, ' ').trim()}`).join('\n')
    );
  }

  /** The workspace Company context markdown (or '' if unset) — appended to claude's system prompt.
   *  We tack on OS-owned operating notes after the user's content. The terminal here is a browser
   *  xterm (over ttyd) running the TUI on the alternate screen with mouse reporting on, so embedded
   *  terminal hyperlinks (OSC 8) aren't clickable — the agent must surface raw URLs as plain text. */
  private buildCompanyMd(selfAgent?: string, actingMember?: string, unattended = false, preamble = ''): string {
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
    // Guarded by freshness: if the reflect loop has stalled (or is off) and the last pass is stale, we
    // STOP injecting the frozen snapshot — better no guidance than 2-week-old "recent" guidance presented
    // as current on every run (the Insights page banners the same staleness via `guidanceStale`).
    const lastPassTs = this.os.settings.applyLearnings()
      ? this.db.prepare("SELECT MAX(ts) AS t FROM audit_events WHERE type = 'learning.dreamed'").get<{ t: number | null }>()?.t ?? undefined
      : undefined;
    const learned = this.os.settings.applyLearnings() && !guidanceStale(lastPassTs, this.os.settings.dreamingEveryHours())
      ? this.os.settings.learnedGuidance().trim()
      : '';
    // The fleet roster — WHO this agent can delegate to. Injected so "hand off to the right agent" is
    // answerable straight from the prompt without a discovery round-trip. But `list_agents` is the live
    // equivalent, so we don't pay to embed an unbounded roster on every launch: cap the list, clip each
    // description, and point at the tool for the tail (the just-in-time contract — a high-value slice in
    // the prompt, the rest one tool-call away). Sorted by id so the injected slice is STABLE across
    // launches (predictable prompt → better caching). Excludes self and mock agents.
    const FLEET_CAP = 25;
    const peers = [...this.os.agents.values()]
      .filter((a) => isCodingRuntime(a.runtime) && a.id !== selfAgent)
      .sort((a, b) => a.id.localeCompare(b.id));
    const roster = peers
      .slice(0, FLEET_CAP)
      .map((a) => {
        const desc = a.description.replace(/\s+/g, ' ').trim();
        return `- \`agent:${a.id}\`${a.category ? ` (${a.category})` : ''} — ${desc.length > 140 ? desc.slice(0, 139) + '…' : desc}`;
      })
      .join('\n');
    const overflow = peers.length - FLEET_CAP;
    const fleet = peers.length
      ? '# Your fleet — who you can delegate to\n\n' +
        'These are the other agents in this workspace. To hand work to one, `task_create({ title, ' +
        'assignee: "agent:<id>", autoDispatch: true })` — it spawns that agent as a governed run under ' +
        'the same accountable human. Assign specialised work to the right agent rather than doing it ' +
        'poorly yourself or filing an unassigned task (which nobody picks up).\n\n' +
        roster +
        (overflow > 0 ? `\n- …and ${overflow} more — \`list_agents\` for the full roster.` : '')
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
        'These channels are wired directly into Agentric: the built-in tools post as the company bot, ' +
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
    // The strategic layer — the active company goals this agent's work should ladder up to. Injected so
    // "why am I doing this" is answerable straight from the prompt (goal_list is the live equivalent).
    // Human-owned; toggleable in Settings. Capped so a long goal list can't dominate every prompt.
    let goalsSection = '';
    if (this.os.settings.injectGoals()) {
      // Drop goals whose work is all done but that nobody has closed yet — they're awaiting a human's
      // sign-off, not direction for the fleet. Left in, a finished goal keeps steering every agent's work
      // indefinitely (it stays `active` until someone flips it). `goal_list` still shows them live.
      const complete = new Set(this.os.goals.readyToClose(this.os.tenant).map((g) => g.id));
      const active = this.os.goals.active(this.os.tenant).filter((g) => !complete.has(g.id)).slice(0, 12);
      if (active.length) {
        goalsSection =
          '# Company goals — the direction your work serves\n\n' +
          'The active goals the whole fleet is working toward right now (see the Goals & Tasks note above ' +
          'for how to link work and propose new ones). Prefer work that advances one:\n\n' +
          active
            .map((g) => `- ${g.title}${g.target ? ` — target: ${g.target}` : ''}${g.body ? `\n  ${g.body.replace(/\s+/g, ' ').trim().slice(0, 200)}` : ''}`)
            .join('\n');
      }
    }
    // Code-review steer — the fleet-wide policy for how an agent reviews a diff / PR before it opens or
    // merges one. Owner-editable in Settings → Company; when unset we inject a sensible DEFAULT so it's a
    // real standard from day one (existing tenants included — it rides the prompt, not a tenant seed). The
    // default steers toward a cheap cross-model second opinion and explicitly AWAY from any paid/cloud
    // review, and only names the `glm-review` skill concretely when this workspace actually has it
    // installed (so the guidance never dangles where it isn't).
    const customReview = this.os.settings.company().reviewMd.trim();
    let codeReview = '';
    if (customReview) {
      codeReview = `# Code review — how this workspace reviews changes\n\n${customReview}`;
    } else {
      const hasGlm = (() => {
        try { return !!this.os.skills.get('glm-review'); } catch { return false; }
      })();
      const secondOpinion = hasGlm
        ? 'run the **`glm-review`** skill for a fast cross-model second opinion (a cheap, independent ' +
          'reviewer that catches what one model misses), then reconcile its points against the code'
        : 'get a second opinion from a cheaper/independent reviewer where one is available, then reconcile ' +
          'its points against the code';
      codeReview =
        '# Code review — how this workspace reviews changes\n\n' +
        'Before you open or merge a pull request, review your own diff. ' +
        `First, ${secondOpinion}. ` +
        'Do NOT trigger a paid or cloud-billed review (e.g. `/code-review ultra`) on your own initiative — ' +
        'it costs money and a human decides when it is worth it. A local review (the host\'s own ' +
        '`/code-review` with no argument, or a cross-model pass) is free and is the default. Treat any ' +
        'review as a second opinion, not a verdict: verify each point against the code before acting, and ' +
        'remember every change you make still passes through the gateway.';
    }
    // Unattended lane only (see the call site). Placed after the operating notes and the fleet/team
    // sections, because it points at `task_wait` / `ask` / `schedule` / `task_create` as the ways to wait
    // — it reads as a correction to "just wait for it" only once those tools have been introduced.
    const lane = unattended ? UNATTENDED_TURN_BRIEF : '';
    // BOTH lanes. How to wait is not a lane question: the two limits that make a long sleep wrong (the
    // ~2-minute Bash kill, the ~5-minute cache TTL) apply identically to a member's own interactive
    // session, and the first two agents caught doing it were one of each.
    // Whose account each Composio namespace holds. Sits next to the messaging steer because it answers
    // the same class of question — "which of these lookalike tools is the right one" — and because both
    // are about acting as the right identity rather than the first tool that matches.
    const composio = this.composioContext(actingMember, selfAgent ?? '');
    return [company, memberCtx, AGENT_OS_OPERATING_NOTES, messaging, composio, github, codeReview, goalsSection, fleet, team, preamble, learned, lane, WAITING_BRIEF]
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Build the per-session `.mcp.json` payload (enabled connectors bound to the spawning member + the
   * OS-owned memory server) and return it as a JSON string. The backend materialises it where the
   * session can read it: the app's connectors dir (local), or the member's home (launcher). The
   * memory server is ALWAYS included and scoped to this session+agent. '' when there's no data home.
   */
  private async buildMcpConfigJson(sessionId: string, agent: string, actingMember: string | undefined, secret: string, slackReply = false, discordReply = false, askAnswer = false, clickupReply = false, telegramReply = false): Promise<string> {
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
      const sessions = this.composioSessionPlan(memberId, agent);
      // Minted CONCURRENTLY, not one after another: each mint is a ~0.5–1s round trip to Composio, so
      // a launch with a personal + company (+ shared) session used to serialise into ~1.5s of dead time
      // — and, on the old `spawnSync` transport, ~1.5s with the event loop stopped, which stalled every
      // other request on this single-threaded server. Failures stay per-session (audited, that connector
      // dropped), exactly as before.
      // Refresh what these entities actually hold — WHOSE account each app is, and what has expired —
      // so the next launch's prompt can name them. Fire-and-forget and rate-limited: a probe costs a
      // mint plus two round trips per entity, and no session may wait on it. Nothing here changes this
      // launch; it changes what the NEXT one is able to tell the agent.
      const due = sessions.filter((s) => this.composioIdentityStale(s.userId)).map((s) => ({ userId: s.userId, ownerMemberId: s.ownerMemberId }));
      if (due.length) void this.refreshComposioConnections(due).catch(() => { /* advisory */ });
      const minted = await Promise.all(sessions.map((s) => mintToolRouterSessionAsync(apiKey, s.userId, s.opts)));
      for (const [i, s] of sessions.entries()) {
        const res = minted[i];
        if ('url' in res) {
          config.mcpServers[s.id] = { type: 'http', url: res.url, headers: { [COMPOSIO_KEY_HEADER]: apiKey } };
          this.audit(sessionId, agent, 'connector.minted', {
            connector: s.id, scope: s.scope, userId: s.userId,
            ...(s.opts?.toolkits ? { toolkits: s.opts.toolkits } : {}),
          });
        } else {
          this.audit(sessionId, agent, 'connector.mint.failed', { connector: s.id, scope: s.scope, error: res.error });
        }
      }
    }

    // The OS-owned tool server: recall/remember (memory) + ask (ask-human) + report (completion)
    // + list_capabilities/policy_check (policy preview).
    const toolAllow = this.os.agents.get(agent)?.tools?.join(',') || undefined;
    config.mcpServers.agentos = {
      command: 'node',
      args: [this.memoryMcp],
      // SLACK_REPLY / DISCORD_REPLY: '1' makes the agentos server expose the native `slack_reply` /
      // `discord_reply` tool — only for chat-triggered sessions (which have a bound thread/channel),
      // so other agents aren't cluttered by it. SLACK_EGRESS / DISCORD_EGRESS: '1' expose the proactive
      // `slack_send`/`slack_dm` (and Discord equivalents) whenever the workspace has that platform
      // configured — any session can message a channel/person, not just chat-triggered ones.
      env: {
        AOS_URL: this.baseUrl, AOS_PUBLIC_URL: this.publicOrigin || this.baseUrl,
        AOS_TENANT: this.os.tenant, SESSION: sessionId, AGENT: agent, AOS_SECRET: secret,
        ...(slackReply ? { SLACK_REPLY: '1' } : {}),
        ...(discordReply ? { DISCORD_REPLY: '1' } : {}),
        // CLICKUP_REPLY: '1' exposes the native `clickup_reply` tool — only for ClickUp-triggered
        // sessions (which have a bound task), so the agent posts its answer back as a comment on the
        // SAME task without being handed (or able to spoof) a task id.
        ...(clickupReply ? { CLICKUP_REPLY: '1' } : {}),
        // TELEGRAM_REPLY: '1' exposes the native `telegram_reply` tool — only for Telegram-triggered
        // sessions (which have a bound chat), so the agent posts its answer back into the SAME chat
        // without being handed (or able to spoof) a chat id.
        ...(telegramReply ? { TELEGRAM_REPLY: '1' } : {}),
        // ASK_ANSWER: '1' exposes the `answer` tool — only on an ask_agent delegate, so it can return its
        // result to the agent that asked. Other sessions never see it.
        ...(askAnswer ? { ASK_ANSWER: '1' } : {}),
        // AOS_TOOLS: the agent's `tools` allowlist, narrowing what the agentos server OFFERS (its
        // schemas are re-read from the prompt on every turn). Context shaping only — the gateway is
        // still what governs whether an effect may happen. Unset ⇒ the full always-on set.
        ...(toolAllow ? { AOS_TOOLS: toolAllow } : {}),
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

  /** ACTIVE company accounts grouped by toolkit, from the identity cache — what `exclusionFor` needs to
   *  decide between disabling a toolkit outright and re-pinning it to the accounts nobody has claimed.
   *  A toolkit absent here is unknown to us, and `exclusionFor` disables it rather than leaving a claimed
   *  account reachable; over-restricting is recoverable, under-restricting is the bug. */
  private activeCompanyAccounts(entity: string): Map<string, string[]> {
    const byToolkit = new Map<string, string[]>();
    for (const i of this.os.composioIdentities.forEntity(entity)) {
      if (i.status.toUpperCase() !== 'ACTIVE') continue;
      byToolkit.set(i.toolkit, [...(byToolkit.get(i.toolkit) ?? []), i.id]);
    }
    return byToolkit;
  }

  /** Has this entity's cached identity/status gone stale (or never been resolved)? Keeps the launch-time
   *  refresh to roughly once every six hours per entity rather than once per session. */
  private composioIdentityStale(userId: string, maxAgeMs = 6 * 60 * 60 * 1000): boolean {
    const rows = this.os.composioIdentities.forEntity(userId);
    if (!rows.length) return true;
    return Math.min(...rows.map((r) => r.checkedAt)) < Date.now() - maxAgeMs;
  }

  /**
   * Re-resolve what a set of Composio entities actually hold: the live account list (status), and for
   * every toolkit with an ACTIVE account, WHICH account that is. Caches both, forgets connections that
   * no longer exist, and tells a human once about anything that has expired.
   *
   * Deliberately OFF the launch path — a probe is a mint plus two MCP round trips per entity, and a
   * session must not wait on Composio to start. Callers fire it and forget (the launcher) or await it
   * where latency is already expected (the console's Connections page). Every failure degrades to "we
   * learned nothing this time": a probe that fails never blanks a label we already had.
   *
   * `owners` maps an entity to the member accountable for it, so an expiry card reaches the person who
   * can actually reauthorise it; an entity with no owner (the company shelf) goes to the admins tier.
   */
  async refreshComposioConnections(
    entities: Array<{ userId: string; ownerMemberId?: string }>,
    opts: { notify?: boolean } = {},
  ): Promise<{ resolved: number; expired: number }> {
    const key = this.os.settings.composioApiKey();
    if (!key || !entities.length) return { resolved: 0, expired: 0 };
    const seen = new Map<string, string | undefined>();
    for (const e of entities) if (e.userId && !seen.has(e.userId)) seen.set(e.userId, e.ownerMemberId);
    let resolved = 0;
    let expired = 0;
    for (const [userId, ownerMemberId] of seen) {
      const accounts = await listConnectedAccounts(key, userId);
      if (!accounts.length) continue;
      // Status first, so an expired connection is recorded even when the identity probe fails.
      this.os.composioIdentities.upsert(accounts.map((a) => ({ id: a.id, userId, toolkit: a.toolkit, status: a.status })));
      const liveIds = new Set(accounts.map((a) => a.id));
      this.os.composioIdentities.pruneEntity(userId, liveIds);
      // A claim on a connection that no longer exists would keep disabling its toolkit for the whole
      // tenant forever, with nothing in the console left to explain why.
      this.os.composioClaims.pruneEntity(userId, liveIds);
      // ONLY toolkits with a live account — probing one without would make Composio initiate a
      // connection rather than report its absence (see composio-identity.ts).
      const found = await resolveIdentities(key, userId, activeToolkits(accounts));
      if (found.length) {
        const byId = new Map(accounts.map((a) => [a.id, a]));
        this.os.composioIdentities.upsert(
          found
            .filter((f) => byId.has(f.connectionId))
            .map((f) => ({ id: f.connectionId, userId, toolkit: f.toolkit, account: f.account, status: byId.get(f.connectionId)!.status })),
        );
        resolved += found.length;
      }
      const stale = accounts.filter((a) => a.status.toUpperCase() === 'EXPIRED');
      expired += stale.length;
      if (opts.notify !== false && stale.length) this.notifyExpiredConnections(userId, ownerMemberId);
      // ALWAYS, including when nothing is expired — that is exactly the case that has to retire a card
      // whose problem the human has already fixed.
      this.reconcileExpiredCards(userId);
    }
    this.audit('-', 'system', 'connector.identity.refreshed', { entities: [...seen.keys()], resolved, expired });
    return { resolved, expired };
  }

  /**
   * Tell someone that a Composio connection has expired. An expired connection is silent by
   * construction — the agent simply finds the app missing and works around it — which is how one
   * tenant's company ClickUp sat dead for two weeks with nothing anywhere saying so. One card per
   * entity, deduped for a week per connection, addressed to whoever can actually reauthorise it.
   */
  private notifyExpiredConnections(userId: string, ownerMemberId?: string): void {
    const QUIET_MS = 7 * 24 * 60 * 60 * 1000;
    const due = this.os.composioIdentities.unnotifiedExpired(userId, QUIET_MS);
    if (!due.length) return;
    const live = new Set(
      this.os.composioIdentities.forEntity(userId).filter((i) => i.status.toUpperCase() === 'ACTIVE').map((i) => i.toolkit),
    );
    // Reconnecting leaves the old row behind, so an expired connection whose toolkit is live again is
    // housekeeping, not news — "Clear replaced" in Connections deals with it. Only a toolkit with NO
    // live account left is a capability the fleet has actually lost, and only that is worth a card in
    // someone's NEEDS YOU column. Mark the rest notified so they stop being reconsidered every refresh.
    const lostToolkits = [...new Set(due.filter((d) => !live.has(d.toolkit)).map((d) => d.toolkit))];
    this.os.composioIdentities.markNotified(due.map((d) => d.id));
    this.audit('-', 'system', 'connector.expired', {
      entity: userId, toolkits: [...new Set(due.map((d) => d.toolkit))], lost: lostToolkits,
    });
    if (!lostToolkits.length) return;
    // One line per TOOLKIT, not per connection row: two expired accounts of the same app are one
    // problem, and listing "google_search_console, google_search_console" reads like a bug (it was one).
    const accountOf = (t: string): string => due.find((d) => d.toolkit === t && d.account)?.account ?? '';
    const whose = ownerMemberId ? 'Your' : 'The company';
    const n = lostToolkits.length;
    // Each app is named ONCE — in the list, where its account can sit beside it. The opening line stays
    // generic so a single-app card doesn't say the same slug twice in three lines.
    const body = [
      `${whose} Composio connection${n === 1 ? ' has' : 's have'} expired, and nothing else is connected for ${n === 1 ? 'this app' : 'these apps'} — so agents cannot use ${n === 1 ? 'it' : 'them'} at all:`,
      ...lostToolkits.map((t) => `- ${t}${accountOf(t) ? ` (${accountOf(t)})` : ''}`),
      '',
      `Reconnect ${n === 1 ? 'it' : 'them'} in Connections to restore ${n === 1 ? 'it' : 'them'}. This card clears itself once nothing is expired.`,
    ].join('\n');
    this.postReviewCard({
      type: 'connection.expired',
      sessionId: '-',
      agent: 'system',
      title: `Connection expired — ${lostToolkits.join(', ')} unavailable`,
      body,
      args: { entity: userId, toolkits: lostToolkits, lost: lostToolkits },
      audience: ownerMemberId ? { kind: 'member', id: ownerMemberId } : { kind: 'admins' },
      // Inbox only. An expired connection is a standing condition, not a question anyone is blocked on:
      // it stays true until someone reconnects the app, and the card retires itself when they do. A DM
      // for it is a notification about state, which is exactly the kind of chat noise that makes the
      // approvals and questions people MUST answer harder to see.
      quiet: true,
    });
  }

  /**
   * Close any expired-connection card whose premise has gone away.
   *
   * A card that outlives its condition is worse than no card: it sits in NEEDS YOU claiming an app is
   * unavailable after the human has already dealt with it, and there is nothing they can do to make it
   * go away — a review card carries no reject path, so "I fixed this" and "I am ignoring this" look
   * identical. That happened the same afternoon this shipped: the expired connections were removed, the
   * cache dropped to zero expired rows, and both cards stayed open.
   *
   * So the card is DERIVED state, reconciled on every refresh: it stands only while at least one of the
   * toolkits it names still has an expired connection under that entity. Reconnected, deleted, or
   * pruned all clear it — the card is about an expiry, and once no expiry remains there is nothing to
   * report. Mirrors how an approval message derives its status from the approvals table at read time.
   */
  private reconcileExpiredCards(userId: string): number {
    const expired = new Set(
      this.os.composioIdentities.forEntity(userId)
        .filter((i) => i.status.toUpperCase() === 'EXPIRED')
        .map((i) => i.toolkit),
    );
    const open = this.db
      .prepare(`SELECT id, args FROM messages WHERE type = 'connection.expired' AND status = 'open'`)
      .all<{ id: string; args: string | null }>();
    let closed = 0;
    for (const row of open) {
      let a: Record<string, unknown> = {};
      try { a = row.args ? JSON.parse(row.args) : {}; } catch { /* tolerate a corrupt payload */ }
      if (String(a.entity ?? '') !== userId) continue;
      const named: string[] = Array.isArray(a.toolkits) ? (a.toolkits as unknown[]).map(String) : [];
      // No toolkits recorded (a card from before this shape) → it can never be reconciled by name, so
      // treat "nothing is expired on this shelf" as enough to retire it.
      if (named.some((t) => expired.has(t))) continue;
      this.db.prepare(`UPDATE messages SET status = 'resolved' WHERE id = ?`).run(row.id);
      closed++;
      this.audit('-', 'system', 'connector.expired.cleared', { entity: userId, toolkits: named });
    }
    return closed;
  }

  /**
   * Which Composio Tool Router sessions this run gets, and under whose entity each is minted. Pure
   * (DB reads only, no network), because TWO places must agree on it and disagreeing is exactly the
   * failure we are fixing: `buildMcpConfigJson` mints them, and `composioContext` tells the agent in
   * its prompt what each one actually is. Deriving the prompt from the same plan means the agent can
   * never be told about a namespace it doesn't have, or left blind about one it does.
   */
  private composioSessionPlan(memberId: string | undefined, agent: string): Array<{ id: string; userId: string; scope: 'personal' | 'company' | 'shared'; ownerMemberId?: string; opts?: MintOptions }> {
    const companyEntity = serviceUserId(this.os.tenant);
    // Claims (composio-claims.ts): a company connection that is really ONE person's account is minted
    // OUT of everyone else's company session — including automation/system runs, which have no member
    // and so no business acting as one. The exact inverse of a share, enforced in the same place.
    const claims = this.os.composioClaims.list().filter((c) => c.userId === companyEntity);
    const companyOpts: MintOptions = claims.length
      ? exclusionFor(claims, this.activeCompanyAccounts(companyEntity), memberId)
      : {};
    const sessions: Array<{ id: string; userId: string; scope: 'personal' | 'company' | 'shared'; ownerMemberId?: string; opts?: MintOptions }> = [
      { id: 'composio-company', userId: companyEntity, scope: 'company', ...(claims.length ? { opts: companyOpts } : {}) },
    ];
    // `composio` → the running member's OWN connected apps (their email as user_id); `composio-company`
    // → apps connected under the shared service entity, usable by every agent. Automation/system spawns
    // get only the company entity (no person's personal credentials).
    if (memberId) sessions.unshift({ id: 'composio', userId: this.composioUserId(memberId, agent), scope: 'personal', ownerMemberId: memberId });
    // Connections a TEAMMATE marked "available to the team". A connected account's owning entity is
    // immutable on Composio's side, so sharing is a marker we enforce here: one extra session per
    // sharing owner, minted under THEIR entity but allowlisted to the shared toolkits and pinned to
    // the shared account ids — so the borrower reaches exactly what was shared and nothing else of
    // that person's Composio account. Connection management is off: a borrower must not be able to
    // add or revoke connections under an entity that isn't theirs.
    for (const m of this.os.composioShares.mintsFor(memberId)) {
      sessions.push({
        id: `composio-shared-${m.ownerMemberId}`,
        userId: m.userId,
        scope: 'shared',
        ownerMemberId: m.ownerMemberId,
        opts: { toolkits: m.toolkits, connectedAccounts: m.connectedAccounts, manageConnections: false },
      });
    }
    return sessions;
  }

  /**
   * The prompt section that tells an agent WHOSE accounts each Composio namespace holds.
   *
   * Without it the agent sees two indistinguishable MCP servers named `composio` and
   * `composio-company`, and the Tool Router auto-selects tools from whichever answers — so the choice
   * of identity is made by relevance ranking, not by intent. That is not hypothetical: one run created
   * a Google Sheet through `composio-company` (whose Google account turned out to belong to a specific
   * teammate, so the file landed in that person's Drive) and then sent mail through `composio`, which
   * is the run-as member's own Gmail, because the company entity had no Gmail at all. Both were
   * reasonable guesses from a name alone. Names are not identities, so we state the identities.
   *
   * Reads the CACHE only (`composio_identities`), never the network — `buildCompanyMd` is a synchronous
   * assembly and a launch must not wait on Composio. An entity we have not resolved yet degrades to its
   * scope line without an account list, which is still strictly more than the agent knew before.
   */
  private composioContext(memberId: string | undefined, agent: string): string {
    if (!this.os.settings.composioApiKey()) return '';
    const plan = this.composioSessionPlan(memberId, agent);
    const cached = this.os.composioIdentities;
    // A claimed app sits on the company shelf but belongs to one person. The claimer's own runs still
    // reach it, and they are told so explicitly — otherwise "it is on the company shelf" reads as
    // "it is the company's", which is the misreading that put a teammate's Drive in an agent's hands.
    const claimedBy = new Map(this.os.composioClaims.list().map((c) => [c.id, c.memberId]));
    const claimNote = (id: string): string =>
      claimedBy.has(id) ? ' — your OWN account, kept on the company shelf; no other agent can use it' : '';
    const lines: string[] = [];
    for (const s of plan) {
      const who = s.scope === 'personal'
        ? `the connected apps of **${this.os.team.getMember(memberId ?? '')?.name || s.userId}**, the person this run acts as`
        : s.scope === 'company'
          ? 'the apps connected at the COMPANY level, shared by every agent'
          : `apps **${this.os.team.getMember(s.ownerMemberId ?? '')?.name || s.userId}** lent to the team`;
      let accounts = cached.forEntity(s.userId).filter((i) => i.status.toUpperCase() === 'ACTIVE');
      // A claimed company app is minted out of this session unless the run acts as its claimer, so it
      // must not be advertised here either — telling an agent about an app it cannot reach is the same
      // class of lie as not telling it whose account an app is.
      if (s.scope === 'company') {
        const mine = new Map(this.os.composioClaims.list().filter((c) => c.userId === s.userId).map((c) => [c.id, c.memberId]));
        accounts = accounts.filter((a) => !mine.has(a.id) || mine.get(a.id) === memberId);
      }
      const detail = accounts.length
        ? accounts.map((a) => `    - ${a.toolkit} — ${a.account || 'account unknown'}${claimNote(a.id)}`).join('\n')
        : '    - (nothing resolved yet — check Connections in the console before assuming an app is there)';
      lines.push(`- **\`${s.id}\`** — ${who}:\n${detail}`);
    }
    if (!lines.length) return '';
    return (
      '# Composio — whose account you are about to act as\n\n' +
      'Each Composio namespace below is a SEPARATE set of third-party accounts, and the tool you pick ' +
      'decides which real person or company the world sees. The namespace name says whose SHELF an app ' +
      'sits on, not whose account it is: a company connection is still somebody\'s individual login ' +
      'underneath, and that is who owns the documents you create and who appears as the sender of the ' +
      'mail you send. The resolved account is named below — read it before you act.\n\n' +
      lines.join('\n') +
      '\n\nRules: prefer the namespace whose account matches the identity the task calls for; when a task ' +
      'is company work, use `composio-company`, and when it is this person\'s own work, use `composio`. ' +
      'If the account that would act is NOT the one the task implies — a company task that would send ' +
      'from an individual\'s mailbox, or a personal task that would write into a teammate\'s Drive — stop ' +
      'and `ask` a human instead of proceeding. Never assume an app exists on a shelf because it exists ' +
      'on another one.'
    );
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
   * session id without involving the server. Written for every lane; `attendLaunchEnv` un-marks it when
   * a human takes an unattended run over. Carries the per-session secret → never world-readable.
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
      // The agent's own opt-in list (`AgentManifest.skills`) is ANDed with each skill's audience — see
      // SkillsStore.materialize. Audit the fact that a list was in play, so "why did my skill not show
      // up" is answerable from the trail rather than by reading two tables.
      const allow = this.os.agents.get(agent)?.skills;
      const names = this.os.skills.materialize(path.join(agentDir, '.claude'), agent, allow);
      if (names.length)
        this.audit(sessionId, agent, 'skills.materialized', {
          count: names.length,
          skills: names,
          ...(allow?.length ? { allowlist: allow.length } : {}),
        });
    } catch (e) {
      this.audit(sessionId, agent, 'skills.error', { error: String(e) });
    }
  }

  /**
   * Sync the workspace output-style library into the agent's `<dir>/.claude/output-styles/` so the
   * launched claude discovers a CUSTOM style by name (built-ins need no file). Whole library, no
   * allowlist: an unselected style file is inert, and only `CLAUDE_OUTPUT_STYLE` decides which applies.
   * Best-effort — a style failure must never block a session.
   */
  private materializeOutputStyles(sessionId: string, agent: string, agentDir: string): void {
    try {
      const names = this.os.outputStyles.materialize(path.join(agentDir, '.claude'));
      if (names.length) this.audit(sessionId, agent, 'output-styles.materialized', { count: names.length, styles: names });
    } catch (e) {
      this.audit(sessionId, agent, 'output-styles.error', { error: String(e) });
    }
  }

  /**
   * Sync the agent's opted-in `usableSubagents` fleet teammates into `<dir>/.claude/agents/*.md` so the
   * launched claude can spawn them as native in-process sub-agents (the `Agent`/Task tool). The gate
   * hook still governs every effect a sub-agent has (tagged with its `agent_type`); this just exposes
   * the teammate personas. Best-effort — a failure must never block a session launch.
   */
  private materializeSubagents(sessionId: string, agent: string, manifest: AgentManifest): void {
    try {
      const names = materializeSubagents(path.join(manifest.dir!, '.claude'), manifest, this.os.agents, this.os.settings.subagentDefault());
      if (names.length) this.audit(sessionId, agent, 'subagents.materialized', { count: names.length, subagents: names });
    } catch (e) {
      this.audit(sessionId, agent, 'subagents.error', { error: String(e) });
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
    if (!manifest || !runtimeSupports(manifest.runtime, 'nativeSkills') || !manifest.dir) return { reloaded: 0 };
    // No `status` filter — liveness is the pane (`reachable`). A session that reported still has the REPL
    // the `/reload-skills` inject needs, and skipping it meant the human who just approved the install
    // watched the agent keep saying it has no such skill.
    const rows = this.db
      .prepare(`SELECT id, tmux, run_as, spawned_by FROM term_sessions WHERE agent = ? AND headless = 0`)
      .all<{ id: string; tmux: string; run_as: string | null; spawned_by: string | null }>(agent)
      .filter((r) => this.reachable(r.id));
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

  /**
   * Inject text into a LIVE session's pane exactly as if the attached human typed it (tmux send-keys),
   * optionally submitting with Enter. Powers the console's Quick Shortcuts (e.g. "Check now", a saved
   * prompt): a human affordance, not an agent effect, so it carries the SAME trust as attaching and
   * typing — no policy gate here, but every effect the resulting turn triggers is still mediated by the
   * PreToolUse gate hook. Newlines are flattened to a space so a stray return can't submit early; the
   * separate Enter keypress (when `submit`) is the one authoritative submit. Refuses a dead/unknown
   * session (there is no pane to type into).
   */
  injectToSession(sessionId: string, text: string, submit: boolean, by: string): { ok: boolean; error?: string } {
    const row = this.db.prepare('SELECT tmux, status, run_as, spawned_by FROM term_sessions WHERE id = ?')
      .get<{ tmux: string; status: string; run_as: string | null; spawned_by: string | null }>(sessionId);
    if (!row) return { ok: false, error: 'unknown session' };
    const body = (text || '').replace(/\r?\n+/g, ' ').trim();
    if (!body) return { ok: false, error: 'nothing to send' };
    // `reachable`: a session that reported still has a live REPL to type into, and telling its own console
    // "not live — open it first" while the pane is right there is the visible half of the poke-back bug.
    if (!this.reachable(sessionId)) return { ok: false, error: 'session is not live — open it first' };
    const space = this.spaceFor(row.run_as ?? row.spawned_by);
    // `injectText` reports that the KEYSTROKES were delivered — deliberately not that a turn started. Two
    // live incidents killed that ambition: a claude TUI renders a submitted message with the same `❯`
    // glyph and paste chip as a parked one, and a mid-turn agent parks injected text on purpose, so a pane
    // capture cannot tell delivered from parked. Guessing stopped two working runs. See session-backend.ts.
    const ok = this.backend.injectText(space, row.tmux, body, submit);
    if (!ok) return { ok: false, error: 'could not deliver keystrokes to the terminal' };
    // Submitted text starts a turn, so mark the session busy (the Stop-hook beacon clears it) — without
    // it a poke delivered into a warm pane leaves the console reading idle through the work it triggered.
    if (submit) {
      this.db.prepare('UPDATE term_sessions SET last_activity = ?, busy_since = COALESCE(busy_since, ?), updated_at = ? WHERE id = ?')
        .run(Date.now(), Date.now(), Date.now(), sessionId);
      this.restoreRunningAfterDelivery(sessionId);
    } else {
      this.db.prepare('UPDATE term_sessions SET last_activity = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), sessionId);
    }
    this.audit(sessionId, this.sessionAgent(sessionId) ?? '', 'session.inject', { by, chars: body.length, submit });
    return { ok: true };
  }

  /** The gate. Same policy brain as the console — allow flows, ask → inbox approval (auto-cleared for
   *  an attended approver), never → deny. Args are enriched into facts first (the single classifier). */
  gate(sessionId: string, agent: string, capability: string, rawArgs: Record<string, unknown>, reasoning: string, subagent?: { type?: string; id?: string }): GateResult {
    // A native Claude Code sub-agent (the `Agent`/Task tool) runs IN this session's process, so its
    // tool calls arrive here under the SAME session/principal/budget — Claude Code just tags the hook
    // input with `agent_type`/`agent_id`. Carry that through into the audit trail so a governed effect
    // is attributable to which sub-agent produced it, without inventing a separate governed session.
    const sub = subagent?.type ? { subagent: subagent.type, subagentId: subagent.id } : undefined;
    // Workspace emergency stop — deny every action before classifying anything.
    if (this.os.settings.killSwitch().engaged) {
      this.audit(sessionId, agent, 'gate.killswitch', { capability });
      return { decision: 'deny', reason: 'workspace emergency stop (kill switch) is engaged — every action is blocked until an owner disengages it', capability };
    }
    // Host-egress governance (Phase 2b): OFF unless the workspace switch is on. When on, pass the
    // agent's granted host matchers (org + shared + the session's run-as member's personal) so the
    // enricher can parse the egress target and compute host facts. `null` = feature off.
    let hostGrants: { match: string; protocol: 'ssh' | 'http' | 'postgres' | 'any'; posture: 'allow' | 'ask' | 'never' }[] | null = null;
    if (this.os.settings.hostGovernanceEnabled()) {
      const runAs = this.db.prepare('SELECT run_as FROM term_sessions WHERE id = ?').get<{ run_as: string | null }>(sessionId)?.run_as ?? undefined;
      hostGrants = this.os.hosts.grantsFor(runAs);
    }
    // Composio Tool Router envelope (composio-envelope.ts): its session exposes only six meta-tools, so
    // the REAL action lives inside `input` and every plane keyed on `args.tool` — normalization, the
    // enricher's email facts, the decision brief — was reading the envelope's name instead. Rewrite to
    // the real effect FIRST, so everything below governs a Composio action exactly as it governs a
    // first-class connector tool. Not an envelope → null, and nothing changes.
    const envelope = unwrapComposioEnvelope(capability, rawArgs, this.emailOrgDomains());
    if (envelope) {
      this.audit(sessionId, agent, 'gate.composio.unwrapped', {
        from: rawArgs.tool, to: envelope.args.tool, kind: envelope.kind,
        capability: envelope.capability, actions: envelope.actions,
      });
      rawArgs = envelope.args;
      capability = envelope.capability;
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
        return { decision: 'deny', reason: emailDenial, capability };
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
    // Capability normalization (§4.2): a generic `connector.call` carries the vendor action only in
    // args.tool. Resolve it to a canonical, provider-independent capability (STRIPE_REFUND →
    // payments.refund) so ONE policy rule governs the same action across Stripe / a REST call / an SDK
    // call. Runs AFTER enrichArgs (so the enricher's connector-mutation facts are already set) and after
    // the email/host promotions above (which never produce `connector.call`, so they're untouched). An
    // unmapped tool falls through unchanged — this only adds granularity, never removes governance.
    const normalizedCap = resolveCapability(capability, typeof args.tool === 'string' ? args.tool : undefined);
    if (normalizedCap !== capability) {
      this.audit(sessionId, agent, 'gate.capability.normalized', { from: capability, to: normalizedCap, tool: args.tool });
      capability = normalizedCap;
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
    // Semantic guard (Tier 1): a CLEAR-CUT prompt-injection / secret-exfiltration shape (the enricher's
    // `injectionSuspect` fact) pauses for a human. Engine-level like host governance — combined via
    // stricterDecision, NOT a JSON rule — so it reaches every tenant regardless of a persisted policy
    // override. Only an `ask` (a heuristic false positive must be recoverable), and only when the
    // workspace toggle is on; OFF by default so the patterns bake against the audit trail first.
    if (args.injectionSuspect === true && this.os.settings.semanticGuardEnabled()) {
      decision = stricterDecision(decision, injectionDecision(args));
    }
    // File-write guard. Engine-level for the same reason as the two above: `default@v3` carries NO
    // file.write rules and defaults to allow, and a tenant with a persisted policy override would never
    // pick up a new JSON rule. Tier 1 (crown-jewel paths → deny) is unconditional; tier 2 (ask for any
    // write outside the agent's folder) is behind a workspace toggle, default off.
    if (capability === 'file.write') {
      decision = stricterDecision(decision, fileGovernanceDecision(capability, args, {
        dataHome: this.os.paths?.home,
        askOutsideWorkdir: this.os.settings.fileWriteGuardEnabled(),
      }));
    }
    // The DECISION BRIEF — one human-legible account of this effect (docs/decision-brief-layer-plan.md).
    // Computed once here, next to classify(); it rides on the gate.decision audit row (making the audit
    // trail legible instead of a wall of {tool,input}) and, for a gated action, on the approval card.
    const brief = briefFor(capability, args, decision);
    // Scrub credential-looking tokens (a hardcoded GH_TOKEN/API key inline in the command) BEFORE the
    // command is persisted — into the audit trail, the approval card, and the approvals row (they all
    // read this same `args`). Classification + host parsing already ran on the real value above.
    if (typeof args.command === 'string') args.command = redactSecrets(args.command);
    if (args.input && typeof args.input === 'object') {
      const inp = args.input as Record<string, unknown>;
      if (typeof inp.command === 'string') inp.command = redactSecrets(inp.command);
    }
    this.audit(sessionId, agent, 'gate.attempt', { capability, args, reasoning, ...sub });
    this.audit(sessionId, agent, 'gate.decision', { capability, decision, brief, ...sub });
    // A tool call is PROOF a turn is running — this is the universal turn heartbeat. `UserPromptSubmit`
    // only reaches sessions launched since that hook shipped (hook settings are written at launch), so
    // without this an already-running session that had its `busy_since` cleared could never get it back
    // and read `ready` while visibly generating. The gate hook, by contrast, is wired into every session
    // that exists — it is the invariant. `answered: false`: a tool call is not a human answering, so it
    // must not retire a waiting card (and a session blocked on an approval still reads `needs you`,
    // which outranks `working`, so setting the flag here cannot mask a block).
    this.markTurnBusy(sessionId, { answered: false });

    if (decision.effect === 'allow') {
      // Behavioural-failure watch (phase 3): the effect is allowed, but if it completes a no-progress
      // LOOP — or backgrounds work whose cleanup can't survive the tool call — we let it through WITH an
      // advisory note: an `instruct` (allow + additionalContext) nudging the agent. Soft by design: the
      // model may ignore it. Sub-agent calls don't carry a distinct run to loop within, so watch only
      // top-level effects.
      if (this.reliabilityOn && !sub) {
        const sig = this.reliability.observe(sessionId, capability, args, brief.headline, Date.now());
        if (sig) {
          const data: Record<string, unknown> = { capability, signature: brief.signature };
          if (sig.kind === 'loop') data.count = sig.count; else data.reason = sig.reason;
          this.audit(sessionId, agent, sig.kind === 'loop' ? 'reliability.loop' : 'reliability.detached_work', data);
          return { decision: 'allow', note: sig.note };
        }
      }
      return { decision: 'allow' };
    }
    if (decision.effect === 'deny') return { decision: 'deny', reason: decision.reason, capability };

    // Auto-approval list: an owner has said "always approve THIS action" for this exact brief signature,
    // so clear it without a card or notification. Only reachable for an `approve` (the deny/never tier
    // returned above), so a listed signature can never wave through an irreversible action.
    const listed = this.os.autoApprovals.match(brief.signature);
    if (listed) {
      this.audit(sessionId, agent, 'approval.auto_approved', { capability, level: decision.level, via: 'auto-approve-list', signature: brief.signature, by: listed.addedBy });
      return { decision: 'allow' };
    }

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
      // The brief rides inside the card's args so the console renders a legible summary instead of the
      // raw {tool,input} blob; the raw facts remain (the card demotes them to a "raw" drill-down).
      args: { ...args, brief },
      level: decision.level,
      audienceKind: aud.kind,
      audienceId: audienceIdOf(aud),
    });
    this.audit(sessionId, agent, 'approval.requested', { approvalId: req.id, level: decision.level, capability, brief });
    // Out-of-band ping (Slack/Discord DM to whoever can approve) — best-effort, never blocks the gate.
    try { this.approvalNotifier?.({ approvalId: req.id, sessionId, agent, capability, level: decision.level, riskClass: decision.riskClass, reason: decision.reason, headline: brief.headline }); } catch { /* notifications are advisory */ }
    // If the run was triggered from chat, surface the gate in that thread too (the approver DM reaches
    // the approver; this reaches everyone watching the thread). No-op for non-chat runs.
    const dot = decision.riskClass === 'red' ? '🔴' : '🟡';
    const inboxLink = consolePage(this.publicOrigin, 'inbox');
    try { this.chatMirror?.(sessionId, (p) => `${dot} ${agent} needs approval — ${brief.headline}\n\`${capability}\` (${decision.riskClass.toUpperCase()} · ${decision.level}) — _${brief.rationale}_\nOpen the ${chatLink(p, inboxLink, 'Agentric Inbox')} to approve or reject.`); } catch { /* advisory */ }

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
  ): Promise<{ status: 'stored' | 'denied' | 'error'; detail?: string; replaced?: boolean }> {
    if (this.os.settings.killSwitch().engaged) {
      this.audit(sessionId, agent, 'gate.killswitch', { capability: 'secret.put', key });
      return { status: 'denied', detail: 'workspace emergency stop is engaged' };
    }
    // A put over an EXISTING shared key is a replacement, not a create — every other agent resolving it
    // starts getting the new value. Say so in the classify args, the card and the audit (metadata only,
    // still never the value), so an approver can't wave through a clobber of a live credential thinking
    // they're approving a first write.
    const prior = this.os.secrets.list(this.os.tenant).find((sec) => sec.principal === '*' && sec.key === key);
    const replaced = prior !== undefined;
    // Gate on the KEY only — the value is deliberately absent from classify/audit/the approval card.
    const attempt: ActionAttempt = { capabilityId: 'secret.put', args: { key, replaced }, reasoning };
    const decision: Decision = this.os.policy.classify(attempt, this.ctx(sessionId, agent));
    this.audit(sessionId, agent, 'gate.attempt', { capability: 'secret.put', args: { key, replaced }, reasoning });
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
          title: replaced ? `Approval needed — REPLACE secret "${key}"` : `Approval needed — store secret "${key}"`,
          body: replaced
            ? `${reasoning}\n\nThis OVERWRITES the existing shared "${key}" (last set ${prior!.updatedBy ? `by ${prior!.updatedBy} ` : ''}${new Date(prior!.updatedAt).toISOString().slice(0, 10)}). Every agent resolving that key gets the new value.`
            : reasoning,
          status: 'pending',
          approvalId: req.id,
          capability: 'secret.put',
          args: { key, replaced },
          level: decision.level,
          audienceKind: aud.kind,
          audienceId: audienceIdOf(aud),
        });
        this.audit(sessionId, agent, 'approval.requested', { approvalId: req.id, level: decision.level, capability: 'secret.put' });
        try { this.approvalNotifier?.({ approvalId: req.id, sessionId, agent, capability: 'secret.put', level: decision.level, riskClass: decision.riskClass, reason: decision.reason }); } catch { /* advisory */ }
        const approved = await settle;
        this.audit(sessionId, agent, 'approval.resolved', { approvalId: req.id, approved });
        if (!approved) return { status: 'denied', detail: `approval rejected (${decision.level})` };
      }
    }
    // green (allow) or approved → write the encrypted row under the shared tenant-wide principal.
    try {
      this.os.secrets.set(this.os.tenant, key, value, { principal: '*', updatedBy: `agent:${agent}` });
      this.audit(sessionId, agent, 'secret.put', { key, principal: '*', replaced, ...(prior ? { previousUpdatedAt: prior.updatedAt, previousUpdatedBy: prior.updatedBy } : {}) });
      return { status: 'stored', replaced };
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
    // Mirror the gate exactly, in the same order: unwrap a Composio envelope to the real action, then
    // enrich, then email promotion, then capability normalization (§4.2) — so a dry-run preview
    // classifies the same canonical capability the live gate will.
    const unwrapped = unwrapComposioEnvelope(capability, args, this.emailOrgDomains());
    if (unwrapped) { args = unwrapped.args; capability = unwrapped.capability; }
    const enriched = enrichArgs(capability, args, this.emailOrgDomains(), this.os.agents.get(agent)?.dir, this.os.settings.enrichPatterns());
    const cap = enriched.emailSend === true
      ? 'email.send'
      : resolveCapability(capability, typeof enriched.tool === 'string' ? enriched.tool : undefined);
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

  private addMessage(m: Omit<FeedMessage, 'id' | 'createdAt'>): string {
    const id = newId('message');
    this.db
      .prepare('INSERT INTO messages (id, type, session_id, agent, title, body, status, approval_id, capability, args, level, source, question_id, outcome, audience_kind, audience_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        id, m.type, m.sessionId, m.agent, m.title, m.body, m.status,
        m.approvalId ?? null, m.capability ?? null, m.args !== undefined ? JSON.stringify(m.args) : null,
        m.level ?? null, m.source ?? null, m.questionId ?? null, m.outcome ?? null,
        m.audienceKind ?? null, m.audienceId ?? null, Date.now(),
      );
    return id;
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
   * Post an inbox card the OS itself raises — no session, no agent behind it. Today's caller is the
   * self-update watcher (`src/edge/update-watch.ts`): "this box is behind origin", "an update is blocked
   * by uncommitted changes", "an update was applied/failed". Uses a `system:<topic>` sentinel for
   * `session_id` (no matching `term_sessions` row) so visibility is decided entirely by the Audience,
   * exactly like {@link postTaskCard}. Returns the row id so a caller can supersede its own earlier card.
   *
   * A `notification` needs no `approvalId`; an `approval` card carries one plus its `level`, which is
   * what makes the Inbox render Approve/Reject and route it through the normal decide endpoint — the
   * watcher does not need (and must not have) an approval path of its own.
   */
  postSystemCard(input: {
    topic: string;
    type: 'notification' | 'approval';
    title: string;
    body: string;
    audience: Audience;
    args?: Record<string, unknown>;
    approvalId?: string;
    level?: string;
    capability?: string;
    notify?: boolean;
  }): string {
    const id = this.addMessage({
      type: input.type, sessionId: `system:${input.topic}`, agent: 'system',
      title: input.title, body: input.body, status: input.type === 'approval' ? 'pending' : 'open',
      ...(input.args ? { args: input.args } : {}),
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      ...(input.level ? { level: input.level } : {}),
      ...(input.capability ? { capability: input.capability } : {}),
      audienceKind: input.audience.kind, audienceId: audienceIdOf(input.audience),
    });
    // A card nobody is logged in to see is the whole problem this solves on a headless box, so the
    // out-of-band DM is the point rather than a nicety — but it stays advisory: a chat outage must not
    // stop the card being recorded.
    if (input.notify !== false) {
      try { this.reviewNotifier?.({ sessionId: `system:${input.topic}`, agent: 'system', kind: 'system.update', title: input.title, summary: input.body, audience: input.audience, link: { page: 'settings', detail: 'updates', label: 'Settings → Updates' } }); }
      catch { /* out-of-band push is advisory */ }
    }
    return id;
  }

  /** Close an OS-raised card (the watcher superseding its own earlier notice when origin moves on, or
   *  retiring one once the update landed). Scoped to `system:` sentinels so it can only touch its own. */
  closeSystemCards(topic: string, status: 'approved' | 'rejected' | 'cancelled' = 'cancelled', exceptId?: string): number {
    const r = this.db
      .prepare(`UPDATE messages SET status = ? WHERE session_id = ? AND status IN ('open','pending') AND id != ?`)
      .run(status, `system:${topic}`, exceptId ?? '');
    return Number(r.changes) || 0;
  }

  /**
   * Post one message into a task's **Discussion** (the task-detail conversation — see
   * `docs/task-rooms-plan.md`). A Discussion message is a `messages` row with `type='task.chat'` +
   * `audience_kind:'task'` on the `task:<id>` sentinel session; it is EXCLUDED from the Inbox feed
   * (`listMessages`) — the Discussion is its own surface — so posting here never floods anyone's inbox.
   * Escalation to an Inbox/DM happens only via @mentions (handled by the caller), per Decision 3.
   * `author` is a member id (human) or `agent:<id>`; `agent` is the bare agent id when agent-authored.
   * Returns the stored entry so a route/tool can echo it back. Auto-apply + audited, like task edits.
   */
  postTaskMessage(input: { taskId: string; author: string; agent?: string; body: string }): TaskTimelineEntry {
    const body = input.body.trim();
    const id = this.addMessage({
      type: 'task.chat', sessionId: `task:${input.taskId}`, agent: input.agent ?? '',
      title: '', body, status: 'open', source: input.author,
      audienceKind: 'task', audienceId: input.taskId,
    });
    const at = Date.now();
    this.audit(`task:${input.taskId}`, input.agent ?? input.author, 'task.said', { taskId: input.taskId, chars: body.length });
    return {
      kind: 'chat', id, author: input.author, agentId: input.agent || undefined,
      body, mentions: parseMentions(body), at,
    };
  }

  /**
   * A task's Discussion timeline: the `task.chat` messages interleaved with the `task_events` state log,
   * sorted oldest-first. Legacy `comment` events fold in as chat entries (Decision 2 — comments used to
   * live in `task_events`; new ones are `task.chat` messages), everything else renders as a system event.
   */
  discussionTimeline(taskId: string): TaskTimelineEntry[] {
    const chats = this.db
      .prepare("SELECT id, agent, source, body, created_at FROM messages WHERE session_id = ? AND type = 'task.chat' ORDER BY created_at ASC")
      .all<{ id: string; agent: string | null; source: string | null; body: string; created_at: number }>(`task:${taskId}`);
    const entries: TaskTimelineEntry[] = chats.map((c) => ({
      kind: 'chat' as const, id: c.id,
      author: c.source ?? (c.agent ? `agent:${c.agent}` : 'system'),
      agentId: c.agent || undefined, body: c.body, mentions: parseMentions(c.body), at: c.created_at,
    }));
    const events = this.os.tasks.withEvents(taskId)?.events ?? [];
    for (const e of events) {
      if (e.kind === 'comment') {
        entries.push({
          kind: 'chat', id: e.id, author: e.author,
          agentId: e.author.startsWith('agent:') ? e.author.slice(6) : undefined,
          body: e.body ?? '', mentions: parseMentions(e.body ?? ''), at: e.createdAt,
        });
      } else {
        entries.push({ kind: 'event', id: e.id, eventKind: e.kind, body: e.body, author: e.author, at: e.createdAt });
      }
    }
    return entries.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }

  /** How many Discussion messages `viewer` hasn't read (excluding their own posts) — the unread badge on
   *  a task card and the Discussion header. Uses the per-member `message_state` read line. */
  discussionUnread(taskId: string, viewer: Member): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages m
                  LEFT JOIN message_state ms ON ms.message_id = m.id AND ms.member_id = ?
                 WHERE m.session_id = ? AND m.type = 'task.chat'
                   AND ms.read_at IS NULL AND (m.source IS NULL OR m.source != ?)`)
      .get<{ n: number }>(viewer.id, `task:${taskId}`, viewer.id);
    return row?.n ?? 0;
  }

  /**
   * Per-task Discussion rollups for the board/list cards (unread for `viewer`, last-message preview,
   * participant set), keyed by task id.
   *
   * AGGREGATED IN SQL, and scoped to the tasks the caller is actually rendering. The row-by-row version
   * read every `task.chat` message in the tenant with its FULL body to keep only the last one per task:
   * on live instawp that was 6,879 rows / 12.6 MB materialised per poll, and it shipped **2.07 MB of the
   * 2.4 MB `/api/tasks` response** — rollups for 1,986 tasks when the board renders 500, each carrying an
   * unclipped body that the card renders as one `truncate`d line.
   *
   * @param taskIds restrict to these tasks (the page's own list). Omitted = every task, as before.
   * @param bodyClip clip the preview body to N chars (the card truncates it to one line anyway).
   */
  taskDiscussionSummaries(viewer: Member, taskIds?: string[], bodyClip?: number): Record<string, TaskDiscussionSummary> {
    // Scope clause shared by both queries. `session_id` is `task:<id>`, so an id list becomes an IN over
    // exact keys; an empty list means "nothing to render", not "everything".
    const sids = taskIds?.map((id) => `task:${id}`);
    if (sids && !sids.length) return {};
    const scope = sids ? ` AND m.session_id IN (${sids.map(() => '?').join(',')})` : '';
    const args = sids ?? [];
    // Read a PREFIX rather than the whole body — the preview is one truncated line. `clipText` collapses
    // whitespace before it counts, and collapsing only ever shortens, so a 4× prefix is what makes the
    // clipped result identical to clipping the full body (it would take >3/4 of the prefix being runs of
    // whitespace to differ). Verified byte-for-byte against the unclipped path on the live instawp board.
    const body = bodyClip && bodyClip > 0 ? `substr(m.body, 1, ${bodyClip * 4 + 16})` : 'm.body';

    const out: Record<string, TaskDiscussionSummary> = {};
    const entry = (sid: string): TaskDiscussionSummary => {
      const taskId = sid.slice('task:'.length);
      return out[taskId] ?? (out[taskId] = { unread: 0, participants: [] });
    };

    // 1. participants + unread, one row per (task, participant). `firstAt` preserves the old
    //    first-appearance ordering of the participant list, which the avatar rail reads as arrival order.
    for (const r of this.db
      .prepare(`SELECT m.session_id AS sid,
                       COALESCE(m.source, CASE WHEN m.agent IS NOT NULL THEN 'agent:' || m.agent ELSE 'system' END) AS who,
                       MIN(m.created_at) AS firstAt,
                       SUM(CASE WHEN ms.read_at IS NULL AND (m.source IS NULL OR m.source != ?) THEN 1 ELSE 0 END) AS unread
                  FROM messages m
                  LEFT JOIN message_state ms ON ms.message_id = m.id AND ms.member_id = ?
                 WHERE m.type = 'task.chat' AND m.session_id LIKE 'task:%'${scope}
                 GROUP BY sid, who
                 ORDER BY firstAt ASC`)
      .all<{ sid: string; who: string; firstAt: number; unread: number }>(viewer.id, viewer.id, ...args)) {
      const e = entry(r.sid);
      if (!e.participants.includes(r.who)) e.participants.push(r.who);
      e.unread += r.unread;
    }

    // 2. the newest message per task, for the one-line preview. Joined against each task's MAX(created_at)
    //    rather than ordering the whole table; ties (same millisecond) resolve by rowid = insertion order,
    //    which is what "last write wins" meant when this walked the rows in ASC order.
    for (const r of this.db
      .prepare(`SELECT m.session_id AS sid, ${body} AS body, m.source AS source, m.agent AS agent, m.rowid AS rid
                  FROM messages m
                  JOIN (SELECT session_id, MAX(created_at) AS mx FROM messages
                         WHERE type = 'task.chat' AND session_id LIKE 'task:%'
                         GROUP BY session_id) last
                    ON last.session_id = m.session_id AND m.created_at = last.mx
                 WHERE m.type = 'task.chat' AND m.session_id LIKE 'task:%'${scope}
                 ORDER BY m.created_at ASC, m.rowid ASC`)
      .all<{ sid: string; body: string; source: string | null; agent: string | null; rid: number }>(...args)) {
      entry(r.sid).last = {
        body: bodyClip ? clipText(r.body, bodyClip) : r.body,
        author: r.source ?? (r.agent ? `agent:${r.agent}` : 'system'),
        agentId: r.agent || undefined,
      };
    }
    return out;
  }

  /**
   * Every session that has worked a task, oldest-first — the task's RUN HISTORY.
   *
   * A task is the durable unit of work; a session is one ATTEMPT at it. The relation has always been
   * one-to-many (a crash re-dispatches, a mention spawns, a human takes over), but only the newest run
   * was reachable — `tasks.last_session_id`, the pointer the pile-up guard and the reconciler keep — so a
   * task that failed twice before succeeding read as if it had gone cleanly the first time. Nothing new is
   * stored: the runs are recovered from the two places they already leave a trace.
   *   · `dispatch` — provenance `task:<id>`, i.e. the session was spawned FOR this task.
   *   · `linked`   — a session that touched the task from elsewhere and logged an event against it (an
   *                  agent's `task_claim` from its own run, a Discussion-continued thread).
   * Archived rows are INCLUDED: soft-archiving declutters the Sessions list, it doesn't rewrite what
   * happened to a task. Liveness is one tmux poll for the whole list, not one per row.
   */
  taskRuns(taskId: string): TaskRun[] {
    const current = this.os.tasks.get(taskId)?.lastSessionId;
    const rows = this.db
      .prepare(`SELECT id, agent, tmux, status, spawned_by, outcome, report_summary, created_at, updated_at,
                       cost_usd, turns, archived_at
                  FROM term_sessions
                 WHERE spawned_by = ?
                    OR id IN (SELECT session_id FROM task_events WHERE task_id = ? AND session_id IS NOT NULL)
                    OR id = ?
                 ORDER BY created_at ASC`)
      .all<{
        id: string; agent: string; tmux: string; status: string; spawned_by: string | null;
        outcome: string | null; report_summary: string | null; created_at: number; updated_at: number | null;
        cost_usd: number | null; turns: number | null; archived_at: number | null;
      }>(`task:${taskId}`, taskId, current ?? '');
    // `aliveNames()` is null on the launcher backend / a failed poll — liveness unknown, so we trust the
    // row's own status rather than claiming a running session is dead (same rule as listSessions).
    const alive = rows.length ? this.backend.aliveNames() : null;
    return rows.map((r) => ({
      id: r.id,
      agent: r.agent,
      status: r.status,
      outcome: r.outcome ?? undefined,
      summary: r.report_summary ?? undefined,
      createdAt: r.created_at,
      endedAt: r.status === 'running' ? undefined : r.updated_at ?? undefined,
      costUsd: r.cost_usd ?? undefined,
      turns: r.turns ?? undefined,
      link: r.spawned_by === `task:${taskId}` ? 'dispatch' : 'linked',
      current: r.id === current,
      alive: r.status === 'running' && (alive ? alive.has(r.tmux) : true),
      archived: r.archived_at != null,
    }));
  }

  /**
   * Which agents have worked each task, tenant-wide — the board/list card's rollup of {@link taskRuns}.
   *
   * The card shows the ASSIGNEE, i.e. who the task was handed to. That is not who ran it: a support agent
   * that files a fix and an engineer that picks it up both leave runs on the same task, so a card could
   * name `engineer` while a completely different agent's session was the one live on it. Same two sources
   * as `taskRuns` (`task:<id>` provenance + `task_events.session_id`), folded per task in ONE pass rather
   * than one query per card — measured on the instapods tenant that's ~660 rows for the whole board.
   *
   * Returns ONLY the multi-agent tasks: with one agent the assignee badge already tells the whole story,
   * so a per-task entry there would be payload that renders nothing.
   */
  taskWorkers(): Record<string, TaskWorkers> {
    const rows = this.db
      .prepare(`SELECT task_id, agent, tmux, status FROM (
                    SELECT substr(spawned_by, 6) AS task_id, id AS sid, agent, tmux, status
                      FROM term_sessions WHERE spawned_by LIKE 'task:%'
                    UNION
                    SELECT e.task_id AS task_id, s.id AS sid, s.agent, s.tmux, s.status
                      FROM task_events e JOIN term_sessions s ON s.id = e.session_id
                     WHERE e.session_id IS NOT NULL
                  )`)
      .all<{ task_id: string; agent: string; tmux: string; status: string }>();
    if (!rows.length) return {};
    // One tmux poll for the whole board (null = unknown liveness on the launcher backend / a failed poll,
    // in which case we trust the row's own status — same rule as `taskRuns` and `listSessions`).
    const alive = this.backend.aliveNames();
    const byTask = new Map<string, Map<string, { runs: number; alive: boolean }>>();
    for (const r of rows) {
      if (!r.task_id) continue;
      const agents = byTask.get(r.task_id) ?? new Map();
      byTask.set(r.task_id, agents);
      const e = agents.get(r.agent) ?? { runs: 0, alive: false };
      e.runs++;
      if (r.status === 'running' && (alive ? alive.has(r.tmux) : true)) e.alive = true;
      agents.set(r.agent, e);
    }
    const out: Record<string, TaskWorkers> = {};
    for (const [taskId, agents] of byTask) {
      if (agents.size < 2) continue;
      out[taskId] = { agents: [...agents].map(([id, e]) => ({ id, runs: e.runs, alive: e.alive })) };
    }
    return out;
  }

  /**
   * The claude transcript a re-dispatch of this task should `--resume`, when there's one worth resuming.
   *
   * A task is the durable unit of work; a session is one attempt. Every other re-entry path (chat threads,
   * DM replies, poke-back, self-schedule) resumes the prior transcript — tasks were the exception, spawning
   * fresh with only a text summary of what a finished run concluded. This finds the MOST RECENT `task:<id>`
   * session that pinned a transcript AND was run by the agent now assigned (a transcript belongs to one
   * agent — you can't resume agent A's into agent B, so a changed assignee falls back to fresh). `uses` =
   * how many task sessions already share that transcript (1 = only the original run; each resume adds one,
   * because a resumed dispatch reuses the same `claude_session_id`), so the caller can stop reloading a
   * wedged transcript after N resumes and start clean. Undefined when nothing matches → fresh spawn.
   */
  resumableTaskTranscript(taskId: string, agentId: string): { claudeSessionId: string; uses: number } | undefined {
    const row = this.db
      .prepare(`SELECT claude_session_id AS cs FROM term_sessions
                 WHERE spawned_by = ? AND agent = ? AND claude_session_id IS NOT NULL
                 ORDER BY created_at DESC LIMIT 1`)
      .get<{ cs: string }>(`task:${taskId}`, agentId);
    if (!row?.cs) return undefined;
    const uses = this.db
      .prepare('SELECT COUNT(*) AS n FROM term_sessions WHERE spawned_by = ? AND claude_session_id = ?')
      .get<{ n: number }>(`task:${taskId}`, row.cs)?.n ?? 0;
    return { claudeSessionId: row.cs, uses };
  }

  /** Record a pending "how should @agent respond?" choice when a NON-owner agent is @mentioned — the
   *  human picks Quick answer vs New session (see docs/task-rooms-plan.md). Stored as a `task.mention`
   *  message (Discussion-only, out of the Inbox feed); returns its id. `human` = the member to address. */
  postMentionChoice(taskId: string, agentId: string, text: string, human: string): string {
    return this.addMessage({
      type: 'task.mention', sessionId: `task:${taskId}`, agent: agentId,
      title: `How should @${agentId} respond?`, body: text, status: 'open',
      args: { taskId, agentId }, audienceKind: human ? 'member' : 'admins', audienceId: human || undefined,
    });
  }

  /** The open mention-choices on a task (surfaced as a banner in the Discussion). */
  taskMentionChoices(taskId: string): { id: string; agentId: string; message: string }[] {
    return this.db
      .prepare("SELECT id, agent, body FROM messages WHERE session_id = ? AND type = 'task.mention' AND status = 'open' ORDER BY created_at ASC")
      .all<{ id: string; agent: string; body: string }>(`task:${taskId}`)
      .map((r) => ({ id: r.id, agentId: r.agent, message: r.body }));
  }

  /** Read one mention-choice (for the resolve route). */
  getMentionChoice(msgId: string): { taskId: string; agentId: string; message: string; status: string } | null {
    const r = this.db.prepare("SELECT body, status, args FROM messages WHERE id = ? AND type = 'task.mention'").get<{ body: string; status: string; args: string | null }>(msgId);
    if (!r) return null;
    let a: { taskId?: string; agentId?: string } = {};
    try { a = r.args ? JSON.parse(r.args) : {}; } catch { /* ignore */ }
    return { taskId: a.taskId ?? '', agentId: a.agentId ?? '', message: r.body, status: r.status };
  }

  /** Resolve a mention-choice (answered / rejected). */
  closeMentionChoice(msgId: string, status: 'answered' | 'rejected'): void {
    this.db.prepare("UPDATE messages SET status = ? WHERE id = ? AND type = 'task.mention'").run(status, msgId);
  }

  /** The newest pending `ask_human` question on a session, if any — so a human's plain Discussion reply
   *  can answer it (Feature: a reply feeds the live session only when a question is open). */
  pendingQuestionFor(sessionId: string): string | undefined {
    return this.db.prepare("SELECT id FROM questions WHERE run_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get<{ id: string }>(sessionId)?.id;
  }

  /** Mark a task's Discussion read for a member (per-member upsert over its `task.chat` rows). */
  markDiscussionRead(taskId: string, viewer: Member): void {
    for (const r of this.db
      .prepare("SELECT id FROM messages WHERE session_id = ? AND type = 'task.chat'")
      .all<{ id: string }>(`task:${taskId}`)) {
      this.upsertState(r.id, viewer.id, 'read_at');
    }
  }

  /** Post a proactive **insight alert** to the admins' Inbox — a session-less `notification` card the
   *  intelligence layer raises when something warrants attention (a struggling agent, recurring rejections).
   *  Keyed by `insight:<key>` so it's a stable, de-dupable row. `args.route`/`args.detail` deep-link the
   *  card to the page that acts on it (Insights / Policy / Inbox) — the card backs NO session, so without
   *  a route the console would link "Open" to the phantom `insight:<key>` session id and land on a dead
   *  terminal. */
  postInsightAlert(input: { key: string; title: string; body: string; severity: string; route: string; detail?: string }): void {
    this.addMessage({
      type: 'notification', sessionId: `insight:${input.key}`, agent: 'insights', title: input.title,
      body: input.body, status: 'open',
      args: { key: input.key, severity: input.severity, route: input.route, detail: input.detail },
      audienceKind: 'admins',
    });
  }

  /**
   * Post an inbox card about a goal — an agent's PROPOSAL (a draft an owner/admin reviews + activates) or,
   * with `type: 'goal.ready'`, a goal whose linked work has all finished and now needs its owner to sign it
   * off. Addressed to an explicit {@link Audience}. Like {@link postTaskCard} it uses the `goal:<id>`
   * sentinel for `session_id` (no session backs a goal) so visibility is governed by the audience, and
   * `args.goalId` deep-links the card to the Goals page. Public so the loopback propose route can call it.
   */
  postGoalCard(input: { goalId: string; agent: string; title: string; body: string; audience: Audience; type?: 'goal.proposed' | 'goal.ready' }): void {
    this.addMessage({
      type: input.type ?? 'goal.proposed', sessionId: `goal:${input.goalId}`, agent: input.agent, title: input.title,
      body: input.body, status: 'open', args: { goalId: input.goalId },
      audienceKind: input.audience.kind, audienceId: audienceIdOf(input.audience),
    });
  }

  /**
   * Post an owner/admin-addressed REVIEW card and fire the review notifier — the one path shared by every
   * "agent asks a human to approve X" request/proposal (`secret_request`, `skill_propose`, `skill_request`,
   * `host_propose`, `policy_propose`). Each of those used to call {@link addMessage} directly, which wrote
   * the inbox card but never pinged anyone, so a pending request sat unseen until an owner opened Settings.
   * Centralising them here means the card is written (durable, `admins` audience) AND the out-of-band DM
   * fires in ONE place — parity with how approvals/questions/tasks already reach a human. The notifier is
   * advisory: a failed push never wedges the request.
   */
  private postReviewCard(input: { type: ReviewCardKind; sessionId: string; agent: string; title: string; body: string; args?: Record<string, unknown>; summary?: string; audience?: Audience; link?: ReviewNotice['link']; quiet?: boolean }): void {
    // Providing/publishing/granting is an owner/admin act — address the review card to the admin tier by
    // default. A caller can override (e.g. a personal connection request, which only its own member can
    // complete) by passing an explicit `audience`.
    const audience: Audience = input.audience ?? { kind: 'admins' };
    this.addMessage({
      type: input.type, sessionId: input.sessionId, agent: input.agent,
      title: input.title, body: input.body, status: 'open',
      ...(input.args ? { args: input.args } : {}),
      audienceKind: audience.kind, audienceId: audienceIdOf(audience),
    });
    // `quiet`: Inbox only, no Slack/Discord DM. Every OTHER review card is an agent BLOCKED on a human —
    // it asked for a credential, a skill, a policy change, and nothing proceeds until someone answers, so
    // interrupting them is the point. A card the OS raises about its own state is not that: nobody is
    // waiting on it, it is true for as long as it is true, and it self-heals. Pushing it out-of-band adds
    // to the chat noise that already makes the signal cards easy to miss.
    if (input.quiet) return;
    try { this.reviewNotifier?.({ sessionId: input.sessionId, agent: input.agent, kind: input.type, title: input.title, summary: input.summary ?? input.body, audience, ...(input.link ? { link: input.link } : {}) }); }
    catch { /* out-of-band push is advisory — never let it wedge the request */ }
  }

  /** An agent proposed (or edited) a hosted App — post a review card so an owner/admin publishes it.
   *  Addressed to admins; the card's `slug` deep-links the console Apps page. See docs/apps-plan.md §6. */
  postAppCard(input: { slug: string; agent: string; title: string; body: string; audience?: Audience }): void {
    const audience = input.audience ?? { kind: 'admins' as const };
    this.addMessage({
      type: 'app.proposed', sessionId: `app:${input.slug}`, agent: input.agent, title: input.title,
      body: input.body, status: 'open', args: { slug: input.slug },
      audienceKind: audience.kind, audienceId: audienceIdOf(audience),
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
  askQuestion(sessionId: string, agent: string, prompt: string, to?: string, options?: string[]): { id?: string; error?: string; to?: string } {
    let target: Member | undefined;
    if (to && to.trim()) {
      target = this.resolveMember(to);
      if (!target) return { error: `no teammate matches "${to}"` };
    }
    const id = newId('question');
    this.db
      .prepare('INSERT INTO questions (id, run_id, tenant, agent, prompt, status, audience_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, this.os.tenant, agent, prompt, 'pending', target?.id ?? null, Date.now());
    // Card audience: the addressed teammate when `to` is set, else the session operator.
    const audienceKind = target ? 'member' : 'sessionOwner';
    const audienceId = target ? target.id : sessionId;
    // Multiple-choice options (if any) ride along in the message args → the card renders one-click buttons.
    const cleanOptions = options?.map((o) => o.trim()).filter(Boolean).slice(0, 8);
    this.addMessage({ type: 'question', sessionId, agent, title: `Question — ${agent}`, body: prompt, status: 'pending', questionId: id, audienceKind, audienceId, ...(cleanOptions?.length ? { args: { options: cleanOptions } } : {}) });
    this.audit(sessionId, agent, 'question.asked', { questionId: id, prompt, ...(target ? { to: target.id } : {}) });
    // Out-of-band ping (like approvals): DM the person the run acts for — or the addressed teammate — so a
    // blocking `ask` doesn't sit unseen in the console. And if the run was triggered from chat, mirror the
    // question into that thread. Both best-effort, off the hot path.
    try { this.questionNotifier?.({ questionId: id, sessionId, agent, prompt, to: target?.id }); } catch { /* notifications are advisory */ }
    try { this.chatMirror?.(sessionId, (p) => `❓ ${agent} needs your input:\n${prompt}\n\nAnswer in the ${chatLink(p, consolePage(this.publicOrigin, 'inbox'), 'Agentric Inbox')}.`); } catch { /* advisory */ }
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

  /** Bind a pending question to a Slack/Discord DM recipient, so a reply in that DM can answer it (the
   *  inbound-reply path). Called by the question notifier once per provider it DM'd. */
  bindQuestionDm(questionId: string, provider: 'slack' | 'discord' | 'telegram', externalId: string, memberId?: string): void {
    if (!questionId || !externalId) return;
    this.db
      .prepare('INSERT OR REPLACE INTO question_dms (question_id, tenant, provider, external_id, member_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(questionId, this.os.tenant, provider, externalId, memberId ?? null, Date.now());
  }

  /**
   * Answer a pending question from an inbound Slack/Discord DM reply. Matches the sender (`provider` +
   * their `externalId`) to the newest still-pending question we DM'd them, verifies they may act on it,
   * and records the answer (attributed to their member email — same as the web Inbox path). Returns the
   * answered question's agent on success, or `null` when nothing pending is bound to this sender (so the
   * caller falls through to the normal chat router — a DM that isn't answering a question is just a chat).
   */
  answerQuestionFromChat(provider: 'slack' | 'discord' | 'telegram', externalId: string, answer: string): { agent: string } | null {
    const body = (answer || '').trim();
    if (!body || !externalId) return null;
    const row = this.db
      .prepare(
        `SELECT qd.question_id AS qid, q.agent AS agent
           FROM question_dms qd JOIN questions q ON q.id = qd.question_id
          WHERE qd.provider = ? AND qd.external_id = ? AND q.status = 'pending'
          ORDER BY qd.created_at DESC LIMIT 1`,
      )
      .get<{ qid: string; agent: string }>(provider, externalId);
    if (!row) return null;
    // Defense in depth: the binding already implies this member was the addressee, but re-check they may
    // act on it (mirrors the web route's canViewQuestion gate) before writing the answer.
    const member = this.os.team.memberByExternalId(provider, externalId);
    if (!member || !this.canViewQuestion(row.qid, member)) return null;
    if (!this.answerQuestion(row.qid, body, member.email)) return null;
    this.audit(this.questionRunId(row.qid) ?? row.qid, member.email, 'question.answered.viaDm', { questionId: row.qid, provider });
    return { agent: row.agent };
  }

  /** The session id a question belongs to (for audit attribution on the DM-answer path). */
  private questionRunId(questionId: string): string | undefined {
    return this.db.prepare('SELECT run_id FROM questions WHERE id = ?').get<{ run_id: string }>(questionId)?.run_id;
  }

  /** Bind a pending approval to a Slack/Discord DM recipient, so a reply in that DM can resolve it — the
   *  approval-side twin of {@link bindQuestionDm}. Called by the approval notifier once per approver ×
   *  provider it DM'd. Keyed on (approval, provider, external_id) so several approvers can each be bound. */
  bindApprovalDm(approvalId: string, provider: 'slack' | 'discord' | 'telegram', externalId: string, memberId?: string): void {
    if (!approvalId || !externalId) return;
    this.db
      .prepare('INSERT OR REPLACE INTO approval_dms (approval_id, tenant, provider, external_id, member_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(approvalId, this.os.tenant, provider, externalId, memberId ?? null, Date.now());
  }

  /**
   * Resolve a pending approval from an inbound Slack/Discord DM reply — the approval-side twin of
   * {@link answerQuestionFromChat}. Matches the sender to the newest still-pending approval we DM'd them,
   * reads their reply as an approve/deny intent, re-checks they may clear that level (`canApprove`), and
   * settles the gate (attributed to their member email — same as the web route). Returns:
   *  - `null`               — nothing pending is bound to this sender ⇒ the caller falls through to the
   *                           question/chat router (an ordinary DM is just a chat).
   *  - `{ status:'unclear' }`   — a pending approval IS bound but the reply isn't a clear yes/no ⇒ the
   *                           caller asks them to reply "approve"/"deny" (does NOT fall through — we know
   *                           they're mid-approval, so treating it as fresh chat would be wrong).
   *  - `{ status:'forbidden' }` — bound, but the sender can no longer approve this level (role changed).
   *  - `{ status:'decided', … }` — the gate was settled; `approved` + `capability` for the ack.
   */
  decideApprovalFromChat(provider: 'slack' | 'discord' | 'telegram', externalId: string, text: string):
    | { status: 'decided'; approved: boolean; capability: string }
    | { status: 'unclear' }
    | { status: 'forbidden' }
    | null {
    if (!externalId) return null;
    const row = this.db
      .prepare(
        `SELECT ad.approval_id AS aid, a.run_id AS runId, a.capability AS capability, a.level AS level
           FROM approval_dms ad JOIN approvals a ON a.id = ad.approval_id
          WHERE ad.provider = ? AND ad.external_id = ? AND a.status = 'pending'
          ORDER BY ad.created_at DESC LIMIT 1`,
      )
      .get<{ aid: string; runId: string; capability: string; level: ApprovalLevel }>(provider, externalId);
    if (!row) return null;
    // A pending approval is bound to this sender — read their reply as a decision.
    const intent = parseApprovalIntent(text);
    if (!intent) return { status: 'unclear' };
    // Defense in depth: the binding implies they were in the approver audience, but re-check they may
    // still clear this level before settling (mirrors the web route's canApprove gate).
    const member = this.os.team.memberByExternalId(provider, externalId);
    if (!member || !this.os.team.canApprove(member, row.level)) return { status: 'forbidden' };
    const approved = intent === 'approve';
    this.os.approvals.resolve(row.aid, approved, member.email); // no-op if already decided (console race)
    this.audit(row.runId, member.email, 'approval.decided.viaDm', { approvalId: row.aid, approved, provider });
    return { status: 'decided', approved, capability: row.capability };
  }

  /**
   * Bind a SESSION to the Slack/Discord DM we just sent someone about it, so a reply in that DM reaches
   * the run — the general-case twin of {@link bindQuestionDm}/{@link bindApprovalDm}, for the notices that
   * carry no pending decision (an agent's `notify`, a run finished/crashed). Called by those notifiers
   * once per recipient × provider they DM'd. Re-binding the same (session, recipient) REPLACES the row,
   * which deliberately re-arms the staleness window: each new ping about a run makes it the live
   * conversation again.
   */
  bindSessionDm(sessionId: string, provider: 'slack' | 'discord' | 'telegram', externalId: string, memberId?: string): void {
    if (!sessionId || !externalId) return;
    this.db
      .prepare('INSERT OR REPLACE INTO session_dms (session_id, tenant, provider, external_id, member_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, this.os.tenant, provider, externalId, memberId ?? null, Date.now());
  }

  /**
   * The session an inbound DM from this sender should continue: the most recent run we DM'd them about
   * within {@link SESSION_DM_WINDOW_MS}, provided it's still resumable and they may still see it. The
   * thread-continuity lookup ({@link sessionForSlackThread}) keyed on a channel+thread; a DM has no thread
   * to key on, so the binding IS the key. Undefined → nothing claims this DM and the caller falls through
   * to the approval/question/router path exactly as before, which is the safe default: a wrong match here
   * would put a person's words into an agent they weren't talking to.
   *
   * Excludes archived runs (a filed-away session isn't a live conversation) and unresumable ones (no
   * pinned claude id ⇒ reviving would start a blank transcript, which is what a fresh spawn already does
   * better). Visibility is re-checked against the CURRENT member — the binding proves we DM'd them, not
   * that they're still on the team or still assigned.
   */
  sessionForDm(provider: 'slack' | 'discord' | 'telegram', externalId: string, now = Date.now()):
    { sessionId: string; agent: string; runAs?: string; claudeSessionId?: string } | undefined {
    if (!externalId) return undefined;
    const row = this.db
      .prepare(
        `SELECT sd.session_id AS id, t.agent AS agent, t.run_as AS runAs, t.claude_session_id AS claudeSessionId,
                t.spawned_by AS spawnedBy
           FROM session_dms sd JOIN term_sessions t ON t.id = sd.session_id
          WHERE sd.provider = ? AND sd.external_id = ? AND sd.created_at >= ?
            AND t.archived_at IS NULL AND t.claude_session_id IS NOT NULL
          ORDER BY sd.created_at DESC LIMIT 1`,
      )
      .get<{ id: string; agent: string; runAs: string | null; claudeSessionId: string | null; spawnedBy: string | null }>(
        provider, externalId, now - SESSION_DM_WINDOW_MS,
      );
    if (!row) return undefined;
    const member = this.os.team.memberByExternalId(provider, externalId);
    if (!member || !this.canViewRow(row.spawnedBy, row.runAs, member)) return undefined;
    return { sessionId: row.id, agent: row.agent, runAs: row.runAs ?? undefined, claudeSessionId: row.claudeSessionId ?? undefined };
  }

  /**
   * Point a session's native chat egress at a DM channel, so the agent's replies land where the human is
   * actually talking. `INSERT OR IGNORE` on a `session_id`-keyed table means this NEVER steals a session
   * that already replies somewhere — a run triggered from a channel thread keeps answering in that thread,
   * and only a run with no chat binding at all (console-spawned, automation, task) adopts the DM. With the
   * binding in place the chat mirror reaches the DM immediately, and the native `slack_reply`/
   * `discord_reply` tools are exposed the next time the row relaunches (`reviveResident` derives their env
   * flags from exactly these tables).
   */
  bindReplyChannel(sessionId: string, provider: 'slack' | 'discord' | 'telegram', channel: string): void {
    if (!sessionId || !channel) return;
    if (provider === 'slack') {
      this.db.prepare('INSERT OR IGNORE INTO slack_threads (session_id, channel, thread_ts, created_at) VALUES (?, ?, ?, ?)')
        .run(sessionId, channel, '', Date.now());
    } else if (provider === 'telegram') {
      // `channel` is the Telegram chat id (a private chat → the sender's user id). No forum topic /
      // reply-target on a DM adoption, so both are ''.
      this.db.prepare('INSERT OR IGNORE INTO telegram_threads (session_id, chat_id, message_thread_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(sessionId, channel, '', '', Date.now());
    } else {
      this.db.prepare('INSERT OR IGNORE INTO discord_threads (session_id, channel, message_id, created_at) VALUES (?, ?, ?, ?)')
        .run(sessionId, channel, '', Date.now());
    }
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

  /**
   * Ask another AGENT a question / to solve something and block on the answer — the machine-facing
   * sibling of {@link askQuestion}. Spawns a one-off HEADLESS governed session of `targetAgent` (run-as
   * passthrough, provenance `ask:<caller>`, every effect still gated) primed with the question; the
   * delegate answers via the `answer` tool (→ {@link answerAgentAsk}) and the caller polls
   * {@link agentAskStatus}. An ephemeral request/response — no task row, no board/inbox surface.
   * Returns `{ error }` for an unknown/ineligible target.
   */
  askAgent(callerSession: string, callerAgent: string, targetAgent: string, question: string, goal?: string): { id?: string; error?: string } {
    const target = (targetAgent || '').trim();
    if (!target) return { error: 'which agent? (agent is required)' };
    if (target === callerAgent) return { error: 'an agent cannot ask itself — pick a different teammate' };
    const manifest = this.os.agents.get(target);
    if (!manifest) return { error: `unknown agent: ${target}` };
    if (!isCodingRuntime(manifest.runtime)) return { error: `${target} is not an interactive agent that can answer` };
    // Run-as passthrough: the delegate acts AS the caller's accountable human, so budget/approvals/identity
    // ladder to the same person the caller already answers to (mirrors task-owner passthrough).
    const runAs = this.db.prepare('SELECT run_as FROM term_sessions WHERE id = ?').get<{ run_as: string | null }>(callerSession)?.run_as ?? undefined;
    const id = newId('agentAsk');
    this.db
      .prepare('INSERT INTO agent_asks (id, tenant, caller_run_id, caller_agent, target_agent, question, status, run_as, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, this.os.tenant, callerSession, callerAgent, target, question, 'pending', runAs ?? null, Date.now());
    // Provenance `ask:<caller>` makes the delegate an ask-answerer at launch (→ ASK_ANSWER exposes the
    // `answer` tool); run-as passes the accountable human through. Headless one-off — reaped at turn end.
    // A `goal` (when the installed claude supports `/goal`) opens the prompt under a convergence condition
    // so the delegate works to the objective before answering — the taskless "delegate with a goal" path.
    // An over-limit goal would make the `claude` CLI hard-reject the run ("Goal condition is limited to
    // 4000 characters" — counting the WHOLE payload after `/goal `, not just this string); the builder
    // measures the full payload and falls back to a plain prompt (question still carries the objective).
    const goalMode = !!(goal && goal.trim()) && claudeSupportsGoal();
    const s = this.createSession(target, `Ask ← ${callerAgent}`, buildAskAgentPrompt(id, callerAgent, question, goalMode ? goal!.trim() : undefined), `ask:${callerAgent}`, true, undefined, undefined, runAs);
    this.db.prepare('UPDATE agent_asks SET delegate_run_id = ? WHERE id = ?').run(s.id, id);
    this.audit(callerSession, callerAgent, 'agent.asked', { askId: id, target, delegate: s.id, runAs: runAs ?? null });
    return { id };
  }

  /** The delegate answers a pending ask (its `answer` tool). Resolves the ask bound to THIS delegate
   *  session — so the delegate can't spoof which ask it answers. Errors if none is pending for it. */
  answerAgentAsk(delegateSession: string, agent: string, answer: string): { ok?: boolean; error?: string } {
    const a = this.db
      .prepare("SELECT id, caller_agent FROM agent_asks WHERE delegate_run_id = ? AND status = 'pending'")
      .get<{ id: string; caller_agent: string }>(delegateSession);
    if (!a) return { error: 'no pending ask is bound to this session' };
    this.db.prepare("UPDATE agent_asks SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?").run(answer, Date.now(), a.id);
    this.audit(delegateSession, agent, 'agent.answered', { askId: a.id, caller: a.caller_agent });
    return { ok: true };
  }

  /**
   * Poll an ask's state (the caller's `ask_agent` loop). Self-heals: if the delegate session ended or
   * died WITHOUT answering (past {@link ASK_AGENT_GRACE_MS} so a just-spawned run isn't misjudged), the
   * ask flips to `failed` — so the caller unblocks instead of waiting out its timeout on a dead delegate.
   */
  agentAskStatus(id: string): { status: 'pending' | 'answered' | 'failed'; answer?: string } {
    const a = this.db
      .prepare('SELECT status, answer, delegate_run_id, created_at FROM agent_asks WHERE id = ?')
      .get<{ status: string; answer: string | null; delegate_run_id: string | null; created_at: number }>(id);
    if (!a) return { status: 'failed' };
    if (a.status === 'answered') return { status: 'answered', answer: a.answer ?? undefined };
    if (a.status === 'failed') return { status: 'failed' };
    // `reachable`, not the row: a delegate that answered with `report` and is still finishing up is not a
    // dead delegate, and grading it `failed` would unblock the caller with a lie.
    if (a.delegate_run_id && Date.now() - a.created_at > ASK_AGENT_GRACE_MS && !this.reachable(a.delegate_run_id)) {
      this.db.prepare("UPDATE agent_asks SET status = 'failed' WHERE id = ? AND status = 'pending'").run(id);
      return { status: 'failed' };
    }
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
    // Blocked on a human is, by definition, NOT generating — so this is a turn-END signal as much as it
    // is a bell, and it's the only one we get for a turn the user INTERRUPTED (Esc / Ctrl-C fires no
    // `Stop`, no `StopFailure`, no `SessionEnd` — there is no interrupt hook at all, see
    // anthropics/claude-code#9516). Without this clear, an interrupted session sat on the console reading
    // "working" until the 2h wedged-turn ceiling. `idle_prompt` is what claude raises once the TUI has
    // been sitting at its prompt — including the "Interrupted · What should Claude do instead?" prompt.
    this.clearTurnBusy(sessionId);
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
    outcome = normalizeOutcome(outcome);
    this.clearNotifications(sessionId);
    this.addMessage({ type: 'completed', sessionId, agent, title: `Completed — ${agent}`, body: summary || '(no summary)', status: 'open', outcome, audienceKind: 'sessionOwner', audienceId: sessionId });
    // A task-dispatched run signs off IN its task's Discussion too (§3.2), so the delegate's closing note
    // lands in the thread the humans + other agents are watching (the owner still gets the completed card).
    const reportTaskId = this.taskForSession(sessionId);
    if (reportTaskId) this.postTaskMessage({ taskId: reportTaskId, author: `agent:${agent}`, agent, body: summary || `Finished (${outcome}).` });
    this.fireSessionEvent(sessionId, agent, 'completed', `Completed — ${agent}`, summary || `Finished (${outcome}).`);
    // Close the chat loop: a chat-triggered run's completion goes back to the thread the human pinged
    // from, not just the console. No-op for non-chat runs. The agent's own `slack_reply`/`discord_reply`
    // still work for finer-grained replies; this guarantees the outcome lands even if it never called them.
    const mark = outcome === 'success' ? '✅' : outcome === 'failure' ? '❌' : '☑️';
    const inboxLink = consolePage(this.publicOrigin, 'inbox');
    try { this.chatMirror?.(sessionId, (p) => `${mark} ${agent} finished (${outcome}).\n${summary || '(no summary)'}\n${chatLink(p, inboxLink, 'Open in Agentric')}`); } catch { /* advisory */ }
    // Rename the session from the agent's own summary — an AI-written label that reflects what the run
    // actually did, replacing the provisional title (the task text / automation name set at spawn).
    // Claude Code's internal /resume summaries aren't available for governed sessions (headless `-p`
    // never persists one), so the agent's report is the reliable source. Skip when empty so a good
    // title isn't blanked.
    const aiTitle = titleFromSummary(summary);
    if (aiTitle) this.db.prepare("UPDATE term_sessions SET title = ?, status = 'done', busy_since = NULL, updated_at = ? WHERE id = ?").run(aiTitle, Date.now(), sessionId);
    else this.db.prepare("UPDATE term_sessions SET status = 'done', busy_since = NULL, updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
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

  /** Agent proposes a skill (Lever 6 — the fleet drafting its own procedural memory). Two lanes on one
   *  tool, chosen by whether the name is already in the library:
   *   • NEW name → drafts a `.aos-proposed` skill (never materialised until a human publishes it).
   *   • EXISTING name → proposes an EDIT: parked next to the library, the live skill untouched, until an
   *     owner/admin applies it. (Refining your own unpublished draft rewrites it in place — nothing is
   *     live, so there's nothing to gate.)
   *  Either way a 'skill.proposed' card lands in the Inbox and the act is audited. Returns a structured
   *  result including the human-facing `message` (composed HERE, not in the MCP process, which outlives
   *  a server upgrade) — bad names / a teammate's un-reviewed edit come back as `ok:false`. */
  proposeSkill(sessionId: string, agent: string, input: { name: string; description: string; body: string; rationale?: string }): { ok: boolean; skill?: string; mode?: 'new' | 'edit' | 'draft'; message?: string; error?: string } {
    const exists = !!this.os.skills.get((input.name || '').trim().toLowerCase());
    try {
      if (exists) {
        const { applied, skill } = this.os.skills.proposeEdit({ name: input.name, description: input.description, body: input.body, rationale: input.rationale, agent, session: sessionId });
        if (applied) {
          this.audit(sessionId, agent, 'skill.draft.updated', { name: skill.name, rationale: input.rationale });
          return { ok: true, skill: skill.name, mode: 'draft', message: `Updated your unpublished draft "${skill.name}". It is still NOT active — an owner/admin has to publish it before any agent can use it.` };
        }
        this.postReviewCard({
          type: 'skill.proposed', sessionId, agent,
          title: `Skill edit proposed — ${skill.name}`,
          body: (input.rationale || input.description || `${agent} proposes an update to the "${skill.name}" skill.`).trim(),
          args: { skill: skill.name, edit: true, ...(input.rationale ? { rationale: input.rationale } : {}) },
        });
        this.audit(sessionId, agent, 'skill.edit.proposed', { name: skill.name, rationale: input.rationale });
        return { ok: true, skill: skill.name, mode: 'edit', message: `Proposed an EDIT to the existing skill "${skill.name}". The live skill is UNCHANGED — your version is parked in the inbox for an owner/admin to review and apply.` };
      }
      const s = this.os.skills.propose({ name: input.name, description: input.description, body: input.body, rationale: input.rationale, agent, session: sessionId });
      this.postReviewCard({
        type: 'skill.proposed', sessionId, agent,
        title: `Skill proposed — ${s.name}`,
        body: (input.description || s.description || `A new skill "${s.name}" is ready for review.`).trim(),
        args: { skill: s.name, ...(input.rationale ? { rationale: input.rationale } : {}) },
      });
      this.audit(sessionId, agent, 'skill.proposed', { name: s.name, description: s.description, rationale: input.rationale });
      return { ok: true, skill: s.name, mode: 'new', message: `Proposed skill "${s.name}" — a draft in the inbox for an owner/admin to review and publish. It won't be active until then.` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The full text of a library skill, for the `skill_get` tool — what an agent reads BEFORE proposing an
   *  edit, so it revises the real thing instead of rewriting from memory. Returns the live SKILL.md plus
   *  whether an edit is already parked (proposing over a teammate's un-reviewed one is refused). */
  readSkill(agent: string, name: string): { ok: boolean; skill?: { name: string; description: string; content: string; active: boolean; proposed: boolean; pending?: { agent?: string; at: number } }; error?: string } {
    const s = this.os.skills.get((name || '').trim().toLowerCase());
    if (!s) return { ok: false, error: `no skill named "${name}" — list what exists with skill_find` };
    return {
      ok: true,
      skill: {
        name: s.name,
        description: s.description,
        content: s.content,
        active: !s.proposed && (s.agents.length === 0 || s.agents.includes(agent)),
        proposed: s.proposed,
        ...(s.pending ? { pending: { agent: s.pending.agent, at: s.pending.at } } : {}),
      },
    };
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
      this.postReviewCard({
        type: 'host.proposed', sessionId, agent,
        title: `Host proposed — ${h.name}`,
        body: `${agent} proposes reaching ${h.match} (${h.protocol}). ${input.rationale ? 'Why: ' + input.rationale : ''}`.trim(),
        args: { host: h.id, match: h.match, protocol: h.protocol, ...(input.rationale ? { rationale: input.rationale } : {}) },
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
    this.postReviewCard({
      type: 'skill.request', sessionId, agent,
      title: `Skill requested — ${name}`,
      body: (input.rationale?.trim() || description || `${agent} wants the "${name}" skill installed${remote ? ` from ${source}` : ''}.`).trim(),
      args: { skill: name, source, ...(path ? { path } : {}), ...(input.rationale ? { rationale: input.rationale } : {}) },
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

  /** Mark the open 'skill.proposed' review card(s) for a skill resolved once a human acted on it —
   *  published/dismissed a proposed DRAFT, or applied/discarded a proposed EDIT. Unlike `skill.request`
   *  (approved by card id) the skills console acts on the SKILL, not the card, so the card is found by
   *  its payload: `args.skill` plus the `edit` flag that tells the two lanes apart. Without this the
   *  card sat "awaiting review" in the Inbox forever after the human had already merged it. Returns how
   *  many cards were closed. */
  resolveSkillProposals(skill: string, lane: 'new' | 'edit', status: 'approved' | 'rejected'): number {
    const rows = this.db
      .prepare(`SELECT id, args FROM messages WHERE type = 'skill.proposed' AND status = 'open'`)
      .all<{ id: string; args: string | null }>();
    const upd = this.db.prepare(`UPDATE messages SET status = ? WHERE id = ? AND type = 'skill.proposed'`);
    let closed = 0;
    for (const r of rows) {
      let a: Record<string, unknown> = {};
      try { a = r.args ? JSON.parse(r.args) : {}; } catch { /* tolerate a corrupt payload */ }
      if (String(a.skill ?? '') !== skill) continue;
      if ((a.edit === true ? 'edit' : 'new') !== lane) continue;
      upd.run(status, r.id); closed++;
    }
    return closed;
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

  /** Principals in this tenant's vault that currently hold `key` — metadata only, never a value. */
  private secretPrincipals(key: string): string[] {
    return this.os.secrets.list(this.os.tenant).filter((s) => s.key === key).map((s) => s.principal);
  }

  /**
   * Agent asks a human about a credential KEY it needs (the `secret_request` tool). Auto-detects three
   * modes so the agent doesn't have to know which case it's in:
   *   • **provide** — the key isn't in the vault at all: a human types the value into a secure form
   *     (encrypted at rest) instead of the agent asking them to paste the raw secret into the session
   *     transcript. The inverse of {@link putSecret} (which is an agent handing over a value it HAS).
   *   • **access** — the key already EXISTS in the vault but under a principal this agent can't read
   *     (another agent / a member / a non-shared scope): a human GRANTS access, and the server re-scopes
   *     the existing sealed value to this agent — no value is ever re-typed or exposed.
   *   • **rotate** — the agent CAN read the key but the value is dead (expired token, revoked key): a
   *     human types a REPLACEMENT. Without this the `exists` short-circuit below answers "you already
   *     have this" — useless precisely when the value it has is what's broken, leaving delete-then-add
   *     by a human as the only route. Reached only on an explicit `rotate`, so a merely forgetful agent
   *     is still short-circuited rather than nagging someone.
   * Either way it never carries a value — only the KEY and why. Short-circuits if the agent can already
   * resolve the key (it has access) or an identical request is already open, else posts an owner/admin
   * 'secret.request' card tagged with the detected `mode` and audits `secret.requested`. A human resolves
   * it via POST /api/secrets/requests/:id/fulfill. */
  requestSecret(
    sessionId: string,
    agent: string,
    key: string,
    reasoning?: string,
    opts: { rotate?: boolean } = {},
  ): { ok: boolean; status?: 'requested' | 'exists' | 'duplicate'; mode?: SecretRequestMode; locations?: string[]; error?: string } {
    const k = (key || '').trim();
    if (!k) return { ok: false, error: 'a secret key is required' };
    // Where the key lives today decides the mode — and, for a rotation, which rows the replacement lands
    // on (the fulfill route re-derives this rather than trusting the card, which can be hours stale).
    const locations = this.secretPrincipals(k);
    // A rotate for a key the vault doesn't hold has nothing to replace, so it degrades to a provide.
    const rotating = opts.rotate === true && locations.length > 0;
    // Already resolvable for this agent (its own principal or the shared `*`) → no need to ask a human.
    if (!rotating && this.os.secrets.getSync(this.os.tenant, agent, k) !== undefined) return { ok: true, status: 'exists' };
    const mode: SecretRequestMode = rotating ? 'rotate' : locations.length ? 'access' : 'provide';
    // Dedupe against an already-open request for the same key from the same agent.
    const open = this.db
      .prepare(`SELECT 1 FROM messages WHERE type = 'secret.request' AND status = 'open' AND agent = ? AND json_extract(args, '$.key') = ?`)
      .get(agent, k);
    if (open) return { ok: true, status: 'duplicate', mode };
    const defaultBody = mode === 'rotate'
      ? `${agent} reports the current value of "${k}" is being rejected and needs replacing.`
      : mode === 'access'
        ? `${agent} is requesting access to the existing credential "${k}".`
        : `${agent} needs the credential "${k}" to continue.`;
    const title = mode === 'rotate'
      ? `Secret rotation requested — ${k}`
      : mode === 'access' ? `Secret access requested — ${k}` : `Secret requested — ${k}`;
    this.postReviewCard({
      type: 'secret.request', sessionId, agent,
      title,
      body: (reasoning?.trim() || defaultBody).trim(),
      args: { key: k, mode, ...(mode === 'rotate' ? { locations } : {}), ...(reasoning ? { reasoning } : {}) },
    });
    this.audit(sessionId, agent, 'secret.requested', { key: k, mode, ...(mode === 'rotate' ? { locations } : {}), reasoning });
    return { ok: true, status: 'requested', mode, ...(mode === 'rotate' ? { locations } : {}) };
  }

  /** Read a 'secret.request' card's payload (for the fulfill/dismiss routes). undefined if not one.
   *  `mode` is 'access' (grant an existing key), 'rotate' (replace a rejected value) or 'provide' (a
   *  human enters a new value). */
  secretRequestCard(id: string): { key: string; agent: string; mode: SecretRequestMode; reasoning?: string; status: string } | undefined {
    const row = this.db
      .prepare(`SELECT agent, args, status FROM messages WHERE id = ? AND type = 'secret.request'`)
      .get<{ agent: string; args: string | null; status: string }>(id);
    if (!row) return undefined;
    let a: Record<string, unknown> = {};
    try { a = row.args ? JSON.parse(row.args) : {}; } catch { /* tolerate a corrupt payload */ }
    return { key: String(a.key ?? ''), agent: row.agent, mode: parseSecretRequestMode(a.mode), reasoning: a.reasoning ? String(a.reasoning) : undefined, status: row.status };
  }

  /** Mark a 'secret.request' card resolved once a human fulfilled (provided/granted) or dismissed it. */
  setSecretRequestStatus(id: string, status: 'fulfilled' | 'rejected'): void {
    this.db.prepare(`UPDATE messages SET status = ? WHERE id = ? AND type = 'secret.request'`).run(status, id);
  }

  /** Open (unresolved) secret.request cards — the Secrets settings page's agent-request review section. */
  openSecretRequests(): { id: string; key: string; agent: string; mode: SecretRequestMode; locations?: string[]; reasoning?: string; createdAt: number }[] {
    return this.db
      .prepare(`SELECT id, agent, args, created_at FROM messages WHERE type = 'secret.request' AND status = 'open' ORDER BY created_at DESC`)
      .all<{ id: string; agent: string; args: string | null; created_at: number }>()
      .map((r) => {
        let a: Record<string, unknown> = {};
        try { a = r.args ? JSON.parse(r.args) : {}; } catch { /* tolerate corrupt payload */ }
        const key = String(a.key ?? '');
        const mode = parseSecretRequestMode(a.mode);
        // A rotation's blast radius (which principals get overwritten) is re-derived live, not read off
        // the card — the vault can have changed since the agent asked.
        const locations = mode === 'rotate' ? this.secretPrincipals(key) : undefined;
        return { id: r.id, key, agent: r.agent, mode, locations, reasoning: a.reasoning ? String(a.reasoning) : undefined, createdAt: r.created_at };
      });
  }

  /**
   * Agent asks a human to connect a Composio app (the `connection_request` tool) — the connection twin of
   * {@link requestSecret}. The agent carries only the intent (toolkit + why + scope), never a credential; a
   * human completes the OAuth. Scope defaults to **personal** (the run's own member — their own account),
   * and is `company` only when the app is a shared org resource. The already-connected / no-API-key checks
   * live in the async route (they hit Composio); this just dedupes an identical open request, posts the
   * review card — addressed to the run's MEMBER for personal (only they can OAuth their own account) or the
   * `admins` tier for company — and audits `connection.requested`. `member` is the run-as member id, set
   * for personal requests. A human resolves it via POST /api/connections/requests/:id/fulfill. */
  requestConnection(
    sessionId: string,
    agent: string,
    input: { toolkit: string; scope: 'personal' | 'company'; member?: string; reasoning?: string },
  ): { ok: boolean; status?: 'requested' | 'duplicate'; error?: string } {
    const toolkit = (input.toolkit || '').trim().toLowerCase();
    if (!toolkit) return { ok: false, error: 'a toolkit slug is required' };
    const scope = input.scope === 'company' ? 'company' : 'personal';
    // Dedupe against an already-open request for the same toolkit+scope from the same agent.
    const open = this.db
      .prepare(`SELECT 1 FROM messages WHERE type = 'connection.request' AND status = 'open' AND agent = ? AND json_extract(args, '$.toolkit') = ? AND json_extract(args, '$.scope') = ?`)
      .get(agent, toolkit, scope);
    if (open) return { ok: true, status: 'duplicate' };
    const audience: Audience = scope === 'company' || !input.member
      ? { kind: 'admins' }
      : { kind: 'member', id: input.member };
    this.postReviewCard({
      type: 'connection.request', sessionId, agent,
      title: `Connection requested — ${toolkit} (${scope})`,
      body: (input.reasoning?.trim() || `${agent} needs a ${scope} connection to ${toolkit}.`).trim(),
      args: { toolkit, scope, ...(input.member ? { member: input.member } : {}), ...(input.reasoning ? { reasoning: input.reasoning } : {}) },
      audience,
    });
    this.audit(sessionId, agent, 'connection.requested', { toolkit, scope, member: input.member, reasoning: input.reasoning });
    return { ok: true, status: 'requested' };
  }

  /** Read a 'connection.request' card's payload (for the fulfill/dismiss routes). undefined if not one.
   *  `member` is the run-as member id for a personal request (whose account it is), empty for company. */
  connectionRequestCard(id: string): { toolkit: string; scope: 'personal' | 'company'; member: string; agent: string; reasoning?: string; status: string } | undefined {
    const row = this.db
      .prepare(`SELECT agent, args, status FROM messages WHERE id = ? AND type = 'connection.request'`)
      .get<{ agent: string; args: string | null; status: string }>(id);
    if (!row) return undefined;
    let a: Record<string, unknown> = {};
    try { a = row.args ? JSON.parse(row.args) : {}; } catch { /* tolerate a corrupt payload */ }
    return { toolkit: String(a.toolkit ?? ''), scope: a.scope === 'company' ? 'company' : 'personal', member: String(a.member ?? ''), agent: row.agent, reasoning: a.reasoning ? String(a.reasoning) : undefined, status: row.status };
  }

  /** Mark a 'connection.request' card resolved once a human fulfilled (connected) or dismissed it. */
  setConnectionRequestStatus(id: string, status: 'fulfilled' | 'rejected'): void {
    this.db.prepare(`UPDATE messages SET status = ? WHERE id = ? AND type = 'connection.request'`).run(status, id);
  }

  /** Open (unresolved) connection.request cards — the Connections page's agent-request review section.
   *  `forMember`, when set, narrows to the personal requests addressed to that member (a non-admin viewer
   *  sees only their own); admins pass it undefined to see every open request. */
  openConnectionRequests(forMember?: string): { id: string; toolkit: string; scope: 'personal' | 'company'; member: string; agent: string; reasoning?: string; createdAt: number }[] {
    return this.db
      .prepare(`SELECT id, agent, args, created_at FROM messages WHERE type = 'connection.request' AND status = 'open' ORDER BY created_at DESC`)
      .all<{ id: string; agent: string; args: string | null; created_at: number }>()
      .map((r) => {
        let a: Record<string, unknown> = {};
        try { a = r.args ? JSON.parse(r.args) : {}; } catch { /* tolerate corrupt payload */ }
        return { id: r.id, toolkit: String(a.toolkit ?? ''), scope: a.scope === 'company' ? 'company' as const : 'personal' as const, member: String(a.member ?? ''), agent: r.agent, reasoning: a.reasoning ? String(a.reasoning) : undefined, createdAt: r.created_at };
      })
      .filter((r) => forMember === undefined || (r.scope === 'personal' && r.member === forMember));
  }

  /** Live governance thresholds (the numeric caps the never-tier rules read), for the proposal
   *  monotonicity sweep — same source the policy engine resolves `$moneyCapUsd` etc. from. */
  private governanceThresholds(): Record<string, number> {
    return this.os.settings.governanceThresholds() as unknown as Record<string, number>;
  }

  /**
   * An agent PROPOSES a constrained policy change (`policy_propose`) — the governance counterpart of
   * `skill_propose`/`host_propose`. TIGHTEN-ONLY: `applyProposal` refuses anything that would loosen a
   * guardrail, touch a hard-deny, or change the default, so the proposal is validated up front and the
   * agent gets immediate feedback. A valid proposal is stored as an owner-addressed `policy.proposal`
   * inbox card carrying the delta + a before→after preview; NOTHING is applied until an owner approves
   * (POST /api/policy/proposals/:id/approve). Deduped against an identical still-open proposal.
   */
  proposePolicy(sessionId: string, agent: string, delta: PolicyDelta, rationale?: string): { ok: boolean; preview?: string; error?: string } {
    if (!(this.os.policy instanceof JsonPolicyEngine)) return { ok: false, error: 'the active policy engine is not editable, so it cannot take proposals' };
    const thresholds = this.governanceThresholds();
    const res = applyProposal(this.os.policy.document, delta, thresholds);
    if ('error' in res) return { ok: false, error: res.error };
    const desc = describeProposal(this.os.policy.document, delta, thresholds);
    const preview = 'preview' in desc ? desc.preview : undefined;
    // Cap the queue and dedupe an identical open proposal from this agent (mirrors the secret-request guard).
    const open = this.db.prepare(`SELECT id, args FROM messages WHERE type = 'policy.proposal' AND status = 'open' AND agent = ?`).all<{ id: string; args: string | null }>(agent);
    if (open.length >= 10) return { ok: false, error: 'you already have 10 open policy proposals awaiting review — wait for an owner to act on them first' };
    const deltaKey = JSON.stringify(delta);
    if (open.some((o) => { try { return JSON.stringify((JSON.parse(o.args || '{}') as { delta?: unknown }).delta) === deltaKey; } catch { return false; } })) {
      return { ok: false, error: 'an identical proposal from you is already awaiting review' };
    }
    const label = delta.match.capability + (delta.match.when ? ` when ${delta.match.when.arg}` : '');
    this.postReviewCard({
      type: 'policy.proposal', sessionId, agent,
      title: `Policy change proposed — ${label}`,
      body: (rationale?.trim() || `${agent} proposes a ${delta.kind} change to "${label}".`) + (preview ? `\n\n${preview}` : ''),
      args: { delta, preview, ...(rationale ? { rationale } : {}) },
      // Applying a policy change is an OWNER act; the card addresses the admin tier so it lands in their
      // inbox (the approve route itself is owner-only; admins see it for oversight).
      summary: rationale?.trim() || `${agent} proposes a ${delta.kind} change to "${label}".`,
    });
    this.audit(sessionId, agent, 'policy.proposed', { kind: delta.kind, capability: delta.match.capability, when: delta.match.when, outcome: delta.outcome, preview, rationale });
    return { ok: true, preview };
  }

  /** Read a 'policy.proposal' card's payload (for the approve/reject routes). undefined if not one. */
  policyProposalCard(id: string): { agent: string; delta: PolicyDelta; rationale?: string; preview?: string; status: string } | undefined {
    const row = this.db.prepare(`SELECT agent, args, status FROM messages WHERE id = ? AND type = 'policy.proposal'`).get<{ agent: string; args: string | null; status: string }>(id);
    if (!row) return undefined;
    let a: Record<string, unknown> = {};
    try { a = row.args ? JSON.parse(row.args) : {}; } catch { /* tolerate a corrupt payload */ }
    if (!a.delta) return undefined;
    return { agent: row.agent, delta: a.delta as PolicyDelta, rationale: a.rationale ? String(a.rationale) : undefined, preview: a.preview ? String(a.preview) : undefined, status: row.status };
  }

  /** Mark a 'policy.proposal' card resolved once an owner approved or rejected it. */
  setPolicyProposalStatus(id: string, status: 'approved' | 'rejected'): void {
    this.db.prepare(`UPDATE messages SET status = ? WHERE id = ? AND type = 'policy.proposal'`).run(status, id);
  }

  /** Open (unresolved) policy.proposal cards — the Settings → Governance review section. */
  openPolicyProposals(): { id: string; agent: string; delta: PolicyDelta; rationale?: string; preview?: string; createdAt: number }[] {
    return this.db
      .prepare(`SELECT id, agent, args, created_at FROM messages WHERE type = 'policy.proposal' AND status = 'open' ORDER BY created_at DESC`)
      .all<{ id: string; agent: string; args: string | null; created_at: number }>()
      .map((r) => {
        let a: Record<string, unknown> = {};
        try { a = r.args ? JSON.parse(r.args) : {}; } catch { /* tolerate corrupt payload */ }
        return { id: r.id, agent: r.agent, delta: a.delta as PolicyDelta, rationale: a.rationale ? String(a.rationale) : undefined, preview: a.preview ? String(a.preview) : undefined, createdAt: r.created_at };
      })
      .filter((p) => p.delta);
  }

  /**
   * An agent proposes a NEW automation for a human to approve — the automations twin of `proposePolicy`.
   * Nothing is created here (an unapproved automation must not fire): the full spec lives in the review
   * card's args, and the approve route calls `Automations.add` only once an owner/admin signs off. Same
   * queue-cap + identical-spec dedupe as the other propose lanes. Cron validity is checked at approve
   * time (by `add`), so a bad expression fails loudly for the human rather than being silently created.
   */
  proposeAutomation(sessionId: string, agent: string, spec: ProposedAutomation, rationale?: string): { ok: boolean; preview?: string; error?: string } {
    const agentId = (spec.agentId || agent).trim();
    if (!this.os.agents.has(agentId)) return { ok: false, error: `unknown agent "${agentId}"` };
    const name = (spec.name || '').trim();
    const task = (spec.task || '').trim();
    if (!name) return { ok: false, error: 'a name is required' };
    if (!task) return { ok: false, error: 'a task template is required' };
    const type = (['cron', 'webhook', 'composio', 'slack', 'discord'] as const).includes(spec.type as never) ? spec.type : 'cron';
    if (type === 'cron' && !(spec.schedule || '').trim()) return { ok: false, error: 'a cron automation needs a schedule (5-field cron expression)' };
    // Resolve the suggested run-as identity to a canonical member id. Agents name a member by id or email
    // (e.g. from `directory_lookup`); the automations store keys run_as by member id (fire → createSession
    // runAs → composioUserId(member).email). Reject an unresolvable value so a typo can't silently degrade
    // the approved automation back to company identity (the exact surprise that hides a missing Gmail).
    let runAs: string | undefined;
    if ((spec.runAs || '').trim()) {
      const raw = String(spec.runAs).trim();
      const m = this.os.team.resolveMemberRef(raw);
      if (!m) return { ok: false, error: `unknown member "${raw}" for runAs — pass a member id or email (use directory_lookup), or omit runAs to run as the company identity` };
      runAs = m.id;
    }
    const clean: ProposedAutomation = { agentId, name, type, task, ...(spec.schedule ? { schedule: String(spec.schedule).trim() } : {}), ...(spec.filter ? { filter: String(spec.filter).trim() } : {}), ...(spec.mode === 'headless' || spec.mode === 'interactive' ? { mode: spec.mode } : {}), ...(runAs ? { runAs } : {}) };
    // Cap the queue + dedupe an identical open proposal from this agent (mirrors proposePolicy).
    const open = this.db.prepare(`SELECT id, args FROM messages WHERE type = 'automation.proposed' AND status = 'open' AND agent = ?`).all<{ id: string; args: string | null }>(agent);
    if (open.length >= 10) return { ok: false, error: 'you already have 10 open automation proposals awaiting review — wait for a human to act on them first' };
    const specKey = JSON.stringify(clean);
    if (open.some((o) => { try { return JSON.stringify((JSON.parse(o.args || '{}') as { spec?: unknown }).spec) === specKey; } catch { return false; } })) {
      return { ok: false, error: 'an identical automation proposal from you is already awaiting review' };
    }
    // Surface the run-as identity in the preview: it decides which connectors the fired session gets
    // (a member → their personal Composio Gmail/etc.; unset → company identity only), so the approver
    // consciously consents to whose credentials will be used.
    const asWho = runAs ? (this.os.team.getMember(runAs)?.name || this.os.team.getMember(runAs)?.email || runAs) : 'company identity';
    const preview = `${type}${clean.schedule ? ` \`${clean.schedule}\`` : ''} → runs \`${agentId}\` as ${asWho}: ${task.slice(0, 80)}${task.length > 80 ? '…' : ''}`;
    this.postReviewCard({
      type: 'automation.proposed', sessionId, agent,
      title: `Automation proposed — ${name}`,
      body: (rationale?.trim() || `${agent} proposes a ${type} automation "${name}".`) + `\n\n${preview}`,
      args: { spec: clean, preview, ...(rationale ? { rationale } : {}) },
      summary: rationale?.trim() || `${agent} proposes a ${type} automation "${name}".`,
    });
    this.audit(sessionId, agent, 'automation.proposed', { name, type, agentId, schedule: clean.schedule });
    return { ok: true, preview };
  }

  /** The proposed-automation review card by id (its spec + status) — for the approve/reject routes. */
  automationProposalCard(id: string): { agent: string; spec: ProposedAutomation; rationale?: string; preview?: string; status: string } | undefined {
    const row = this.db.prepare(`SELECT agent, args, status FROM messages WHERE id = ? AND type = 'automation.proposed'`).get<{ agent: string; args: string | null; status: string }>(id);
    if (!row) return undefined;
    let a: Record<string, unknown> = {};
    try { a = row.args ? JSON.parse(row.args) : {}; } catch { /* tolerate a corrupt payload */ }
    if (!a.spec) return undefined;
    return { agent: row.agent, spec: a.spec as ProposedAutomation, rationale: a.rationale ? String(a.rationale) : undefined, preview: a.preview ? String(a.preview) : undefined, status: row.status };
  }
  setAutomationProposalStatus(id: string, status: 'approved' | 'rejected'): void {
    this.db.prepare(`UPDATE messages SET status = ? WHERE id = ? AND type = 'automation.proposed'`).run(status, id);
  }
  openAutomationProposals(): { id: string; agent: string; spec: ProposedAutomation; rationale?: string; preview?: string; createdAt: number }[] {
    return this.db
      .prepare(`SELECT id, agent, args, created_at FROM messages WHERE type = 'automation.proposed' AND status = 'open' ORDER BY created_at DESC`)
      .all<{ id: string; agent: string; args: string | null; created_at: number }>()
      .map((r) => {
        let a: Record<string, unknown> = {};
        try { a = r.args ? JSON.parse(r.args) : {}; } catch { /* tolerate corrupt payload */ }
        return { id: r.id, agent: r.agent, spec: a.spec as ProposedAutomation, rationale: a.rationale ? String(a.rationale) : undefined, preview: a.preview ? String(a.preview) : undefined, createdAt: r.created_at };
      })
      .filter((p) => p.spec);
  }

  /**
   * An agent PROPOSES an edit to ANOTHER agent's listing / CLAUDE.md — the cross-agent sibling of the
   * self-only `agent_update`. Validates the target the SAME way the self-edit route does (claude-code
   * only, under the user-agents root, not a bundled example), so an agent can't propose edits to
   * something a human couldn't edit either. Same queue-cap + identical-delta dedupe as the other propose
   * lanes; `id === proposer` is refused (that's what `agent_update` is for).
   *
   * What happens to a VALID proposal is decided by the PROPOSER's maturity score against the workspace
   * {@link AgentProposalTrust} tiers (Settings → Agents):
   *   below `minMaturity`  → refused here. An unproven agent doesn't get to rewrite a teammate's prompt,
   *                          and doesn't get to fill a human's queue asking to.
   *   middle band          → the original behaviour: nothing is written, the field delta rides in an
   *                          owner-addressed review card, and only the approve route applies it.
   *   ≥ `autoApplyAt`      → APPLIED NOW by {@link applyAgentEdit}, with the owner notified after the
   *                          fact. This is the one path where an agent changes another agent with no
   *                          human in the loop, so it is deliberately expensive to reach (maturity
   *                          multiplies in volumeConfidence — ~32+ clean, autonomous runs) and it
   *                          snapshots a revision like every other edit, so an owner can revert it.
   * Maturity is computed per call from the audit/session history — a full-history scan, but this is a
   * rare, human-speed tool call, not a hot path.
   *
   * Maturity predicts INTENT, not correctness of transcription, so it is not the only thing that picks the
   * lane. A destructive rewrite (see {@link assessClaudeMdEdit}) and a proposer's first-ever edit of this
   * particular target both force the gated lane whatever the tier says — the two shapes where "a trusted
   * agent meant well" and "a teammate's prompt was just clobbered" are indistinguishable from the score.
   */
  proposeAgentUpdate(sessionId: string, proposer: string, body: Record<string, unknown>): { ok: boolean; preview?: string; applied?: boolean; rev?: number | null; maturity?: number; outcome?: string; message?: string; error?: string; conflict?: boolean; baseHash?: string; bytesBefore?: number; bytesAfter?: number; droppedHeadings?: string[]; destructive?: boolean } {
    const target = String(body.id ?? '').trim().toLowerCase();
    if (!target) return { ok: false, outcome: 'refused', error: 'id (the agent to edit) is required' };
    if (target === proposer) return { ok: false, outcome: 'refused', error: 'use agent_update to edit your own listing' };
    if (!String(body.rationale ?? '').trim()) return { ok: false, outcome: 'refused', error: 'a rationale is required — the approver sees it on the card' };
    const editable = agentEditable(this.os, target);
    if (!editable.ok) return { ok: false, outcome: 'refused', error: editable.error };
    const ag = editable.ag;
    const current = readAgentSnapshot(ag).claudeMd;
    // ── read-before-write: refuse a write built on a stale copy of the target ──
    if (body.baseHash !== undefined && String(body.baseHash) !== contentHash(current)) {
      return {
        ok: false, outcome: 'refused', conflict: true, baseHash: contentHash(current),
        error: `your baseHash is stale — "${target}"'s CLAUDE.md has changed since you read it (now ${contentHash(current)}, ${current.length} chars). Re-read it with agent_get and redo your edit on the current text.`,
      };
    }
    // ── patch, append, or full replacement — resolved against the target's CURRENT text ──
    const resolved = resolveClaudeMd(current, body);
    if (!resolved.ok) return { ok: false, outcome: 'refused', error: resolved.error };
    const risk = resolved.text !== undefined ? assessClaudeMdEdit(current, resolved.text) : undefined;
    // Only the fields actually present become the delta; store them verbatim on the card for the approve route.
    const fields: Record<string, unknown> = {};
    for (const k of ['description', 'category', 'model', 'effort', 'icon'] as const) {
      if (k in body) fields[k] = String(body[k] ?? '');
    }
    if (resolved.text !== undefined) fields.claudeMd = resolved.text;
    if ('examplePrompts' in body && Array.isArray(body.examplePrompts)) fields.examplePrompts = body.examplePrompts.map(String);
    if (!Object.keys(fields).length) return { ok: false, outcome: 'refused', error: 'nothing to change — pass at least one field (description, claudeMd/claudeMdEdits/claudeMdAppend, category, model, effort, icon, examplePrompts)' };
    // ── the trust tier: what this proposer's track record earns it ──────────────────────────────
    const trust = this.os.settings.agentProposalTrust();
    const maturity = computeAgentStat(this.db, proposer).maturity;
    const pct = Math.round(maturity * 100);
    if (maturity < trust.minMaturity) {
      this.audit(sessionId, proposer, 'agent.update.proposal.blocked', { target, maturity, floor: trust.minMaturity, fields: Object.keys(fields) });
      return {
        ok: false, outcome: 'refused', maturity,
        error: `your maturity is ${pct}/100 and this workspace requires ${Math.round(trust.minMaturity * 100)}/100 to propose edits to another agent. Maturity comes from completed runs that needed few approvals and hit no denials — keep doing your own work well, and tell a human directly if "${target}" needs changing.`,
      };
    }
    const rationaleText = String(body.rationale).trim();
    const previewText = Object.keys(fields).map((k) => (k === 'claudeMd' ? 'CLAUDE.md (system prompt)' : k)).join(', ');
    const diffLine = risk ? `\n\nCLAUDE.md: ${diffStat(risk)}${risk.droppedHeadings.length ? ` — DROPS ${risk.droppedHeadings.length} existing section${risk.droppedHeadings.length === 1 ? '' : 's'}: ${risk.droppedHeadings.slice(0, 5).map((h) => `"${h}"`).join(', ')}${risk.droppedHeadings.length > 5 ? ', …' : ''}` : ''}` : '';
    // ── shape beats score: two edits a maturity tier must not wave through ──
    // A destructive rewrite is the fingerprint of a caller that submitted a fragment, and a first edit of
    // THIS target has no track record behind it however good the proposer's average is. Either one demotes
    // the call to the gated lane; neither can be waved off by the proposer (confirmRewrite is a self-edit
    // affordance — here a human reads the diff stat instead).
    const firstEditOfTarget = !this.hasEditedAgentBefore(proposer, target);
    const forceGate = (risk?.destructive ?? false) || firstEditOfTarget;
    const forceReason = risk?.destructive
      ? `it ${risk.reason}`
      : 'this is your first edit of this agent';
    // ── dry run: name the lane and the damage, write nothing ──
    if (body.dryRun === true) {
      const lane = trust.autoApply && maturity >= trust.autoApplyAt && !forceGate ? 'apply immediately' : 'wait for an owner to approve';
      return {
        ok: true, outcome: 'dry_run', preview: previewText, maturity,
        ...(risk ? { bytesBefore: risk.bytesBefore, bytesAfter: risk.bytesAfter, droppedHeadings: risk.droppedHeadings, destructive: risk.destructive } : {}),
        message: `Dry run — nothing was written. This would change ${previewText} on "${target}" and would ${lane}${forceGate && trust.autoApply && maturity >= trust.autoApplyAt ? ` (demoted to review because ${forceReason})` : ''}.${diffLine}`,
      };
    }
    if (trust.autoApply && maturity >= trust.autoApplyAt && !forceGate) {
      // Top tier: apply now, tell the owner afterwards. The revision snapshot is what makes this safe to
      // undo — the notification card names the rev so an owner can revert it in one step.
      const applied = applyAgentEdit(this.os, ag, fields, {
        summary: `auto-applied from ${proposer} (maturity ${pct}/100): ${rationaleText}`,
        author: `agent:${proposer}`,
      });
      if (!applied.ok) return { ok: false, outcome: 'refused', error: applied.error };
      this.addMessage({
        type: 'notification', sessionId, agent: proposer,
        title: `${proposer} edited ${target}`,
        body: `${rationaleText}\n\nChanges to \`${target}\`: ${previewText}${diffLine}\n\nApplied automatically — ${proposer} is at maturity ${pct}/100, at or above this workspace's ${Math.round(trust.autoApplyAt * 100)}/100 auto-apply bar.${applied.rev ? ` Saved as rev ${applied.rev}; revert it from the agent's History if it's wrong.` : ''}`,
        status: 'open',
        args: { target, fields, rationale: rationaleText, preview: previewText, maturity, rev: applied.rev, autoApplied: true, ...(risk ? { bytesBefore: risk.bytesBefore, bytesAfter: risk.bytesAfter } : {}) },
        audienceKind: 'admins',
      });
      this.audit(sessionId, proposer, 'agent.update.applied', { target, fields: Object.keys(fields), maturity, bar: trust.autoApplyAt, rev: applied.rev, auto: true, bytesBefore: risk?.bytesBefore, bytesAfter: risk?.bytesAfter });
      return {
        ok: true, preview: previewText, applied: true, rev: applied.rev, maturity, outcome: 'applied',
        ...(risk ? { bytesBefore: risk.bytesBefore, bytesAfter: risk.bytesAfter } : {}),
        message: `APPLIED your edit to "${target}" (${previewText}) — your maturity (${pct}/100) is at or above this workspace's auto-apply bar, so it took effect immediately WITHOUT a human approving it.${risk ? ` CLAUDE.md ${diffStat(risk)}.` : ''}${applied.rev ? ` Saved as rev ${applied.rev}.` : ''} An owner has been notified and can revert it. "${target}" picks it up on its next session. Do NOT tell anyone this is awaiting review — it is already live.`,
      };
    }
    // Cap the queue + dedupe an identical open proposal from this agent for this target (mirrors proposeAutomation).
    const open = this.db.prepare(`SELECT args FROM messages WHERE type = 'agent.update.proposed' AND status = 'open' AND agent = ?`).all<{ args: string | null }>(proposer);
    if (open.length >= 10) return { ok: false, outcome: 'refused', error: 'you already have 10 open edit proposals awaiting review — wait for a human to act on them first' };
    const deltaKey = JSON.stringify({ target, fields });
    if (open.some((o) => { try { const a = JSON.parse(o.args || '{}') as { target?: string; fields?: unknown }; return JSON.stringify({ target: a.target, fields: a.fields }) === deltaKey; } catch { return false; } })) {
      return { ok: false, outcome: 'refused', error: 'an identical edit proposal from you is already awaiting review' };
    }
    // Middle band (or a demoted top-tier call) — the owner decides. The proposer's maturity rides on the
    // card so the reviewer weighs the proposal against its author's track record instead of on prose alone,
    // and the diff stat puts a −6,348/+0 rewrite in front of them without opening the document.
    const demoted = forceGate && trust.autoApply && maturity >= trust.autoApplyAt;
    this.postReviewCard({
      type: 'agent.update.proposed', sessionId, agent: proposer,
      title: `Edit proposed for ${target}`,
      body: `${rationaleText}\n\nChanges to \`${target}\`: ${previewText}${diffLine}\n\nProposed by ${proposer} — maturity ${pct}/100.${demoted ? ` Above the auto-apply bar but held for review because ${forceReason}.` : ''}`,
      // baseHash pins the text this delta was written against, so the approve route can tell the owner when
      // the target moved while the card sat in the queue (a full replacement would silently undo the change).
      args: { target, fields, rationale: rationaleText, preview: previewText, maturity, demoted, baseHash: contentHash(current), ...(risk ? { bytesBefore: risk.bytesBefore, bytesAfter: risk.bytesAfter, droppedHeadings: risk.droppedHeadings } : {}) },
      summary: `${proposer} (maturity ${pct}/100) proposes editing ${target} (${previewText})`,
      // The review card lives on the TARGET agent's settings page — link there, not the Agents index.
      link: { page: 'agent', detail: target, label: `${target}'s settings` },
    });
    this.audit(sessionId, proposer, 'agent.update.proposed', { target, fields: Object.keys(fields), maturity, demoted, destructive: risk?.destructive ?? false, bytesBefore: risk?.bytesBefore, bytesAfter: risk?.bytesAfter });
    return {
      ok: true, preview: previewText, applied: false, maturity, outcome: 'pending_approval',
      ...(risk ? { bytesBefore: risk.bytesBefore, bytesAfter: risk.bytesAfter, destructive: risk.destructive } : {}),
      message: `Proposed an edit to "${target}" (${previewText}) — it is in an owner's inbox for review. NOTHING has changed yet; an owner who can run "${target}" must approve it first, and the target picks it up on its next session once applied.${risk ? ` CLAUDE.md would go ${diffStat(risk)}.` : ''}${demoted ? ` (Your maturity is above the auto-apply bar, but this one is held for review because ${forceReason}.)` : ''}`,
    };
  }

  /**
   * Has this proposer successfully edited this target before? The question the "first edit of a given
   * agent waits for a human" rule turns on.
   *
   * It cannot be answered from revision AUTHORSHIP alone: an owner-approved proposal is attributed to the
   * approving owner (that's who took responsibility for it), so counting only `agent:<proposer>` revisions
   * would mean approval never builds a track record and the auto-apply tier stays permanently unreachable
   * for every target the proposer hasn't already auto-applied to. So a human's YES counts too.
   */
  private hasEditedAgentBefore(proposer: string, target: string): boolean {
    if (this.os.agentRevisions.list(target).some((r) => r.author === `agent:${proposer}`)) return true;
    return this.db
      .prepare(`SELECT args FROM messages WHERE type = 'agent.update.proposed' AND status = 'approved' AND agent = ?`)
      .all<{ args: string | null }>(proposer)
      .some((r) => { try { return String((JSON.parse(r.args || '{}') as { target?: unknown }).target ?? '') === target; } catch { return false; } });
  }

  /** The proposed agent-edit review card by id (its target + field delta + status) — for the approve/reject routes. */
  agentUpdateProposalCard(id: string): { id: string; agent: string; target: string; fields: Record<string, unknown>; rationale?: string; preview?: string; baseHash?: string; status: string } | undefined {
    const row = this.db.prepare(`SELECT agent, args, status FROM messages WHERE id = ? AND type = 'agent.update.proposed'`).get<{ agent: string; args: string | null; status: string }>(id);
    if (!row) return undefined;
    let a: Record<string, unknown> = {};
    try { a = row.args ? JSON.parse(row.args) : {}; } catch { /* tolerate a corrupt payload */ }
    if (!a.target || !a.fields) return undefined;
    return { id, agent: row.agent, target: String(a.target), fields: a.fields as Record<string, unknown>, rationale: a.rationale ? String(a.rationale) : undefined, preview: a.preview ? String(a.preview) : undefined, baseHash: a.baseHash ? String(a.baseHash) : undefined, status: row.status };
  }
  setAgentUpdateProposalStatus(id: string, status: 'approved' | 'rejected'): void {
    this.db.prepare(`UPDATE messages SET status = ? WHERE id = ? AND type = 'agent.update.proposed'`).run(status, id);
  }
  /**
   * Open agent-edit proposals (all targets, or just one when `target` is given) — for the console review list.
   *
   * `baseHash` rides along so the caller can tell the reviewer, BEFORE they click Approve, that the target's
   * CLAUDE.md moved since this card was written (several agents proposing on one target is normal — the cap
   * is per-proposer — and each card carries a FULL replacement text, so approving two in a row makes the
   * second silently revert the first).
   */
  openAgentUpdateProposals(target?: string): { id: string; agent: string; target: string; fields: Record<string, unknown>; rationale?: string; preview?: string; baseHash?: string; createdAt: number }[] {
    return this.db
      .prepare(`SELECT id, agent, args, created_at FROM messages WHERE type = 'agent.update.proposed' AND status = 'open' ORDER BY created_at DESC`)
      .all<{ id: string; agent: string; args: string | null; created_at: number }>()
      .map((r) => {
        let a: Record<string, unknown> = {};
        try { a = r.args ? JSON.parse(r.args) : {}; } catch { /* tolerate corrupt payload */ }
        return { id: r.id, agent: r.agent, target: String(a.target ?? ''), fields: (a.fields ?? {}) as Record<string, unknown>, rationale: a.rationale ? String(a.rationale) : undefined, preview: a.preview ? String(a.preview) : undefined, baseHash: a.baseHash ? String(a.baseHash) : undefined, createdAt: r.created_at };
      })
      .filter((p) => p.target && (!target || p.target === target.trim().toLowerCase()));
  }

  /**
   * Agent proposes an edit to an EXISTING goal's state (`goal_update`) — the maturity-tiered sibling of the
   * read-only `goal_list`/`goal_get` and the create-a-draft `goal_propose`. Same three lanes as
   * {@link proposeAgentUpdate}, keyed on the proposer's maturity against the shared `agentProposalTrust`
   * tiers: below the floor → refused; middle band → a `goal.update.proposed` review card, nothing applied;
   * at/above the auto-apply bar → applied immediately via {@link GoalStore.update}, owner notified after.
   *
   * "Shape beats score" (mirrors the agent path's destructive-rewrite demotion): the load-bearing
   * steering-wheel transitions — **activating, abandoning, or reopening a goal, or claiming an unfinished
   * goal is `achieved`** — ALWAYS demote to human review, whatever the maturity tier. The only status change
   * a top-tier agent auto-applies is marking a goal `achieved` whose linked work is already 100% done (the
   * console's "Mark achieved" affordance). Non-status edits (title/body/target/labels/dueAt/note) auto-apply
   * at the top tier. Owner/parent are NOT agent-editable — re-owning or re-parenting strategy stays a console
   * act. Every applied edit is event-logged in `goal_events` (the append-only safety net), so it's revertable.
   */
  proposeGoalUpdate(sessionId: string, proposer: string, body: Record<string, unknown>): { ok: boolean; applied?: boolean; maturity?: number; outcome?: string; message?: string; error?: string; preview?: string; url?: string } {
    const target = String(body.id ?? '').trim();
    if (!target) return { ok: false, outcome: 'refused', error: 'id (the goal to edit) is required — see goal_list for ids' };
    if (!String(body.rationale ?? '').trim()) return { ok: false, outcome: 'refused', error: 'a rationale is required — the approver sees it on the card' };
    const goal = this.os.goals.get(target);
    if (!goal) return { ok: false, outcome: 'refused', error: `no goal "${target}" — check goal_list for ids` };

    // ── build the field delta from the fields actually present (only these are agent-editable) ──
    const STATUSES = ['draft', 'active', 'achieved', 'abandoned'];
    const delta: Record<string, unknown> = {};
    if ('status' in body && body.status !== undefined) {
      const s = String(body.status);
      if (!STATUSES.includes(s)) return { ok: false, outcome: 'refused', error: `status must be one of ${STATUSES.join(', ')}` };
      if (s !== goal.status) delta.status = s;
    }
    if ('title' in body && String(body.title ?? '').trim() && String(body.title).trim() !== goal.title) delta.title = String(body.title).trim();
    if ('body' in body && body.body !== undefined && String(body.body) !== goal.body) delta.body = String(body.body);
    if ('target' in body && body.target !== undefined) { const t = String(body.target); if (t !== (goal.target ?? '')) delta.target = t || null; }
    if ('labels' in body && Array.isArray(body.labels)) delta.labels = body.labels.map(String);
    if ('dueAt' in body && body.dueAt !== undefined) { const d = body.dueAt === null ? null : Number(body.dueAt); if ((d ?? null) !== (goal.dueAt ?? null)) delta.dueAt = d; }
    const note = 'note' in body && String(body.note ?? '').trim() ? String(body.note).trim() : undefined;
    if (!Object.keys(delta).length && !note) {
      return { ok: false, outcome: 'refused', error: 'nothing to change — pass at least one of status, title, body, target, labels, dueAt, or note (with values different from the goal\'s current ones)' };
    }

    // ── the trust tier: what this proposer's track record earns it ──
    const trust = this.os.settings.agentProposalTrust();
    const maturity = computeAgentStat(this.db, proposer).maturity;
    const pct = Math.round(maturity * 100);
    if (maturity < trust.minMaturity) {
      this.audit(sessionId, proposer, 'goal.update.blocked', { goal: target, maturity, floor: trust.minMaturity, fields: Object.keys(delta) });
      return {
        ok: false, outcome: 'refused', maturity,
        error: `your maturity is ${pct}/100 and this workspace requires ${Math.round(trust.minMaturity * 100)}/100 to edit a goal directly. Maturity comes from completed runs that needed few approvals and hit no denials — until then, propose a NEW direction with goal_propose or tell a human what "${goal.title}" needs.`,
      };
    }

    // ── shape beats score: the steering-wheel transitions always go to a human ──
    const progress = this.os.goals.progress(target);
    const newStatus = typeof delta.status === 'string' ? delta.status : undefined;
    const achievedComplete = newStatus === 'achieved' && progress.total > 0 && progress.percent >= 100;
    const forceGate = !!newStatus && !achievedComplete;
    const forceReason =
      newStatus === 'active' ? 'activating a goal steers the whole fleet — that\'s a human decision'
      : newStatus === 'abandoned' ? 'abandoning a strategic direction is a human decision'
      : newStatus === 'achieved' ? `its linked work isn't complete yet (${progress.percent}% done) — claiming the outcome needs a human`
      : newStatus === 'draft' ? 'pulling a goal back to draft de-activates live strategy — a human decides that'
      : 'a status change is a human decision';

    const previewText = describeGoalDelta(delta, note, goal);
    const url = this.consoleGoalUrl(target);

    // ── dry run: name the lane, write nothing ──
    if (body.dryRun === true) {
      const lane = trust.autoApply && maturity >= trust.autoApplyAt && !forceGate ? 'apply immediately' : 'wait for an owner to approve';
      return {
        ok: true, outcome: 'dry_run', maturity, preview: previewText, url,
        message: `Dry run — nothing was written. This would change ${previewText} on "${goal.title}" and would ${lane}${forceGate && trust.autoApply && maturity >= trust.autoApplyAt ? ` (held for review because ${forceReason})` : ''}.`,
      };
    }

    const rationaleText = String(body.rationale).trim();

    if (trust.autoApply && maturity >= trust.autoApplyAt && !forceGate) {
      // Top tier + a non-steering edit: apply now, tell the owner afterwards. The goal_events log makes it revertable.
      const updated = this.os.goals.update(target, { ...delta, note, by: `agent:${proposer}` });
      if (!updated) return { ok: false, outcome: 'refused', error: 'the goal disappeared before the edit could apply' };
      this.addMessage({
        type: 'notification', sessionId, agent: proposer,
        title: `${proposer} edited goal "${goal.title}"`,
        body: `${rationaleText}\n\nChanges: ${previewText}\n\nApplied automatically — ${proposer} is at maturity ${pct}/100, at or above this workspace's ${Math.round(trust.autoApplyAt * 100)}/100 auto-apply bar. See the goal's activity log to review or reverse it.`,
        status: 'open',
        args: { goalId: target, fields: delta, note, rationale: rationaleText, preview: previewText, maturity, autoApplied: true },
        audienceKind: 'admins',
      });
      this.audit(sessionId, proposer, 'goal.update.applied', { goal: target, fields: Object.keys(delta), note: !!note, maturity, bar: trust.autoApplyAt, auto: true });
      return {
        ok: true, applied: true, maturity, outcome: 'applied', preview: previewText, url,
        message: `APPLIED your edit to "${goal.title}" (${previewText}) — your maturity (${pct}/100) is at or above this workspace's auto-apply bar, so it took effect immediately WITHOUT a human approving it. An owner has been notified and can reverse it from the goal's activity log. Do NOT tell anyone this is awaiting review — it is already live.\n${url}`,
      };
    }

    // Cap the queue + dedupe an identical open proposal from this agent for this goal.
    const open = this.db.prepare(`SELECT args FROM messages WHERE type = 'goal.update.proposed' AND status = 'open' AND agent = ?`).all<{ args: string | null }>(proposer);
    if (open.length >= 10) return { ok: false, outcome: 'refused', error: 'you already have 10 open goal-edit proposals awaiting review — wait for a human to act on them first' };
    const deltaKey = JSON.stringify({ goalId: target, fields: delta, note });
    if (open.some((o) => { try { const a = JSON.parse(o.args || '{}') as { goalId?: string; fields?: unknown; note?: unknown }; return JSON.stringify({ goalId: a.goalId, fields: a.fields, note: a.note }) === deltaKey; } catch { return false; } })) {
      return { ok: false, outcome: 'refused', error: 'an identical goal-edit proposal from you is already awaiting review' };
    }
    // Middle band (or a demoted top-tier steering change) — the owner decides. Proposer maturity rides the card.
    const demoted = forceGate && trust.autoApply && maturity >= trust.autoApplyAt;
    this.postReviewCard({
      type: 'goal.update.proposed', sessionId, agent: proposer,
      title: `Goal edit proposed — ${goal.title}`,
      body: `${rationaleText}\n\nChanges to goal "${goal.title}": ${previewText}\n\nProposed by ${proposer} — maturity ${pct}/100.${demoted ? ` Above the auto-apply bar but held for review because ${forceReason}.` : ''}`,
      args: { goalId: target, fields: delta, note, rationale: rationaleText, preview: previewText, maturity, demoted },
      summary: `${proposer} (maturity ${pct}/100) proposes editing goal "${goal.title}" (${previewText})`,
    });
    this.audit(sessionId, proposer, 'goal.update.proposed', { goal: target, fields: Object.keys(delta), note: !!note, maturity, demoted });
    return {
      ok: true, applied: false, maturity, outcome: 'pending_approval', preview: previewText, url,
      message: `Proposed an edit to "${goal.title}" (${previewText}) — it is in an owner's inbox for review. NOTHING has changed yet; an owner/admin must approve it first.${demoted ? ` (Your maturity is above the auto-apply bar, but this one is held for review because ${forceReason}.)` : ''}\n${url}`,
    };
  }

  /** The proposed goal-edit review card by id (its goal + field delta + status) — for the approve/reject routes. */
  goalUpdateProposalCard(id: string): { id: string; agent: string; goalId: string; fields: Record<string, unknown>; note?: string; rationale?: string; preview?: string; status: string } | undefined {
    const row = this.db.prepare(`SELECT agent, args, status FROM messages WHERE id = ? AND type = 'goal.update.proposed'`).get<{ agent: string; args: string | null; status: string }>(id);
    if (!row) return undefined;
    let a: Record<string, unknown> = {};
    try { a = row.args ? JSON.parse(row.args) : {}; } catch { /* tolerate a corrupt payload */ }
    if (!a.goalId || !a.fields) return undefined;
    return { id, agent: row.agent, goalId: String(a.goalId), fields: a.fields as Record<string, unknown>, note: a.note ? String(a.note) : undefined, rationale: a.rationale ? String(a.rationale) : undefined, preview: a.preview ? String(a.preview) : undefined, status: row.status };
  }
  setGoalUpdateProposalStatus(id: string, status: 'approved' | 'rejected'): void {
    this.db.prepare(`UPDATE messages SET status = ? WHERE id = ? AND type = 'goal.update.proposed'`).run(status, id);
  }
  /** Open goal-edit proposals (all goals, or just one when `goalId` is given) — for the console review list. */
  openGoalUpdateProposals(goalId?: string): { id: string; agent: string; goalId: string; fields: Record<string, unknown>; note?: string; rationale?: string; preview?: string; createdAt: number }[] {
    return this.db
      .prepare(`SELECT id, agent, args, created_at FROM messages WHERE type = 'goal.update.proposed' AND status = 'open' ORDER BY created_at DESC`)
      .all<{ id: string; agent: string; args: string | null; created_at: number }>()
      .map((r) => {
        let a: Record<string, unknown> = {};
        try { a = r.args ? JSON.parse(r.args) : {}; } catch { /* tolerate corrupt payload */ }
        return { id: r.id, agent: r.agent, goalId: String(a.goalId ?? ''), fields: (a.fields ?? {}) as Record<string, unknown>, note: a.note ? String(a.note) : undefined, rationale: a.rationale ? String(a.rationale) : undefined, preview: a.preview ? String(a.preview) : undefined, createdAt: r.created_at };
      })
      .filter((pr) => pr.goalId && (!goalId || pr.goalId === goalId.trim()));
  }

  /** Absolute console deep-link to a goal — the tenant's real external origin when known, else the loopback
   *  base (dev/demo), mirroring how AOS_SESSION_URL is built for the launcher. */
  private consoleGoalUrl(goalId: string): string {
    return `${(this.publicOrigin || this.baseUrl).replace(/\/$/, '')}/#/goals/${encodeURIComponent(goalId)}`;
  }

  /** Agent posts a mid-task progress update to the Inbox feed. Unlike the (now removed) spawn/stop/exit
   *  lifecycle cards, this is an agent-authored signal: a short note on what it just did or is about to
   *  do. Flagging it `important` highlights it in the feed — a milestone or heads-up worth the operator's
   *  eye. Each call is its own feed entry (a timeline), never deduped. Empty messages are dropped. */
  progress(sessionId: string, agent: string, message: string, important = false): void {
    const body = (message || '').trim();
    if (!body) return;
    // A task-dispatched run narrates INTO its task's Discussion, not the owner's Inbox (§3.2) — its
    // progress IS the conversation, and stays quiet (Discussion messages don't hit the Inbox feed).
    const taskId = this.taskForSession(sessionId);
    if (taskId) {
      this.postTaskMessage({ taskId, author: `agent:${agent}`, agent, body });
      this.audit(sessionId, agent, 'session.progress', { important, message: body, taskId });
      return;
    }
    this.addMessage({ type: 'update', sessionId, agent, title: `Update — ${agent}`, body, status: 'open', args: important ? { important: true } : undefined, audienceKind: 'sessionOwner', audienceId: sessionId });
    this.audit(sessionId, agent, 'session.progress', { important, message: body });
  }

  /** The task id a session was dispatched for (`task:<id>` provenance), else undefined. Drives the §3.2
   *  reroute of a dispatched agent's `report`/`update` into the task Discussion. */
  private taskForSession(sessionId: string): string | undefined {
    const r = this.db.prepare('SELECT spawned_by FROM term_sessions WHERE id = ?').get<{ spawned_by: string | null }>(sessionId);
    const sb = r?.spawned_by ?? '';
    return sb.startsWith('task:') ? sb.slice('task:'.length) : undefined;
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
        ?? members.find((m) => (m.name ?? '').toLowerCase() === lower)
        ?? members.find((m) => m.email.split('@')[0].toLowerCase() === lower)
        ?? members.find((m) => (m.name ?? '').toLowerCase().replace(/\s+/g, '') === lower);
  }

  /** Resolve an `@mention` token from a task Discussion (member id | email | email local-part | display
   *  name, spaces collapsed) to a member. Public for the edge mention path. */
  memberForMention(token: string): Member | undefined {
    return this.resolveMember(token);
  }

  /**
   * A task Discussion `@mentioned` a member: post an addressed inbox card (deep-linked to the task) AND
   * fire the out-of-band DM — the ONLY way a Discussion message reaches an Inbox/DM (Decision 3). Mirrors
   * {@link notifyMember} but for the session-less task surface (`task:<id>` sentinel + `args.taskId`).
   */
  mentionMember(taskId: string, byAgent: string, memberId: string, text: string): void {
    this.addMessage({
      type: 'task', sessionId: `task:${taskId}`, agent: byAgent,
      title: 'You were mentioned in a task', body: text, status: 'open',
      args: { taskId, event: 'mention' }, audienceKind: 'member', audienceId: memberId,
    });
    this.audit(`task:${taskId}`, byAgent, 'task.mention', { to: memberId });
    try { this.memberNotifier?.({ sessionId: `task:${taskId}`, agent: byAgent, to: memberId, message: text, important: true }); } catch { /* advisory */ }
  }

  /**
   * A queued wake-up gave up (see `src/edge/wakeups.ts` → `expire`): the agent could not be reached after
   * every retry, so a human is told what never landed. Addressed to the run's owner when there is one,
   * else the admin tier — the alternative is a `pending` row nobody ever reads, which is the exact
   * silence the wake queue exists to end. Deep-links to the source task like any other task card.
   */
  postWakeupExpired(agent: string, source: string, memberId: string | null, text: string): void {
    const body = `This agent could not be woken after repeated attempts, so it never saw:\n\n${text}`;
    this.addMessage({
      type: 'task', sessionId: `task:${source}`, agent,
      title: `Undelivered update for ${agent}`, body, status: 'open',
      args: { taskId: source, event: 'wakeup.expired' },
      audienceKind: memberId ? 'member' : 'admins', audienceId: memberId || undefined,
    });
    if (memberId) {
      try { this.memberNotifier?.({ sessionId: `task:${source}`, agent, to: memberId, message: body, important: true }); } catch { /* advisory */ }
    }
  }

  /**
   * Agent publishes a deliverable to the gallery: snapshots a file from its working folder, records
   * it with full provenance (the session's spawned_by → `source`), posts an 'artifact' inbox card,
   * and audits it. The file path is resolved STRICTLY under the agent's own folder by the store.
   */
  publishArtifact(sessionId: string, input: { path: string; title?: string; description?: string; folder?: string }): { ok: boolean; id?: string; updated?: boolean; error?: string } {
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
    const updated = r.updated === true; // a re-publish that overwrote an existing (agent, folder, filename)
    // The card stashes the artifact id + meta in `args` so the inbox can deep-link into the gallery.
    this.addMessage({
      type: 'artifact', sessionId, agent, title: `Artifact ${updated ? 'updated' : 'published'} — ${agent}`, body: a.title, status: 'open',
      source, args: { artifactId: a.id, filename: a.filename, mime: a.mime, kind: a.kind, updated },
      audienceKind: 'sessionOwner', audienceId: sessionId,
    });
    this.audit(sessionId, agent, updated ? 'artifact.updated' : 'artifact.published', { id: a.id, filename: a.filename, bytes: a.bytes, mime: a.mime, title: a.title, folder: a.folder });
    return { ok: true, id: a.id, updated };
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
  async generateImage(sessionId: string, input: { prompt: string; model?: string; size?: string; n?: number }): Promise<{ ok: boolean; artifacts?: { id: string; filename: string; mime: string }[]; model?: string; costUsd?: number; warning?: string; error?: string; retryable?: boolean; vendor?: string }> {
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
      const info = imageErrorInfo(e);
      this.audit(sessionId, agent, 'image.failed', { model, n, error: info.message, vendor: info.vendor, retryable: info.retryable });
      return { ok: false, error: info.message, retryable: info.retryable, vendor: info.vendor };
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
  async editImage(sessionId: string, input: { image: string; prompt?: string; scale?: number; model?: string; operation?: 'remove-background' }): Promise<{ ok: boolean; artifacts?: { id: string; filename: string; mime: string }[]; model?: string; costUsd?: number; warning?: string; error?: string; retryable?: boolean; vendor?: string }> {
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
      const info = imageErrorInfo(e);
      this.audit(sessionId, agent, 'image.failed', { model, op, error: info.message, vendor: info.vendor, retryable: info.retryable });
      return { ok: false, error: info.message, retryable: info.retryable, vendor: info.vendor };
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
  async generateVideo(sessionId: string, input: { prompt: string; model?: string; durationSec?: number; image?: string }): Promise<{ ok: boolean; status?: 'done' | 'rendering'; jobId?: string; artifact?: { id: string; filename: string; mime: string }; model?: string; costUsd?: number; error?: string; retryable?: boolean; vendor?: string }> {
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
      const info = vendorErrorInfo(e);
      this.audit(sessionId, agent, 'video.failed', { model, error: info.message, vendor: info.vendor, retryable: info.retryable });
      return { ok: false, error: info.message, retryable: info.retryable, vendor: info.vendor };
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
    // Done → download the mp4 (timeout + bounded retry; a stalled/interrupted download is transient) and
    // ingest it as an artifact.
    let bytes: Buffer;
    try {
      const url = poll.video.url;
      bytes = await withRetry(async () => {
        try {
          const res = await timedFetch(url, {}, 60_000, 'video download');
          if (!res.ok) throw new VendorError(`downloading the finished video failed (${res.status})`, retryableStatus(res.status), 'video download', res.status);
          return Buffer.from(await res.arrayBuffer());
        } catch (e) {
          if (e instanceof VendorError) throw e;
          throw new VendorError(`video download failed (${e instanceof Error ? e.message : String(e)})`, true, 'video download');
        }
      });
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
    if (naturalEnd) this.db.prepare("UPDATE term_sessions SET status = 'done', busy_since = NULL, updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
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
      // Mirror the finish back to the chat thread the run came from: an agent that exits WITHOUT calling
      // `report` (the only other mirror point) would otherwise leave its Slack/Discord thread waiting
      // forever. No-op for non-chat runs (no bound thread).
      const inboxLink = consolePage(this.publicOrigin, 'inbox');
      try { this.chatMirror?.(sessionId, (p) => `☑️ ${s.agent} finished — the session ended.\n${chatLink(p, inboxLink, 'Open in Agentric')}`); } catch { /* advisory */ }
    }
    this.audit(sessionId, s.agent, 'session.ended', {});
    this.reliability.forget(sessionId); // drop the loop-detector streak state for this run
  }

  /** A stopped/ended session was reconnected and is live again — the ttyd attach wrapper resurrected
   *  it via `claude --resume`. Flip the row back to `running` so the console shows it active, and drop
   *  an activity note. No-op if the row is already running (or unknown). */
  markResumed(sessionId: string): void {
    const s = this.db.prepare('SELECT agent, status FROM term_sessions WHERE id = ?').get<{ agent: string; status: string }>(sessionId);
    if (!s || s.status === 'running') return;
    // Refresh last_activity too, not just updated_at: a resident chat session resurrected via attach.sh
    // keeps its STALE last_activity (from the original run), so the very next idle sweep would reap it as
    // long-idle within ≤60s ("killed shortly after resumption"). A deliberate re-open means the human is
    // actively using it — give it a fresh idle window (the resident reaper keys off last_activity).
    this.db.prepare("UPDATE term_sessions SET status = 'running', last_activity = ?, updated_at = ? WHERE id = ?").run(Date.now(), Date.now(), sessionId);
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

  /** How far back an episode is compared for an exact duplicate. Long enough to cover a slow-cadence
   *  automation (a daily/weekly sweep that keeps producing the same summary), short enough that a fact
   *  worth re-learning a season later still lands. */
  private static readonly EPISODE_DEDUPE_WINDOW_MS = 30 * 86_400_000;

  /** True when this agent already stored a byte-identical episode inside the dedupe window. Reads the
   *  local `memories` table directly — it is the store for the built-in backend and the mirror for an
   *  external one (see src/memory/mirror.ts), so this holds whichever backend is configured. */
  private recentDuplicateEpisode(agent: string, content: string): boolean {
    try {
      const since = Date.now() - TerminalManager.EPISODE_DEDUPE_WINDOW_MS;
      return !!this.db
        .prepare('SELECT 1 FROM memories WHERE tenant = ? AND agent_id = ? AND content = ? AND created_at >= ? LIMIT 1')
        .get(this.os.tenant, agent, content, since);
    } catch {
      return false; // never let a dedupe read cost us the episode
    }
  }

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
    // A DELETED session has no row. Its audit events survive (the log is append-only), so composing from
    // them would write an episode with no task line, attributed to an agent we can no longer name — junk
    // addressed to nobody. Seen live on instawp: one janitor-reaped run whose row had been deleted
    // mid-flight, whose activity list still carried `session.deleted`.
    const row = this.db.prepare('SELECT task FROM term_sessions WHERE id = ?').get<{ task: string }>(sessionId);
    if (!row) return;
    const task = row.task ?? '';
    const report = this.db.prepare("SELECT outcome, body FROM messages WHERE session_id = ? AND type = 'completed' ORDER BY created_at DESC LIMIT 1").get<{ outcome: string | null; body: string }>(sessionId);
    const events = this.db.prepare('SELECT type, data FROM audit_events WHERE run_id = ? ORDER BY ts').all<{ type: string; data: string }>(sessionId);
    const ep = composeEpisode(task, report, events, outcomeOverride);
    if (!ep) return; // nothing worth remembering
    this.episoded.add(sessionId);
    // A repeat run that produced a byte-identical episode teaches nothing the agent hasn't already stored,
    // and every copy competes for the same top-k recall slot. The live case: one support agent's 2h cron
    // wrote the SAME 1979-char episode 177 times in a month — 7% of that tenant's entire memory, one string.
    // Exact-content match within the recency window, so a genuinely different run is never suppressed.
    if (this.recentDuplicateEpisode(agent, ep.content)) {
      this.audit(sessionId, agent, 'episode.duplicate', { outcome: ep.outcome, source: ep.source });
      return;
    }
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
    if (r.status === 'running') this.db.prepare("UPDATE term_sessions SET status = 'stopped', busy_since = NULL, updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
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
   * Restart a resumable session's agent process IN PLACE, keeping its conversation. Kills the live pane
   * and leaves the session resurrectable (no stop-marker) so the next terminal (re)attach relaunches it
   * via `claude --resume <same claude id>` — the way to pick up a newly-connected MCP server (MCP servers
   * spawn at claude launch, so a running session can't see one added mid-run). Unlike `stopSession` this
   * writes NO 'stopped' episode and drops no resume-block, so the run stays whole: the real end-of-run
   * episode still fires later, and the resurrected pane continues the SAME transcript. The pane dies for
   * < 1s while the frontend remounts the terminal; status flips to 'stopped' meanwhile only to keep the
   * crash-detector (a gone tmux on a 'running' row) from mislabelling the restart. Pending questions/
   * approvals are cancelled — the process is going away and can't answer them. Only a claude-code session
   * with a persisted launch env (resurrectable) can be reloaded. Caller applies the per-member gate.
   *
   * `rotate` additionally moves the session onto ANOTHER pool account before it comes back — the answer to
   * "this run hit its usage limit, put it on a different login without losing the conversation". Rotation
   * is best-effort and never blocks the reload: if there's no second account free, the session reloads on
   * the one it already had and the caller is told why (`note`).
   */
  reloadSession(sessionId: string, by: string, opts?: { rotate?: boolean }): { ok: boolean; error?: string; account?: string; note?: string } {
    const r = this.db.prepare('SELECT agent, tmux, status, spawned_by, run_as FROM term_sessions WHERE id = ?').get<{ agent: string; tmux: string; status: string; spawned_by: string | null; run_as: string | null }>(sessionId);
    if (!r) return { ok: false, error: 'unknown session' };
    // Reload only works for a resurrectable session — one whose persisted launch env attach.sh can
    // `claude --resume` from. A headless run (no env) has nothing to restart into.
    if (!this.os.paths || !fs.existsSync(path.join(this.os.paths.connectors, `session-${sessionId}.env`))) {
      return { ok: false, error: 'this session cannot be reloaded (no resumable conversation)' };
    }
    // Rotate BEFORE killing the pane: the rewrite must be on disk by the time attach.sh sources the env
    // file, and a failure here should leave a live session untouched rather than a dead one un-rotated.
    const rotation = opts?.rotate ? this.rotateSessionAccount(sessionId, r.agent, by) : undefined;
    const space = this.spaceFor(r.run_as ?? r.spawned_by);
    this.captureTranscript(sessionId, space, r.tmux);
    this.backend.kill(space, r.tmux);
    // Park it 'stopped' so the lazy crash-detector (running row + gone tmux → crashed) doesn't fire in the
    // sub-second window before the terminal reattaches and the resume launcher flips it back to 'running'.
    if (r.status === 'running') this.db.prepare("UPDATE term_sessions SET status = 'stopped', busy_since = NULL, updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
    this.clearNotifications(sessionId);
    this.cancelPendingQuestions(sessionId, by);
    this.cancelPendingApprovals(sessionId, by);
    // Deliberate restart — the OPPOSITE of stopSession: clear any stale stop-marker so attach.sh
    // resurrects (`claude --resume`) the moment the terminal reconnects.
    this.allowResume(sessionId);
    this.audit(sessionId, by, 'session.reloaded', { tmux: r.tmux, ...(rotation?.account ? { account: rotation.account } : {}) });
    return { ok: true, ...(rotation?.account ? { account: rotation.account } : {}), ...(rotation?.note ? { note: rotation.note } : {}) };
  }

  /**
   * Move a resumable session onto a different runtime-account before it is resurrected: pick another
   * available account, carry its conversation across, and rewrite the persisted launch env so
   * `attach.sh` → `claude --resume` comes up authenticated as the new one.
   *
   * The conversation is the hard part. Credentials for a pooled account are a whole CONFIG DIR, and claude
   * writes its transcripts under `$CLAUDE_CONFIG_DIR/projects/`, so each account has its own private set.
   * Point a resume at a different dir and claude reports "No conversation found with session ID …" — the
   * rotation would silently cost the user their context. So the transcript is COPIED into the target dir
   * first (copied, not moved: the old account's history stays intact, and a half-finished rotation leaves
   * the session exactly as it was).
   *
   * Never throws — a rotation that can't be completed degrades to an ordinary reload on the current
   * account, with the reason returned for the caller to surface.
   */
  private rotateSessionAccount(sessionId: string, agent: string, by: string): { account?: string; note?: string } {
    try {
      const row = this.db.prepare('SELECT runtime_account, claude_session_id FROM term_sessions WHERE id = ?')
        .get<{ runtime_account: string | null; claude_session_id: string | null }>(sessionId);
      if (!row) return { note: 'unknown session' };
      const manifest = this.os.agents.get(agent);
      const runtime: CodingRuntimeId = isCodingRuntime(manifest?.runtime) ? manifest!.runtime : 'claude-code';
      if (this.os.runtimeAccounts.enabledCount(runtime) === 0) return { note: 'no runtime-account pool configured — reloaded on the box default' };
      // Same narrowing a resident session gets: a reloaded session is long-lived by definition, and a
      // static `token` carries no refresh token into the process, so it would hit /login mid-conversation.
      const acct = this.os.runtimeAccounts.pick(runtime, Date.now(), { kinds: ['oauth', 'apikey'], exclude: row.runtime_account ?? undefined });
      if (!acct) {
        const all = this.os.runtimeAccounts.allLimited(runtime);
        return { note: all.limited ? 'every other account is at its limit — reloaded on the current one' : 'no other account available — reloaded on the current one' };
      }
      const resolved = this.credentialEnvFor(acct, runtime, sessionId, agent);
      if (!resolved) return { note: `could not authenticate as ${acct.name} — reloaded on the current one` };
      // Carry the conversation across. Only meaningful for a credential-DIR account (an api-key account
      // shares the box's dir, so the transcript is already where the resume will look). The transcript we
      // are about to copy lives under the CURRENT account's dir — make sure the reader knows about it, or
      // an account added since boot looks like a session with nothing to resume.
      this.refreshTranscriptRoots();
      if (acct.kind === 'oauth' && acct.configDir && row.claude_session_id) {
        const moved = this.copyTranscriptInto(row.claude_session_id, acct.configDir);
        if (!moved) return { note: `could not carry the conversation to ${acct.name} — reloaded on the current one` };
      }
      if (!this.rewriteLaunchEnv(sessionId, runtime, resolved.vars)) return { note: `could not update the launch env — reloaded on the current one` };
      this.db.prepare('UPDATE term_sessions SET runtime_account = ? WHERE id = ?').run(acct.name, sessionId);
      this.audit(sessionId, by, 'runtime.account.rotated', { runtime, from: row.runtime_account, to: acct.name, kind: acct.kind, via: resolved.varName });
      return { account: acct.name };
    } catch {
      return { note: 'rotation failed — reloaded on the current account' };
    }
  }

  /** Copy a claude transcript into `<configDir>/projects/<same project dir>/` so a resume under that
   *  account finds the conversation. Returns false when the source can't be located (nothing to resume
   *  from — better to abort the rotation than to strand the user on an empty session). Already-there is a
   *  success: re-rotating onto the same dir must be a no-op, not an error. */
  private copyTranscriptInto(claudeSessionId: string, configDir: string): boolean {
    try {
      const src = findTranscript(claudeSessionId);
      if (!src) return false;
      const projectDir = path.basename(path.dirname(src));
      const destDir = path.join(configDir, 'projects', projectDir);
      const dest = path.join(destDir, `${claudeSessionId}.jsonl`);
      if (path.resolve(src) === path.resolve(dest)) return true;
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, dest);
      registerTranscriptRoot(configDir);
      return true;
    } catch {
      return false;
    }
  }

  /** Drop the `UNATTENDED` marker from a taken-over run's persisted launch env, so the next resurrect
   *  (a browser reattach, or the Reload that kills the pane and lets attach.sh bring it back) comes up on
   *  the ATTENDED lane — a human owns this run now, and the unattended lane's server-driven turn-end
   *  teardown is not what they asked for. Best-effort: a run with no env yet has nothing to patch. */
  private attendLaunchEnv(sessionId: string): void {
    if (!this.os.paths) return;
    const file = path.join(this.os.paths.connectors, `session-${sessionId}.env`);
    try {
      const kept = fs.readFileSync(file, 'utf8').split('\n').filter((line) => !/^export UNATTENDED=/.test(line));
      this.writeSecret(file, kept.filter((l) => l.trim() !== '').join('\n') + '\n');
    } catch {
      /* no env (an older run, or a runtime that writes none) — nothing to un-mark */
    }
  }

  /** Rewrite the persisted `session-<id>.env` so a resurrect authenticates with `vars`. Every credential
   *  var this runtime knows is stripped first — rotating from an api-key account to a credential dir must
   *  not leave the old key behind for the CLI to prefer. */
  private rewriteLaunchEnv(sessionId: string, runtime: CodingRuntimeId, vars: Record<string, string>): boolean {
    if (!this.os.paths) return false;
    try {
      const file = path.join(this.os.paths.connectors, `session-${sessionId}.env`);
      const { configDirVar, apiKeyVar, tokenVar } = CODING_RUNTIMES[runtime].credentialEnv;
      const credVars = new Set([configDirVar, apiKeyVar, tokenVar].filter(Boolean) as string[]);
      const kept = fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => {
          const m = /^export ([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
          return !(m && credVars.has(m[1]));
        })
        .filter((line) => line.trim() !== '');
      const body = [...kept, ...Object.entries(vars).map(([k, v]) => `export ${k}=${shSingleQuote(v)}`)].join('\n') + '\n';
      this.writeSecret(file, body);
      return true;
    } catch {
      return false;
    }
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

  /** Give a session a human-chosen display title (the console header + tab strip label). Overrides the
   *  auto-generated/AI-renamed title. Trimmed and capped; an empty title is rejected. Same per-member
   *  gate as rate/stop is applied by the caller. */
  renameSession(sessionId: string, by: Member, title: string): { ok: boolean; error?: string; title?: string } {
    const r = this.db.prepare('SELECT id, agent FROM term_sessions WHERE id = ?').get<{ id: string; agent: string }>(sessionId);
    if (!r) return { ok: false, error: 'unknown session' };
    const clean = title.trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!clean) return { ok: false, error: 'title cannot be empty' };
    this.db.prepare('UPDATE term_sessions SET title = ?, updated_at = ? WHERE id = ?').run(clean, Date.now(), sessionId);
    this.audit(sessionId, by.email, 'session.renamed', { title: clean, agent: r.agent });
    return { ok: true, title: clean };
  }

  /** Hand a session off to another member: reassign its `run_as` — the accountable human it acts as, and
   *  the key its ownership/visibility (`ownsSession`, the sessions list "mine" filter, connectors/identity
   *  of any FUTURE effect) derive from. Provenance (`spawned_by`) is left untouched — the record of what
   *  originally triggered the run doesn't change, only who now owns it going forward. The target must be a
   *  real member; a no-op transfer (already owned by them) succeeds quietly. Audited `session.transferred`.
   *  The caller applies the ownership gate (owner/admin or current owner). */
  transferSession(sessionId: string, by: Member, toMemberId: string): { ok: boolean; error?: string; runAs?: string } {
    const r = this.db.prepare('SELECT id, agent, run_as, title FROM term_sessions WHERE id = ?')
      .get<{ id: string; agent: string; run_as: string | null; title: string | null }>(sessionId);
    if (!r) return { ok: false, error: 'unknown session' };
    const target = this.os.team.getMember(toMemberId);
    if (!target) return { ok: false, error: 'unknown member' };
    if (r.run_as === target.id) return { ok: true, runAs: target.id };
    this.db.prepare('UPDATE term_sessions SET run_as = ?, updated_at = ? WHERE id = ?').run(target.id, Date.now(), sessionId);
    this.audit(sessionId, by.email, 'session.transferred', { from: r.run_as, to: target.id, agent: r.agent });
    // Tell the new owner out-of-band (Slack/Discord DM) — they now own a run they didn't start, and the
    // inbox alone doesn't reach someone who isn't looking at the console. Advisory: never fail the
    // transfer on a notification.
    try { this.transferNotifier?.({ sessionId, agent: r.agent, to: target.id, byName: by.name || by.email, title: r.title ?? undefined }); } catch { /* advisory */ }
    return { ok: true, runAs: target.id };
  }

  /** Path of a session's "do not auto-resurrect" sentinel (see stopSession / attach.sh). */
  private stopMarkerPath(sessionId: string): string | null {
    return this.os.paths ? path.join(this.os.paths.connectors, `session-${sessionId}.stopped`) : null;
  }

  /** Mark a session as "do not auto-resurrect" so the ttyd attach wrapper (attach.sh) won't
   *  `claude --resume` it the next time its dead pane triggers a silent reconnect. Only a session with a
   *  persisted launch env is resurrectable, so there's nothing to block otherwise — skip it (a runtime
   *  that writes no env would only litter the dir). Unattended runs DO write one now, which is exactly
   *  what stops ttyd's auto-reconnect resurrecting a run the turn-end reaper just closed. A deliberate
   *  re-open clears it via `allowResume`. */
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
   * Secrets an owner/admin ASSIGNED to this agent from the Secrets page (the inverse view of the
   * manifest's `shellSecrets`). Each assignment names a stored secret by its (owner-principal, key);
   * we resolve that value and export it as a shell env var named after the key — same mechanism as
   * `injectShellSecrets`, just granted centrally instead of self-declared. `via: 'assignment'` in the
   * audit distinguishes the two paths. Injection only — an assignment never widens `secret_get`.
   */
  private injectAssignedSecrets(env: Record<string, string>, agent: string, sessionId: string): void {
    for (const { principal, key } of this.os.secrets.assignmentsForAgent(this.os.tenant, agent)) {
      const value = this.os.secrets.getSync(this.os.tenant, principal, key);
      if (value === undefined) {
        this.audit(sessionId, agent, 'shell.secret.unresolved', { key, principal, via: 'assignment' });
        continue;
      }
      env[key] = value;
      this.audit(sessionId, agent, 'shell.secret.injected', { key, principal, via: 'assignment' });
    }
  }

  /**
   * Company-bot git baseline (Model C — docs/per-member-github-plan.md). When the GitHub App is
   * configured with an App ID + private key, inject a short-lived, org-scoped **installation token** as
   * `GH_TOKEN`/`GITHUB_TOKEN` so every session can `git push` / `gh pr` on the App's installed repos —
   * the universal default that lets per-agent PATs be retired. Fills the gap ONLY: if an agent already
   * set `GH_TOKEN` (a curated shellSecret/assigned PAT) we leave it, and a connected member's token
   * overrides afterwards. Reads the vault-cached token synchronously (mint is a network call the sync
   * launch path can't await); a near-expiry token is injected as-is while a fire-and-forget refresh
   * rewrites the cache for the next launch, but an ALREADY-EXPIRED one is withheld — see the note on
   * `injectMemberGithub` for why a dead token is worse than none. Audited.
   */
  private injectGithubBaseline(env: Record<string, string>, agent: string, sessionId: string): void {
    if (env.GH_TOKEN) return; // an explicit agent credential wins over the bot baseline
    const gh = new GithubIdentity(this.os);
    const blob = gh.loadBotToken();
    if (!blob) {
      // No cached token yet but the bot IS configured → mint one for the NEXT launch (best-effort).
      if (gh.botConfigured()) void gh.ensureBotToken().catch(() => { /* next launch retries */ });
      return;
    }
    if (gh.isExpired(blob)) {
      // The cache went cold (nothing launched for >1 h). Leave the env unset and re-mint for the next
      // launch rather than hand this run a dead credential.
      this.audit(sessionId, agent, 'github.bot_token.expired', { expiresAt: blob.expiresAt });
      void gh.ensureBotToken().catch(() => { /* next launch retries */ });
      return;
    }
    env.GH_TOKEN = blob.token;
    env.GITHUB_TOKEN = blob.token;
    this.audit(sessionId, agent, 'github.bot_token.injected', { expiresAt: blob.expiresAt });
    if (gh.botNeedsRefresh(blob)) {
      this.audit(sessionId, agent, 'github.bot_token.stale', { expiresAt: blob.expiresAt });
      void gh.ensureBotToken().catch(() => { /* best-effort; next launch retries */ });
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
   *
   * An ALREADY-EXPIRED blob is withheld instead, because a dead token here is strictly worse than no
   * token: `gh` prefers `GH_TOKEN`/`GITHUB_TOKEN` over its keyring, and `configureGitCredentials` resets
   * the inherited git helper for github.com — so a dead string SHADOWS a perfectly good box credential
   * and every `git`/`gh` call hard-fails until the agent strips the var by hand. Leaving the env unset
   * (the same posture `injectShellSecrets` takes for an unresolved key) lets both tools fall back
   * cleanly, and the fire-and-forget refresh still makes the next launch whole. The window this closes
   * is real: the member token lives ~8 h with no proactive refresher, so any run launched after a long
   * quiet gap used to get a corpse.
   */
  private injectMemberGithub(env: Record<string, string>, agent: string, actingMember: string | undefined, sessionId: string): void {
    if (!actingMember) return;
    const gh = new GithubIdentity(this.os);
    const blob = gh.load(actingMember);
    if (!blob) return;
    if (gh.isExpired(blob)) {
      this.audit(sessionId, agent, 'github.token.expired', { login: blob.login, principal: actingMember, expiresAt: blob.expiresAt });
      if (blob.refreshToken) void gh.ensureFresh(actingMember).catch(() => { /* next launch retries */ });
      return; // whatever the bot/agent set stays; if nothing did, `gh` falls back to the box credential
    }
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
    const cfg: string[] = [`# Agentric host connections — session ${sessionId}`, ''];
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
  'session.created', 'session.ended', 'session.reported', 'session.resumed', 'session.reloaded', 'session.stopped',
  'session.error', 'session.tuning', 'session.progress', 'session.notified', 'session.attachment',
  'skills.materialized', 'skills.reloaded', 'skills.error', 'subagents.materialized', 'subagents.error',
  'connector.minted', 'connector.mint.failed',
  'connector.secret.unresolved', 'shell.secret.injected', 'shell.secret.unresolved',
  'gate.attempt', 'gate.killswitch', 'approval.resolved',
  'approval.auto_approved', 'episode.stored', 'episode.error',
  // Launch plumbing — every run emits these before the agent has done anything at all, so on their own
  // they described a session that did NOTHING. Live fleet proof: 72 stored episodes across instapods +
  // instawp whose whole body was "Activity: 1 github.token.injected." ("Task: cred check - stop",
  // "Task: teste"). They were recalled 22 times between them, i.e. they displaced real lessons in a
  // top-k recall for nothing.
  'github.token.injected', 'github.bot_token.injected', 'github.token.refreshed', 'github.token.withheld',
  'runtime.account.selected', 'runtime.account.rotated', 'automation.fired', 'claude.config.isolated',
]);

/** Longest `Task:` line an episode keeps. The task is CONTEXT for the episode, not its content — but it
 *  is stored verbatim, so an unattended run's multi-paragraph cron prompt became the whole memory (automem
 *  caps a memory at 2000 chars, and one live 1979-char support-sweep prompt filled it edge to edge, 177
 *  times over). Keep enough to identify the run, drop the standing-order boilerplate. */
const EPISODE_TASK_MAX = 200;

/** Condense a session's task into one identifying line: first non-empty line, whitespace collapsed,
 *  capped. Empty in → empty out (the caller then omits the line entirely). Pure. */
function episodeTaskLine(task: string): string {
  const firstLine = (task || '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  const body = collapsed.length > EPISODE_TASK_MAX ? `${collapsed.slice(0, EPISODE_TASK_MAX - 1).trimEnd()}\u2026` : collapsed;
  return `Task: ${body}`;
}

/** Friendlier names for the common activity events when summarising a session with no report. */
const EPISODE_LABELS: Record<string, string> = {
  'gate.decision': 'governed actions',
  'capability.invoked': 'tool actions',
  'memory.stored': 'facts remembered',
  'artifact.published': 'artifacts published',
  'artifact.updated': 'artifacts updated',
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
  const taskLine = episodeTaskLine(task);
  const body = (report?.body ?? '').trim();
  // A real agent summary vs the launcher's generic end card ("The session ended." / "…unexpectedly (the
  // process died)." / "(no summary)") — the latter carries no signal, so fall through to the audit summary.
  const hasReport = !!body && !/^\(no summary\)$/i.test(body) && !/^the session ended\b/i.test(body) && !/^session ended\.?$/i.test(body);
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

/** Is this record a session EPISODE rather than a distilled lesson? Tagged `episode` at write time
 *  (`writeEpisode`); the `Task:` opening is the belt-and-braces check for rows stored before the tag, or
 *  by a backend that drops tags on the way back. */
export function isEpisodeRecord(r: { content?: string; tags?: string[] }): boolean {
  if (r.tags?.includes('episode')) return true;
  return /^\s*Task:/.test(r.content ?? '');
}

/**
 * Is this record unfit to be SEEDED into a working agent's prompt?
 *
 * Two classes, both real memories that belong in the store and neither of which helps someone about to do
 * a job:
 *  - an **episode** — a transcript of a past assignment (see {@link isEpisodeRecord});
 *  - a **dreaming summary** — the self-learning pass's own tenant-scoped digest, "Fleet self-learning
 *    (pass 31, since 2026-07-01): 768 sessions, 43% success. Recurring topics: …". That is a statistic
 *    ABOUT the fleet, not knowledge FOR the work, and one is written per pass, so they accumulate.
 *
 * Measured on live tenants: the tenant-shared pool was **51 of 72 memories on instapods and 48 of 85 on
 * instawp** — two thirds of everything shared across the fleet — and because shared memories reach every
 * agent, an agent thin on its own memories got a preamble that was **6 of 8 slots of fleet statistics**.
 * Observed directly: a zero-memory agent's launch preamble carried six pass summaries and nothing about
 * its task.
 *
 * They stay recallable (an oversight agent asking "how is the fleet doing" wants exactly this, and the
 * Memory hub counts them) — they are simply not launch context.
 */
export function isPreambleNoise(r: { content?: string; tags?: string[] }): boolean {
  return isEpisodeRecord(r) || !!r.tags?.includes('dreaming');
}

/** Collapse near-identical entries and cap at `limit`. Two memories that open the same ~80 characters say
 *  the same thing for a reader's purposes — several slots for one fact is the failure this prevents (one
 *  live agent's preamble spent 4 of 8 slots on replays of the same daily sweep). Order is preserved, so
 *  the best-ranked copy of a repeated fact is the one kept. */
export function distinctLines(contents: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of contents) {
    const text = (c ?? '').trim();
    if (!text) continue;
    const key = text.replace(/\s+/g, ' ').slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/** Derive a short, single-line session title from an agent's free-text report summary:
 *  first non-empty line, whitespace collapsed, capped with an ellipsis. Empty in → empty out. */
function titleFromSummary(summary: string): string {
  const firstLine = (summary || '').split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  return collapsed.length > 72 ? `${collapsed.slice(0, 71).trimEnd()}…` : collapsed;
}

/** The prompt handed to an ask_agent delegate: answer the caller's question, then close the loop with
 *  the `answer` tool. Everything the caller receives is the `answer` text — so it must be self-contained. */
function buildAskAgentPrompt(id: string, callerAgent: string, question: string, goal?: string): string {
  const base =
    `Another agent (${callerAgent}) needs your help and is WAITING on your answer.\n\n` +
    `Their question / request:\n${question}\n\n` +
    `Do whatever it takes to answer it — investigate, run tools, reason it through. When you have the ` +
    `answer, call answer({ answer: "<your complete answer>" }). That returns it to ${callerAgent} and ends ` +
    `this run. Put EVERYTHING they need in that one call — they receive only the \`answer\` text, not the ` +
    `rest of your output. If you genuinely cannot help, still call answer with a short explanation of why.`;
  // A `goal` opens the run under a `/goal` convergence condition, so an independent evaluator drives the
  // delegate across turns until the objective holds; it then returns via `answer` in that same turn. The
  // CLI counts the WHOLE payload after `/goal ` (goal + this base, not just the first line) against
  // GOAL_MAX_CHARS, so gate on the full length — else a fitting goal still hard-rejects once base is
  // appended. Over-limit falls back to a plain prompt (the question still carries the objective).
  const converging = !!goal && `${goal}\n\n${base}`.length <= GOAL_MAX_CHARS;
  return converging ? `/goal ${goal}\n\n${base}` : base;
}

function toSession(r: SessionRow): Session {
  return { id: r.id, agent: r.agent, title: r.title, task: r.task, tmux: r.tmux, status: r.status, threadId: r.claude_session_id ?? r.id, spawnedBy: r.spawned_by ?? undefined, runAs: r.run_as ?? undefined, headless: !!r.headless, claimedBy: r.claimed_by ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at ?? r.created_at, rating: r.rating === 'up' || r.rating === 'down' ? r.rating : undefined, ratedBy: r.rated_by ?? undefined, ratedAt: r.rated_at ?? undefined, costUsd: r.cost_usd ?? undefined, tokens: r.cost_usd != null ? { input: r.input_tokens ?? 0, output: r.output_tokens ?? 0, cacheRead: r.cache_read_tokens ?? 0, cacheWrite: r.cache_write_tokens ?? 0 } : undefined, outcome: r.outcome ?? undefined, summary: r.report_summary ?? undefined, activeMs: r.active_ms ?? undefined, turns: r.turns ?? undefined, toolCalls: r.tool_calls ?? undefined, insights: r.gov_approvals != null ? { actions: r.gov_actions ?? 0, approvals: r.gov_approvals, denied: r.gov_denied ?? 0, errors: r.gov_errors ?? 0 } : undefined, model: r.model ?? undefined, effort: r.effort ?? undefined, outputStyle: r.output_style ?? undefined, blockedMs: r.blocked_ms ?? undefined, artifacts: r.artifacts ?? undefined };
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
/** Extract `@mention` tokens from Discussion text (the raw handle/agent-id after `@`, de-duped, lowercased).
 *  Resolution to a member vs an agent — and the escalation it drives — happens at the call site, not here. */
export function parseMentions(text: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|[^\w@])@([a-z0-9][a-z0-9._-]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1].toLowerCase().replace(/[._-]+$/, ''));
  return [...out];
}

function audienceFromColumns(kind: string, id: string | null): Audience | null {
  switch (kind) {
    case 'member': return id ? { kind: 'member', id } : null;
    case 'sessionOwner': return id ? { kind: 'sessionOwner', id } : null;
    case 'admins': return { kind: 'admins' };
    case 'approvers': return id === 'head' || id === 'owner' ? { kind: 'approvers', level: id } : null;
    case 'task': return id ? { kind: 'task', id } : null;
    default: return null;
  }
}

/** The `audience_id` column value for an {@link Audience} (its member id / session id / level; null for
 *  the role-set `admins`) — the inverse of {@link audienceFromColumns}, shared by every card writer. */
function audienceIdOf(a: Audience): string | undefined {
  switch (a.kind) {
    case 'member': return a.id;
    case 'sessionOwner': return a.id;
    case 'task': return a.id;
    case 'approvers': return a.level;
    case 'admins': return undefined;
  }
}


/** Human-readable one-line summary of a goal-edit delta, for the review card + return message. Renders a
 *  status transition as "status draft→active", other fields by name, and a trailing note if present. */
function describeGoalDelta(delta: Record<string, unknown>, note: string | undefined, goal: { status: string }): string {
  const parts: string[] = [];
  if (typeof delta.status === 'string') parts.push(`status ${goal.status}→${delta.status}`);
  if ('title' in delta) parts.push('title');
  if ('body' in delta) parts.push('description');
  if ('target' in delta) parts.push(delta.target ? 'target' : 'clear target');
  if ('labels' in delta) parts.push('labels');
  if ('dueAt' in delta) parts.push(delta.dueAt == null ? 'clear due date' : 'due date');
  if (note) parts.push('a note');
  return parts.length ? parts.join(', ') : 'no fields';
}
