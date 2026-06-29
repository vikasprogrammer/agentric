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
import { mintToolRouterSession, COMPOSIO_KEY_HEADER, serviceUserId } from './connectors/composio';
import { ActionAttempt, ApprovalLevel, AuditEvent, Decision, Member, Role, RunContext, resolveRuntimeTuning } from './types';
import { enrichArgs, autoClearsApproval } from './governance/enricher';
import { LauncherClient } from './edge/launcher';
import { LauncherSessionBackend, LocalSessionBackend, SessionBackend, SpawnErrorSink } from './edge/session-backend';

/** OS-owned operating notes appended to every claude system prompt (after the user's Company context).
 *  Kept terse — it rides in every session's context. */
// Appended to every claude-code agent's system prompt (after the workspace Company context). This is
// the agent's orientation: it is otherwise a stock `claude` dropped into a folder, blind to the OS it
// runs inside. Keep it tight — it costs tokens on every session. Describe the environment and how to
// operate well in it; don't restate what the MCP tool descriptions already say.
const AGENT_OS_OPERATING_NOTES = `# You are running inside Agent OS

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
- \`remember\` durable facts as you go: a decision and its rationale, a fix and its root cause, a stable
  preference. One self-contained fact per memory.

## Talking to the human — use the Inbox, not just the terminal
Your terminal output may not be read. The operator lives in the Inbox:
- \`ask\` when you're blocked on a judgement only the human can make — it waits for their reply. Prefer
  asking over guessing on anything risky or ambiguous.
- \`report\` exactly once when you finish, with the outcome and a one-line summary, so the result is
  visible without anyone reading the terminal.
- \`publish\` real deliverables (a document, PDF, image, chart) to the Artifacts gallery — not scratch
  files.

## Environment notes
- Links aren't clickable in this terminal: always print any URL the user must open or copy
  (OAuth/connect links etc.) in full as plain text, not only as a markdown label.`;

export interface Session {
  id: string;
  agent: string;
  title: string;
  task: string;
  tmux: string;
  status: 'running' | 'idle';
  /** Raw provenance: member id, or `automation:<id>` when a trigger spawned it. */
  spawnedBy?: string;
  /** Human-readable provenance for the console (member name/email, or the automation's name). */
  spawnedByLabel?: string;
  createdAt: number;
}

export interface FeedMessage {
  id: string;
  type: 'task' | 'update' | 'approval' | 'question' | 'completed' | 'artifact';
  sessionId: string;
  agent: string;
  title: string;
  body: string;
  status: 'open' | 'pending' | 'approved' | 'rejected' | 'answered';
  approvalId?: string;
  capability?: string;
  args?: unknown;
  level?: string;
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
  status: 'running' | 'idle';
  spawned_by: string | null;
  run_as: string | null;
  created_at: number;
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
}

/** What the approval-notifier sink receives when a risky action lands an approval card. */
export interface ApprovalNotice {
  sessionId: string;
  agent: string;
  capability: string;
  level: ApprovalLevel;
  reason?: string;
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

  constructor(
    private readonly os: AgentOS,
    private readonly baseUrl: string,
    private readonly tmuxSocket: string,
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
    return spawnedBy && !spawnedBy.startsWith('automation:') ? spawnedBy : 'automations';
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
    // Lazy liveness: a row stays 'running' until its tmux session is gone. Grace-period new rows —
    // tmux may not have finished spawning when the first poll lands.
    const needCheck = rows.some((r) => r.status === 'running');
    if (needCheck) {
      const alive = this.backend.aliveNames(); // null under the launcher backend (poll not available)
      const cutoff = Date.now() - 10_000;
      if (alive) {
        for (const r of rows) {
          if (r.status === 'running' && !alive.has(r.tmux) && r.created_at < cutoff) {
            this.db.prepare("UPDATE term_sessions SET status = 'idle' WHERE id = ?").run(r.id);
            r.status = 'idle';
          }
        }
      }
    }
    const visible = viewer ? rows.filter((r) => this.canViewRow(r.spawned_by, r.run_as, viewer)) : rows;
    return visible.map((r) => ({ ...toSession(r), spawnedByLabel: this.spawnedByLabel(r.spawned_by, r.run_as) }));
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

  /** Whether `viewer` may see a specific session (resolves its provenance + run-as, then the rule). */
  canViewSession(sessionId: string, viewer: Member): boolean {
    const r = this.db.prepare('SELECT spawned_by, run_as FROM term_sessions WHERE id = ?').get<{ spawned_by: string | null; run_as: string | null }>(sessionId);
    return this.canViewRow(r ? r.spawned_by : null, r ? r.run_as : null, viewer);
  }

  /** Whether `viewer` may act on a pending question (resolves its session, then the inbox rule). */
  canViewQuestion(questionId: string, viewer: Member): boolean {
    const q = this.db.prepare('SELECT run_id FROM questions WHERE id = ?').get<{ run_id: string }>(questionId);
    return !!q && this.canViewSession(q.run_id, viewer);
  }

  /**
   * The browser iframe URL to attach to a session's live terminal. Flag off → the shared
   * `/terminal/?arg=…`; flag on → ensures the member's own ttyd is up and returns a per-member
   * `/terminal/<space>/?arg=…` that the app reverse-proxies to that member's port. null if unknown.
   */
  async attachUrl(sessionId: string): Promise<string | null> {
    const r = this.db.prepare('SELECT tmux, spawned_by, run_as FROM term_sessions WHERE id = ?').get<{ tmux: string; spawned_by: string | null; run_as: string | null }>(sessionId);
    if (!r) return null;
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
    const m = this.os.team.getMember(spawnedBy);
    return m ? m.name || m.email : spawnedBy;
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
  listMessages(viewer?: Member): FeedMessage[] {
    // Approval messages take their live status from the approvals table, so the inbox stays
    // correct even after a restart (when the in-memory resolution waiter is gone). We also pull each
    // message's session `spawned_by` so the inbox can be scoped per member (owner/admin see all).
    const rows = this.db
      .prepare(
        `SELECT m.*, a.status AS approval_status, a.reason AS approval_reason, a.resolved_by AS approval_resolved_by,
                q.status AS question_status, q.answer AS question_answer, q.answered_by AS question_answered_by,
                ts.spawned_by AS session_spawned_by, ts.run_as AS session_run_as
         FROM messages m
         LEFT JOIN approvals a ON m.approval_id = a.id
         LEFT JOIN questions q ON m.question_id = q.id
         LEFT JOIN term_sessions ts ON m.session_id = ts.id
         WHERE m.dismissed_at IS NULL
         ORDER BY m.created_at DESC`,
      )
      .all<MessageRow>();
    const visible = viewer ? rows.filter((r) => this.canViewRow(r.session_spawned_by ?? null, r.session_run_as ?? null, viewer)) : rows;
    return visible.map(toMessage);
  }

  /**
   * Dismiss a message from the inbox (soft hide — the row stays for audit, `dismissed_at` is set).
   * Same visibility rule as the feed (`canViewSpawn`), and we refuse to dismiss an item still waiting
   * on the human — a pending approval/question must be resolved/answered, not swept under the rug.
   */
  dismissMessage(id: string, viewer: Member): 'ok' | 'not_found' | 'forbidden' | 'pending' {
    const row = this.db
      .prepare(
        `SELECT m.type, a.status AS approval_status, q.status AS question_status, ts.spawned_by AS session_spawned_by, ts.run_as AS session_run_as
         FROM messages m
         LEFT JOIN approvals a ON m.approval_id = a.id
         LEFT JOIN questions q ON m.question_id = q.id
         LEFT JOIN term_sessions ts ON m.session_id = ts.id
         WHERE m.id = ?`,
      )
      .get<{ type: FeedMessage['type']; approval_status: string | null; question_status: string | null; session_spawned_by: string | null; session_run_as: string | null }>(id);
    if (!row) return 'not_found';
    if (!this.canViewRow(row.session_spawned_by ?? null, row.session_run_as ?? null, viewer)) return 'forbidden';
    const stillWaiting =
      (row.type === 'approval' && (row.approval_status ?? 'pending') === 'pending') ||
      (row.type === 'question' && (row.question_status ?? 'pending') === 'pending');
    if (stillWaiting) return 'pending';
    this.db.prepare('UPDATE messages SET dismissed_at = ? WHERE id = ?').run(Date.now(), id);
    return 'ok';
  }

  /**
   * Spawn a session. `headless` (used by automations) runs claude non-interactively (`claude -p`):
   * it works the task to completion and exits, so the pane dies, the session flips to `idle`, and
   * the automations pile-up guard releases. Interactive (the default, e.g. manual spawns) opens a
   * normal attachable TUI that stays live until closed.
   */
  createSession(agent: string, title: string, task: string, spawnedBy?: string, headless = false, slack?: { channel: string; threadTs: string }, discord?: { channel: string; messageId: string }, runAs?: string): Session {
    const id = randomUUID().slice(0, 8);
    const tmux = `aos-${id}`;
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
    const session: Session = { id, agent, title, task, tmux, status: 'running', createdAt: Date.now() };
    this.db
      .prepare('INSERT INTO term_sessions (id, agent, title, task, tmux, status, spawned_by, run_as, secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(session.id, agent, title, task, tmux, 'running', spawnedBy ?? null, actingMember ?? null, secret, session.createdAt);
    this.addMessage({ type: 'task', sessionId: id, agent, title: `(New Session) ${agent}`, body: task, status: 'open', source: spawnedBy });

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
    this.audit(id, agent, 'session.created', { tmux, task, runtime, dir: manifest?.dir, headless, spawnedBy: spawnedBy ?? null, runAs: actingMember ?? null });

    if (runtime === 'claude-code' && manifest?.dir) {
      // Real claude in the agent's own folder, governed by the gate hook. Memory and connectors
      // are delivered PURELY as MCP tools (recall/remember) via the per-session `.mcp.json` — the
      // orchestrator injects nothing into the prompt. When/whether to recall or remember is the
      // agent's own decision, guided by its CLAUDE.md and the tools' own descriptions.
      const env = this.sessionEnv(id, agent, task, secret);
      // Build the per-session connector + company payloads once (Composio is minted here).
      const mcpJson = this.buildMcpConfigJson(id, agent, actingMember, secret, !!slack?.channel, !!discord?.channel);
      const companyMd = this.buildCompanyMd();
      this.materializeSkills(id, agent, manifest.dir);
      if (headless) env.HEADLESS = '1';
      env.AGENT_DIR = manifest.dir;
      env.HOOK = this.hook;
      // Per-agent model / effort / permission, each falling back to the workspace default. The
      // launcher (claude-launch.sh) turns these into `--model` / `--effort` / `--permission-mode`.
      // Resolved here (not in bash) so the resume env file captures the exact values a reconnect re-uses.
      const tuning = resolveRuntimeTuning(manifest, this.os.settings.runtimeDefaults());
      if (tuning.model) env.CLAUDE_MODEL = tuning.model;
      if (tuning.effort) env.CLAUDE_EFFORT = tuning.effort;
      if (tuning.permissionMode) env.CLAUDE_PERMISSION_MODE = tuning.permissionMode;
      this.audit(id, agent, 'session.tuning', { model: tuning.model, effort: tuning.effort, permissionMode: tuning.permissionMode });
      // A stable claude session id we choose (vs letting claude mint its own), so a stopped session
      // can be resumed in-place with `claude --resume <id>` when the user reconnects in the browser.
      env.CLAUDE_SESSION_ID = randomUUID();

      if (this.uidIsolation) {
        // Flag on: the launcher writes the files INTO the member's home (member-readable), copies the
        // agent dir to a per-member working copy (AGENT_DIR override), and sets MCP_CONFIG/COMPANY_FILE/
        // LOG_DIR itself — the app dir is unreadable/unwritable by the member uid.
        this.backend.spawn(this.spaceFor(actingMember ?? spawnedBy), { sessionId: id, agent, tmuxName: tmux, env, argv: ['bash', this.launcher], files: { mcp: mcpJson || undefined, company: companyMd || undefined }, agentSrc: manifest.dir });
      } else {
        // Flag off: materialise into the app's connectors dir (the session runs as the app uid, so it
        // can read them), set the env, and persist the launch context so the ttyd attach wrapper can
        // resurrect a dead session (terminal/attach.sh). Headless automation runs aren't resumable.
        const mcpFile = this.writeSessionFile(id, 'mcp.json', mcpJson);
        if (mcpFile) env.MCP_CONFIG = mcpFile;
        const companyFile = this.writeSessionFile(id, 'company.md', companyMd);
        if (companyFile) env.COMPANY_FILE = companyFile;
        if (headless) env.LOG_DIR = this.os.paths?.connectors ?? '/tmp';
        if (!headless) this.writeEnvFile(id, env);
        this.backend.spawn(this.spaceFor(actingMember ?? spawnedBy), { sessionId: id, agent, tmuxName: tmux, env, argv: ['bash', this.launcher] });
      }
    } else {
      this.backend.spawn(this.spaceFor(actingMember ?? spawnedBy), { sessionId: id, agent, tmuxName: tmux, env: this.sessionEnv(id, agent, task, secret), argv: ['bash', this.runner] });
    }
    return session;
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
  private buildCompanyMd(): string {
    const company = this.os.settings.company().companyMd.trim();
    // Close the self-learning loop: the Dreamer's distilled guidance rides in every agent's prompt, so
    // the fleet's accumulated experience shapes each new session. Toggleable in Settings → Self-learning.
    const learned = this.os.settings.applyLearnings() ? this.os.settings.learnedGuidance().trim() : '';
    return [company, AGENT_OS_OPERATING_NOTES, learned].filter(Boolean).join('\n\n');
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
      // so other agents aren't cluttered by it.
      env: { AOS_URL: this.baseUrl, AOS_TENANT: this.os.tenant, SESSION: sessionId, AGENT: agent, AOS_SECRET: secret, ...(slackReply ? { SLACK_REPLY: '1' } : {}), ...(discordReply ? { DISCORD_REPLY: '1' } : {}) },
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
      const names = this.os.skills.materialize(path.join(agentDir, '.claude'));
      if (names.length) this.audit(sessionId, agent, 'skills.materialized', { count: names.length, skills: names });
    } catch (e) {
      this.audit(sessionId, agent, 'skills.error', { error: String(e) });
    }
  }

  say(sessionId: string, body: string): void {
    const s = this.db.prepare('SELECT agent FROM term_sessions WHERE id = ?').get<{ agent: string }>(sessionId);
    if (!s) return;
    this.addMessage({ type: 'update', sessionId, agent: s.agent, title: `Task Update (${s.agent})`, body, status: 'open' });
  }

  /** The gate. Same policy brain as the console — allow flows, ask → inbox approval (auto-cleared for
   *  an attended approver), never → deny. Args are enriched into facts first (the single classifier). */
  gate(sessionId: string, agent: string, capability: string, rawArgs: Record<string, unknown>, reasoning: string): GateResult {
    // Workspace emergency stop — deny every action before classifying anything.
    if (this.os.settings.killSwitch().engaged) {
      this.audit(sessionId, agent, 'gate.killswitch', { capability });
      return { decision: 'deny' };
    }
    const args = enrichArgs(capability, rawArgs);
    const attempt: ActionAttempt = { capabilityId: capability, args, reasoning };
    const decision: Decision = this.os.policy.classify(attempt, this.ctx(sessionId, agent));
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
    });
    this.audit(sessionId, agent, 'approval.requested', { approvalId: req.id, level: decision.level, capability });
    // Out-of-band ping (Slack/Discord DM to whoever can approve) — best-effort, never blocks the gate.
    try { this.approvalNotifier?.({ sessionId, agent, capability, level: decision.level, reason: decision.reason }); } catch { /* notifications are advisory */ }

    // The message + gate status are derived from the approvals table at read time, so all this
    // waiter has to do is leave an audit trail. (It won't fire across a restart — that's fine.)
    settle.then((approved) => this.audit(sessionId, agent, 'approval.resolved', { approvalId: req.id, approved }));
    return { decision: 'pending', gateId: req.id };
  }

  /**
   * Dry-run the policy for a hypothetical attempt — the SAME brain the gate uses, but pure: no
   * approval card, no audit, no side effect. Lets an agent learn ahead of time whether an action is
   * allowed / needs approval / denied (via the policy_check + list_capabilities MCP tools), so it can
   * plan instead of discovering its limits only when the gate blocks it. Works for any capability
   * string — classify falls back to the ruleset's defaultRisk for ones with no matching rule.
   */
  policyCheck(sessionId: string, agent: string, capability: string, args: Record<string, unknown>): Decision {
    if (this.os.settings.killSwitch().engaged) return { effect: 'deny', reason: 'workspace emergency stop is engaged' };
    return this.os.policy.classify({ capabilityId: capability, args: enrichArgs(capability, args), reasoning: '' }, this.ctx(sessionId, agent));
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
    return 'deny'; // rejected or unknown
  }

  private addMessage(m: Omit<FeedMessage, 'id' | 'createdAt'>): void {
    this.db
      .prepare('INSERT INTO messages (id, type, session_id, agent, title, body, status, approval_id, capability, args, level, source, question_id, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        randomUUID().slice(0, 8), m.type, m.sessionId, m.agent, m.title, m.body, m.status,
        m.approvalId ?? null, m.capability ?? null, m.args !== undefined ? JSON.stringify(m.args) : null,
        m.level ?? null, m.source ?? null, m.questionId ?? null, m.outcome ?? null, Date.now(),
      );
  }

  // ── session lifecycle → inbox ────────────────────────────────────────────────
  /** Agent asks the human a question (the ask-human channel). Returns the question id to poll. */
  askQuestion(sessionId: string, agent: string, prompt: string): { id: string } {
    const id = randomUUID().slice(0, 8);
    this.db
      .prepare('INSERT INTO questions (id, run_id, tenant, agent, prompt, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, this.os.tenant, agent, prompt, 'pending', Date.now());
    this.addMessage({ type: 'question', sessionId, agent, title: `Question — ${agent}`, body: prompt, status: 'pending', questionId: id });
    this.audit(sessionId, agent, 'question.asked', { questionId: id, prompt });
    return { id };
  }

  /** A human answers a pending question (from the inbox). */
  answerQuestion(id: string, answer: string, by: string): boolean {
    const q = this.db.prepare('SELECT run_id, agent, status FROM questions WHERE id = ?').get<{ run_id: string; agent: string; status: string }>(id);
    if (!q || q.status !== 'pending') return false;
    this.db.prepare('UPDATE questions SET status = ?, answer = ?, answered_by = ?, answered_at = ? WHERE id = ?').run('answered', answer, by, Date.now(), id);
    this.audit(q.run_id, by, 'question.answered', { questionId: id });
    return true;
  }

  /** Question status + answer for the polling ask-human MCP tool. */
  questionStatus(id: string): { status: 'pending' | 'answered'; answer?: string } {
    const q = this.db.prepare('SELECT status, answer FROM questions WHERE id = ?').get<{ status: string; answer: string | null }>(id);
    if (!q) return { status: 'pending' };
    return { status: q.status === 'answered' ? 'answered' : 'pending', answer: q.answer ?? undefined };
  }

  /** Agent self-reports a finished task: emits a 'completed' card with outcome + summary. */
  report(sessionId: string, agent: string, outcome: string, summary: string): void {
    if (this.hasCompleted(sessionId)) return;
    this.addMessage({ type: 'completed', sessionId, agent, title: `Completed — ${agent}`, body: summary || '(no summary)', status: 'open', outcome });
    this.db.prepare("UPDATE term_sessions SET status = 'idle' WHERE id = ?").run(sessionId);
    this.audit(sessionId, agent, 'session.reported', { outcome, summary });
  }

  /**
   * Agent publishes a deliverable to the gallery: snapshots a file from its working folder, records
   * it with full provenance (the session's spawned_by → `source`), posts an 'artifact' inbox card,
   * and audits it. The file path is resolved STRICTLY under the agent's own folder by the store.
   */
  publishArtifact(sessionId: string, input: { path: string; title?: string; description?: string }): { ok: boolean; id?: string; error?: string } {
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
      sessionId, agent, source, title, description: input.description,
      allowRoot: manifest.dir, srcPath: input.path,
    });
    if (!r.ok) return { ok: false, error: r.error };
    const a = r.artifact;
    // The card stashes the artifact id + meta in `args` so the inbox can deep-link into the gallery.
    this.addMessage({
      type: 'artifact', sessionId, agent, title: `Artifact — ${agent}`, body: a.title, status: 'open',
      source, args: { artifactId: a.id, filename: a.filename, mime: a.mime, kind: a.kind },
    });
    this.audit(sessionId, agent, 'artifact.published', { id: a.id, filename: a.filename, bytes: a.bytes, mime: a.mime, title: a.title });
    return { ok: true, id: a.id };
  }

  /** Launcher signal that claude exited. Emits a generic 'completed' card unless the agent already
   *  reported a richer outcome, and marks the session idle. */
  markEnded(sessionId: string): void {
    const s = this.db.prepare('SELECT agent FROM term_sessions WHERE id = ?').get<{ agent: string }>(sessionId);
    if (!s) return;
    this.db.prepare("UPDATE term_sessions SET status = 'idle' WHERE id = ?").run(sessionId);
    // Distil the session into one durable memory for the agent — BEFORE the generic card below, so we
    // can read the agent's own `report` summary if it left one (any 'completed' row at this point is a
    // real report; the generic one is added just after). Best-effort; never blocks the end signal.
    this.writeEpisode(sessionId, s.agent);
    if (this.hasCompleted(sessionId)) return;
    this.addMessage({ type: 'completed', sessionId, agent: s.agent, title: `Ended — ${s.agent}`, body: 'Session ended.', status: 'open', outcome: 'unknown' });
    this.audit(sessionId, s.agent, 'session.ended', {});
  }

  /** Sessions already turned into an episode this process — belt-and-braces with the audit_events
   *  marker below, so a doubled `/api/ended` can't write two episodes for one session. */
  private readonly episoded = new Set<string>();

  /**
   * Write one end-of-session **episode** — a durable `Insight` memory for the agent — so a future
   * session can `recall` what this one did. Prefers the agent's own `report` summary; failing that,
   * summarises the session's audit stream. Skips sessions that did nothing worth remembering. Stores
   * via the live memory provider (so episodes are recalled like any memory); best-effort + idempotent.
   */
  private writeEpisode(sessionId: string, agent: string, outcomeOverride?: string): void {
    if (this.episoded.has(sessionId)) return;
    if (this.db.prepare("SELECT 1 FROM audit_events WHERE run_id = ? AND type = 'episode.stored'").get(sessionId)) return;
    const task = this.db.prepare('SELECT task FROM term_sessions WHERE id = ?').get<{ task: string }>(sessionId)?.task ?? '';
    const report = this.db.prepare("SELECT outcome, body FROM messages WHERE session_id = ? AND type = 'completed' ORDER BY created_at DESC LIMIT 1").get<{ outcome: string | null; body: string }>(sessionId);
    const events = this.db.prepare('SELECT type FROM audit_events WHERE run_id = ? ORDER BY ts').all<{ type: string }>(sessionId);
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
        metadata: { sessionId, outcome: ep.outcome, source: ep.source },
      })
      .then(() => this.audit(sessionId, agent, 'episode.stored', { outcome: ep.outcome, source: ep.source }))
      .catch((e) => this.audit(sessionId, agent, 'episode.error', { error: e instanceof Error ? e.message : String(e) }));
  }

  /** A stopped/ended session was reconnected and is live again — the ttyd attach wrapper resurrected
   *  it via `claude --resume`. Flip the row back to `running` so the console shows it active, and drop
   *  an activity note. No-op if the row is already running (or unknown). */
  markResumed(sessionId: string): void {
    const s = this.db.prepare('SELECT agent, status FROM term_sessions WHERE id = ?').get<{ agent: string; status: string }>(sessionId);
    if (!s || s.status === 'running') return;
    this.db.prepare("UPDATE term_sessions SET status = 'running' WHERE id = ?").run(sessionId);
    this.addMessage({ type: 'update', sessionId, agent: s.agent, title: `Resumed — ${s.agent}`, body: 'Session reconnected and resumed.', status: 'open' });
    this.audit(sessionId, s.agent, 'session.resumed', {});
  }

  private hasCompleted(sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM messages WHERE session_id = ? AND type = 'completed'").get(sessionId);
  }

  // ── session management / cleanup ─────────────────────────────────────────────
  /**
   * Stop a running session: kill its tmux shell (terminate a runaway/hung agent) and flip the row
   * to `idle`. The row, its messages and on-disk files all stay — this is "halt", not "remove".
   * Emits a 'completed'/stopped card so the inbox reflects the interruption. No-op on unknown id.
   */
  stopSession(sessionId: string, by: string): boolean {
    const r = this.db.prepare('SELECT agent, tmux, status, spawned_by, run_as FROM term_sessions WHERE id = ?').get<{ agent: string; tmux: string; status: string; spawned_by: string | null; run_as: string | null }>(sessionId);
    if (!r) return false;
    this.backend.kill(this.spaceFor(r.run_as ?? r.spawned_by), r.tmux);
    if (r.status === 'running') this.db.prepare("UPDATE term_sessions SET status = 'idle' WHERE id = ?").run(sessionId);
    // Halting kills the tmux shell, so the launcher's /api/ended never fires — capture the episode
    // here instead, BEFORE the 'Stopped' card so it summarises the work done (audit stream) rather
    // than reading the stop note. Outcome 'stopped'; skipped if the session did nothing.
    this.writeEpisode(sessionId, r.agent, 'stopped');
    if (!this.hasCompleted(sessionId)) {
      this.addMessage({ type: 'completed', sessionId, agent: r.agent, title: `Stopped — ${r.agent}`, body: `Session stopped by ${by}.`, status: 'open', outcome: 'unknown' });
    }
    this.audit(sessionId, by, 'session.stopped', { tmux: r.tmux });
    return true;
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
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM questions WHERE run_id = ?').run(sessionId);
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
        if (f.startsWith(prefix)) fs.rmSync(path.join(dir, f), { force: true });
      }
    } catch {
      /* dir may not exist yet — nothing to clean */
    }
  }

  private audit(sessionId: string, principal: string, type: string, data: Record<string, unknown>): void {
    const ev: AuditEvent = { ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal, type, data };
    this.os.audit.append(ev);
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

function toSession(r: SessionRow): Session {
  return { id: r.id, agent: r.agent, title: r.title, task: r.task, tmux: r.tmux, status: r.status, spawnedBy: r.spawned_by ?? undefined, createdAt: r.created_at };
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
    source: r.source ?? undefined,
    questionId: r.question_id ?? undefined,
    answer: r.question_answer ?? undefined,
    outcome: r.outcome ?? undefined,
    policyReason: r.type === 'approval' ? r.approval_reason ?? undefined : undefined,
    resolvedBy: r.type === 'approval' ? r.approval_resolved_by ?? undefined : undefined,
    answeredBy: r.type === 'question' ? r.question_answered_by ?? undefined : undefined,
    createdAt: r.created_at,
  };
}

/** Audit types that are session plumbing, not work — they don't, on their own, make an episode. */
const EPISODE_NOISE = new Set([
  'session.created', 'session.ended', 'session.reported', 'session.resumed', 'session.stopped',
  'connector.minted', 'connector.mint.failed', 'episode.stored', 'episode.error',
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

/**
 * Turn a finished session into the body of one `Insight` memory — or null when there's nothing worth
 * remembering. Prefers the agent's own end-of-session `report` summary; otherwise distils the audit
 * stream into a short "what this session did" line. Pure (no I/O) so it's trivially testable.
 */
function composeEpisode(
  task: string,
  report: { outcome: string | null; body: string } | undefined,
  events: { type: string }[],
  outcomeOverride?: string,
): { content: string; outcome: string; source: 'report' | 'audit'; importance: number } | null {
  const taskLine = task.trim() ? `Task: ${task.trim()}` : '';
  const body = (report?.body ?? '').trim();
  const hasReport = !!body && body !== '(no summary)' && body !== 'Session ended.';
  if (hasReport) {
    // The agent's own summary wins — even if the session was later stopped, its report stands.
    const outcome = report?.outcome || 'unknown';
    const content = [taskLine, `Outcome: ${outcome}`, '', body].filter((l) => l !== '').join('\n').trim();
    return { content, outcome, source: 'report', importance: 0.7 };
  }
  // No usable report → summarise the audit stream. Skip if the session did no real work.
  const acts = events.filter((e) => !EPISODE_NOISE.has(e.type));
  if (!acts.length) return null;
  const counts = new Map<string, number>();
  for (const e of acts) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const parts = [...counts].map(([t, n]) => `${n} ${EPISODE_LABELS[t] ?? t}`);
  const outcome = outcomeOverride || report?.outcome || 'unknown';
  const content = [taskLine, `Outcome: ${outcome}`, `Activity: ${parts.join(', ')}.`].filter((l) => l !== '').join('\n').trim();
  return { content, outcome, source: 'audit', importance: 0.5 };
}
