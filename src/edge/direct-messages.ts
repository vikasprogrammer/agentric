/**
 * Direct messages — talking to an agent the way you talk to a teammate.
 *
 * The console's **Messages** page shows a contact list and one endless conversation per contact.
 * Underneath, an agent is still a governed session (tmux pane, transcript, gate hook, approvals) —
 * nothing about governance changes here. What this file does is keep that machinery OUT of the
 * person's way:
 *
 *  - **One room per (member, agent), for ever.** The room's messages are rows in `chat_messages`
 *    (src/state/chat-rooms.ts), so the conversation outlives any one session.
 *  - **The session is plumbing.** Sending a message delivers into the room's warm session, resumes
 *    it cold if it was reaped, and quietly starts a NEW one — seeded with a recap of the recent
 *    conversation — when the old one is gone, unusable, or its transcript has grown past
 *    `ROLLOVER_BYTES` (every poll of a live turn re-parses the transcript, and it only ever grows).
 *  - **A turn becomes one message.** `sync` folds the transcript into the room: everything the agent
 *    did between two human messages collapses into ONE agent message — its last piece of prose —
 *    with the tool calls and interim narration kept as expandable `steps`. Until the turn ends the
 *    reader sees a typing indicator naming the current step, not a stream of tool calls.
 *
 * Only AGENT prose is read from the transcript. Human messages are written to the room when they
 * are sent, which is what keeps harness-injected "user" text (compaction summaries, wake-ups,
 * system reminders) from ever showing up as something the person said.
 */
import type { AgentOS } from '../kernel';
import type { TerminalManager } from '../terminal';
import { runtimeSupports, type Member } from '../types';
import { EventEmitter } from 'node:events';
import type { ChatJob, ChatMessage, ChatParticipant, ChatRoom, ChatStep, NotifyLevel, OrchestrateMode } from '../state/chat-rooms';
import { routerBrain, type Brain } from './router';
import type { ChatTurn } from './conversation';

/** Past this, the next message starts a fresh session (with a recap) instead of resuming this transcript. */
const ROLLOVER_BYTES = 6 * 1024 * 1024;
/** How much of the recent conversation a fresh session is told about. */
const RECAP_MESSAGES = 12;
const RECAP_CHARS = 700;
const MAX_STEPS = 60;
const STEP_CHARS = 1500;
/** How long a sent message may sit with nothing running before the UI offers a retry. */
const STALL_MS = 20_000;
/** `/new` alone starts a new session; `/new <text>` starts one and sends `<text>` into it. */
const NEW_COMMAND = /^\/new(?:\s+([\s\S]+))?$/i;
export const NEW_SESSION_MARKER = 'New session';
/** A reply is only folded once its transcript has been quiet this long. The session's `working` flag is
 *  the main signal, but it can read false for a moment mid-turn (seen live right after launch) — and a
 *  reply folded then is cut in half: the interim note becomes "the message" and its steps are lost. */
const SETTLE_MS = 2500;
/** A turn that ended having said nothing (tool calls only) is dropped after this, not waited on for ever. */
const TEXTLESS_DROP_MS = 45_000;

export interface DmTyping { label: string; steps: ChatStep[]; since?: number; /** the thread the turn in flight is answering in */ thread?: number | null }
/** One thread: the message it hangs off and the replies under it. */
export interface ThreadView { root: RoomMessage; replies: RoomMessage[] }

// Every message handed to an agent ends with a tag saying where it was said — the main stream or a
// thread. The transcript keeps the tag, so when the reply is folded back in, the fold can tell which
// thread it belongs to without any state of its own (a queue would desync the moment a turn was
// interrupted or a harness wake-up slipped in between). An untagged user turn inherits the last tag.
const tagFor = (thread?: number | null): string => (thread ? `[[thread:${thread}]]` : '[[main]]');
function threadOfTurn(text: string): number | null | undefined {
  let found: number | null | undefined;
  for (const m of text.matchAll(/\[\[(main|thread:(\d+))\]\]/g)) found = m[2] ? Number(m[2]) : null;
  return found;
}
function threadBefore(turns: ChatTurn[], i: number): number | null {
  for (let k = Math.min(i, turns.length) - 1; k >= 0; k--) {
    const t = turns[k];
    if (t.kind !== 'user') continue;
    const x = threadOfTurn(t.text);
    if (x !== undefined) return x;
  }
  return null;
}
export type DmPresence = 'working' | 'online' | 'away';

export interface DmContact {
  agent: string; roomId: string; description: string; icon?: string;
  presence: DmPresence; lastText?: string; lastFromMe?: boolean; lastAt: number; unread: number; notify: NotifyLevel;
  /** The session currently behind the room — used only to attach pending approvals/questions. */
  sessionId: string | null;
}

export interface DmThread {
  agent: string; roomId: string; sessionId: string | null; presence: DmPresence;
  messages: ChatMessage[]; typing: DmTyping | null;
  cardSessionIds: string[]; jobs: DmJob[]; handoffs: DmHandoff[];
  /** Present when the request named a thread. */
  threadView?: ThreadView | null;
  /** The member's last message got no reply and nothing is running that could produce one. */
  stalled: boolean;
}

// ── Rooms & group DMs (kind 'room') ──
export interface RoomPerson { id: string; name: string; avatar?: string }
export interface RoomAgent { id: string; description: string; icon?: string; presence: DmPresence }
export interface RoomSummary {
  id: string; name: string | null; members: RoomPerson[]; agents: RoomAgent[]; createdBy: string; orchestrate: OrchestrateMode;
  /** The orchestrator's rolling summary of the room, once there is enough to summarise. */
  summary?: string;
  lastText?: string; lastAuthor?: string; lastAt: number; unread: number;
  /** Unread messages that @mention the viewer, and the viewer's notification level here. */
  mentions: number; notify: NotifyLevel;
}
export type RoomMessage = ChatMessage & { authorName: string; authorIcon?: string; authorAvatar?: string };
export interface RoomThread {
  room: RoomSummary; messages: RoomMessage[];
  typing: { agent: string; label: string; steps: ChatStep[]; thread?: number | null; since?: number }[];
  threadView?: ThreadView | null;
  /** Sessions behind the room's agents — used only to attach pending approvals/questions. */
  sessionIds: string[];
  cardSessionIds: string[]; jobs: DmJob[]; handoffs: DmHandoff[];
  /** Other people typing in the room right now (first names). */
  peopleTyping: string[];
}
export type RoomSendResult =
  | { ok: true; message: ChatMessage | null; delivered: string[]; notes: string[] }
  | { ok: false; status: number; error: string; held?: boolean };
type Fail = { ok: false; status: number; error: string };
const MAX_ROOM_PEOPLE = 30;
const MAX_ROOM_AGENTS = 8;
const ROOM_CONTEXT_MESSAGES = 20;
const pretty = (id: string): string => id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export type DmSendResult =
  | { ok: true; message: ChatMessage | null; sessionId: string | null; notes?: string[] }
  | { ok: false; status: number; error: string; held?: boolean };

/** One agent's session inside one room, as the sync sees it. */
interface Lane {
  key: string; roomId: string; agent: string; sessionId: string | null; syncedTurns: number; syncedMark: string | null;
  save(turns: number, mark: string): void;
  /** Put a finished reply into the room (and do whatever a reply there triggers). */
  post(m: { body: string; steps: ChatStep[]; at: number; took?: number }, thread: number | null): void;
}

/** Fires `changed` (with the AgentOS it happened in) whenever a room gains a message — what the chat
 *  socket listens to so another person's message shows up at once instead of on the next look. */
export const chatBus = new EventEmitter();
chatBus.setMaxListeners(0);

/** How an away-ping reaches a person (Slack/Discord DM via the identity map) — set per tenant at boot. */
/** The orchestrator's model, per tenant — set by tests; otherwise the router's own (`routerBrain`). */
const brains = new WeakMap<AgentOS, Brain>();
export function setRoomBrain(os: AgentOS, brain: Brain | null): void { if (brain) brains.set(os, brain); else brains.delete(os); }
/** Rooms with a routing decision in flight. */
const routing = new Set<string>();
/** An untagged message right after an agent's reply (same stream, within this long) is still for that agent. */
const STICKY_MS = 10 * 60_000;
/** Confidence needed to hand a message over without asking, and to even suggest it. */
const ROUTE_AUTO_AT = 0.6;
const ROUTE_SUGGEST_AT = 0.35;
/** The orchestrator posts under this name (a merged answer, a nudge). It is not an agent and runs nothing. */
export const ORCHESTRATOR = 'orchestrator';
/** How long a fan-out waits for a straggler before merging what it has. */
const FANOUT_WAIT_MS = 10 * 60_000;
const MERGE_SYSTEM = [
  'You coordinate a team chat room. One person asked something and several AI agents each answered separately.',
  'Write the ONE reply that person needs, in plain language, at most 150 words:',
  '- Lead with the answer or recommendation.',
  '- Say where the agents agree; where they differ, say who said what and which you would go with and why.',
  '- Do not repeat their answers in full, do not add facts they did not give, no preamble, no sign-off.',
].join('\n');
/** Working this long AND silent this long → the room is told. Waiting on a person this long → they are tagged. */
const STUCK_WORKING_MS = 10 * 60_000;
const STUCK_QUIET_MS = 4 * 60_000;
const STUCK_WAITING_MS = 3 * 60_000;
const nudged = new Set<string>();
/** A room is summarised every this-many new messages; the latest few stay out of the summary, verbatim. */
const SUMMARY_EVERY = 30;
const SUMMARY_KEEP = 10;
const summarising = new Set<string>();
const SUMMARY_SYSTEM = [
  'You keep the running summary of a team chat room, so that someone (or an AI agent) joining late can catch up in seconds.',
  'Given the summary so far and the new messages, write the UPDATED summary — at most 180 words, plain prose or a few short bullets:',
  '- what is being worked on and why, decisions made (and by whom), what is still open, who is doing what.',
  '- Keep names. Drop greetings, thanks and chatter. Do not invent anything. Output only the summary.',
].join('\n');
const ROUTE_SYSTEM = [
  'You coordinate a team chat room. People talk to each other here, and several AI agents are present.',
  'Someone just posted a message WITHOUT addressing anyone. Decide whether an agent should pick it up.',
  '- Conversation between people, a reaction, thanks, small talk, or anything needing no work or answer from an agent → nobody.',
  '- A request or question that clearly belongs to one agent\'s job → that agent.',
  '- Name two agents only when the task genuinely needs both — each answers separately and their answers are merged into one reply.',
  '- When in doubt, prefer nobody: waking the wrong agent is worse than a person typing an @.',
  'Use only the agent ids listed. Reply with ONLY this JSON and nothing else:',
  '{"agents":["<id>"],"confidence":<0..1>,"reason":"<why, at most 10 words>"}',
].join('\n');
function parseRoute(out: string | null | undefined, ids: string[]): { agents: string[]; confidence: number; reason: string } | null {
  if (!out) return null;
  const m = /\{[\s\S]*\}/.exec(out);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { agents?: unknown; confidence?: unknown; reason?: unknown };
    const agents = [...new Set((Array.isArray(j.agents) ? j.agents : []).map(String).filter((a) => ids.includes(a)))];
    const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0));
    return { agents, confidence, reason: clip(String(j.reason ?? '').replace(/\s+/g, ' ').trim(), 90) };
  } catch { return null; }
}

const pingers = new WeakMap<AgentOS, (member: Member, text: string) => void>();
export function setChatPinger(os: AgentOS, fn: (member: Member, text: string) => void): void { pingers.set(os, fn); }
/** People typing in a room right now: roomId → memberId → when that stops being true. Transient by
 *  nature (a keystroke a few seconds ago), so memory, fed by the chat socket. */
const humanTyping = new Map<string, Map<string, number>>();
const TYPING_MS = 5000;
export function noteTyping(roomId: string, memberId: string): void {
  let m = humanTyping.get(roomId);
  if (!m) humanTyping.set(roomId, (m = new Map()));
  m.set(memberId, Date.now() + TYPING_MS);
}
function clearTyping(roomId: string, memberId: string): void { humanTyping.get(roomId)?.delete(memberId); }
function typingIn(roomId: string, except: string): string[] {
  const m = humanTyping.get(roomId);
  if (!m) return [];
  const now = Date.now(), out: string[] = [];
  for (const [id, until] of m) { if (until <= now) m.delete(id); else if (id !== except) out.push(id); }
  if (!m.size) humanTyping.delete(roomId);
  return out;
}

/** `${roomId}:${memberId}` → when that person last had the conversation open. */
const watching = new Map<string, number>();
const WATCH_MS = 45_000;
const lastSweep = new WeakMap<AgentOS, number>();
const SWEEP_MS = 8_000;
const handoffCache = new Map<string, { at: number; v: DmHandoff[] }>();
const proactiveSent = new Map<string, number>();
const MAX_PROACTIVE_PER_SESSION = 30;
/** An agent may pass work to another agent this many times before a person has to step in. */
export const MAX_AGENT_HOPS = 2;
const MAX_FILES = 6;

/** A hand-off the conversation's agent made to another agent — shown inline as a status card. */
export interface DmHandoff { sessionId: string; agent: string; title: string; status: string; working: boolean; blocked: boolean; summary?: string; createdAt: number; kind: string }
export interface DmJob { id: string; kind: 'bg' | 'remind' | 'fanout'; agent: string; request: string; status: string; createdAt: number; dueAt: number | null; thread: number | null }
export interface InboundFile { name: string; data: Buffer }
/** What both thread shapes carry beyond the messages themselves. */
export interface ThreadExtras {
  /** Every session the room has used — approvals, questions and deliverables of these belong in the stream. */
  cardSessionIds: string[];
  jobs: DmJob[];
  handoffs: DmHandoff[];
}

const COMMANDS: { name: string; usage: string; help: string }[] = [
  { name: 'new', usage: '/new [message]', help: 'Start a new session — the agent begins with a clean slate' },
  { name: 'bg', usage: '/bg <request>', help: 'Run something in the background; the result is posted here when it finishes' },
  { name: 'stop', usage: '/stop', help: 'Stop what the agent is doing right now' },
  { name: 'task', usage: '/task <title>', help: 'File a task on the board for this agent' },
  { name: 'remind', usage: '/remind <30m|2h|1d> <what>', help: 'Bring this up again later' },
  { name: 'status', usage: '/status', help: 'What is running in this conversation' },
  { name: 'summary', usage: '/summary', help: 'The room so far, in a few lines' },
  { name: 'help', usage: '/help', help: 'List these commands' },
];
export const CHAT_COMMANDS = COMMANDS;
const DURATION = /^(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/i;
function parseDuration(s: string): number | null {
  const m = DURATION.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]), u = m[2][0].toLowerCase();
  const ms = n * (u === 'm' ? 60_000 : u === 'h' ? 3_600_000 : 86_400_000);
  return ms >= 60_000 && ms <= 30 * 86_400_000 ? ms : null;
}

/** The live "what is it doing right now" of each room — transient by nature, so memory not a table. */
const liveTyping = new Map<string, DmTyping>();

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export class DirectMessages {
  constructor(private readonly os: AgentOS, private readonly tm: TerminalManager) {}

  private get rooms() { return this.os.chatRooms; }

  /** Agents this member could add as a contact: ones they may run, on a runtime that can hold a conversation. */
  reachableAgents(me: Member): { id: string; description: string; icon?: string; category?: string }[] {
    return [...this.os.agents.values()]
      .filter((a) => runtimeSupports(a.runtime, 'residentChat') && this.os.team.canRun(me, a.id))
      .map((a) => ({ id: a.id, description: a.description, icon: a.icon, category: a.category }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  canChat(me: Member, agent: string): string | null {
    const a = this.os.agents.get(agent);
    if (!a) return `unknown agent "${agent}"`;
    if (!this.os.team.canRun(me, agent)) return `you are not assigned to run "${agent}"`;
    if (!runtimeSupports(a.runtime, 'residentChat')) return `"${agent}" can't hold a conversation on its runtime`;
    return null;
  }

  /** Contacts (with presence, preview, unread) + the directory of agents not yet added. */
  list(me: Member): { contacts: DmContact[]; directory: { id: string; description: string; icon?: string; category?: string }[] } {
    const reachable = this.reachableAgents(me);
    const byId = new Map(reachable.map((a) => [a.id, a]));
    const contacts: DmContact[] = [];
    for (const room0 of this.rooms.listDms(me.id)) {
      const a = byId.get(room0.agent);
      if (!a) continue; // agent deleted, or the member was unassigned — the room stays, just not listed
      const { room, presence } = this.sync(room0);
      const last = this.rooms.last(room.id);
      contacts.push({
        agent: room.agent, roomId: room.id, description: a.description, icon: a.icon, presence,
        lastText: last ? clip(last.body.replace(/\s+/g, ' '), 90) : undefined, lastFromMe: last ? last.authorKind === 'member' : undefined,
        lastAt: room.lastMessageAt ?? room.createdAt, unread: this.rooms.unread(room.id, me.id), sessionId: room.sessionId, notify: this.rooms.level(room.id, me.id),
      });
    }
    const added = new Set(contacts.map((c) => c.agent));
    return { contacts, directory: reachable.filter((a) => !added.has(a.id)) };
  }

  thread(me: Member, agent: string, opts: { after?: number; before?: number; read?: boolean; thread?: number } = {}): DmThread {
    const { room, presence, typing } = this.sync(this.rooms.ensureDm(me.id, agent));
    this.sweepJobs(room.id);
    if (opts.read) { this.rooms.markRead(room.id, me.id); watching.set(`${room.id}:${me.id}`, Date.now()); }
    const last = this.rooms.last(room.id);
    return {
      agent, roomId: room.id, sessionId: room.sessionId, presence, typing,
      ...this.extras(room.id, room.sessionId ? [room.sessionId] : [], me),
      threadView: opts.thread ? this.threadView(room.id, opts.thread) : undefined,
      messages: this.rooms.messages(room.id, { after: opts.after, before: opts.before }),
      // Silence is the one thing a chat can't show: a session that died on launch leaves a sent message
      // with nobody to answer it. Say so, so the page can offer a retry instead of an endless wait.
      stalled: !!last && last.authorKind === 'member' && presence === 'away' && Date.now() - last.createdAt > STALL_MS,
    };
  }

  /**
   * Fold whatever the room's session has produced since the last sync into `chat_messages`.
   *
   * Cheap by default: the transcript is only parsed when its size/mtime or the session's working/alive
   * state moved since last time (`synced_mark`). A room whose session is gone and was already synced
   * costs one row read.
   */
  sync(room: ChatRoom): { room: ChatRoom; presence: DmPresence; typing: DmTyping | null } {
    const r = this.syncLane({
      key: room.id, roomId: room.id, agent: room.agent, sessionId: room.sessionId, syncedTurns: room.syncedTurns, syncedMark: room.syncedMark,
      save: (turns, mark) => this.rooms.setSync(room.id, turns, mark),
      post: (m, thread) => { this.postAgent(room, room.agent, m.body, m.steps, m.at, { thread, took: m.took }); },
    });
    return { room: this.rooms.dm(room.memberId, room.agent) ?? room, ...r };
  }

  /** The fold itself, for ONE agent's session in ONE room — a DM's only lane, or one of a room's several. */
  private syncLane(lane: Lane): { presence: DmPresence; typing: DmTyping | null } {
    if (!lane.sessionId) return { presence: 'away', typing: null };
    const pulse = this.tm.sessionPulse(lane.sessionId);
    if (!pulse) return { presence: 'away', typing: null };
    const presence: DmPresence = pulse.working ? 'working' : pulse.alive ? 'online' : 'away';
    const base = `${pulse.size}:${pulse.mtime}:${pulse.working ? 1 : 0}:${pulse.alive ? 1 : 0}`;
    if (base === lane.syncedMark) {
      return { presence, typing: pulse.working ? liveTyping.get(lane.key) ?? { label: 'Working', steps: [], since: pulse.busySince ?? undefined } : null };
    }

    const turns = this.tm.sessionConversation(lane.sessionId).turns;
    let i = Math.min(lane.syncedTurns, turns.length);
    let typing: DmTyping | null = null;
    let unsettled = false;
    const quiet = pulse.mtime ? Date.now() - pulse.mtime : Infinity;
    let thread = threadBefore(turns, i);
    // When the message being answered was said — the previous user turn, if the cursor sits just past one.
    let asked: number | undefined = i > 0 && turns[i - 1].kind === 'user' ? turns[i - 1].ts || undefined : undefined;
    while (i < turns.length) {
      const u = turns[i];
      if (u.kind === 'user') { const x = threadOfTurn(u.text); if (x !== undefined) thread = x; if (u.ts) asked = u.ts; i++; continue; }
      let j = i;
      while (j < turns.length && turns[j].kind !== 'user') j++;
      // A run of agent turns is a finished reply once something came after it, or the turn has ended AND
      // the transcript has gone quiet (see SETTLE_MS). Until then it is the typing indicator.
      const seg = turns.slice(i, j);
      const said = seg.some((t) => t.kind === 'assistant' && t.text.trim());
      const finished = j < turns.length || (!pulse.working && quiet > (said ? SETTLE_MS : TEXTLESS_DROP_MS));
      // `since` = when the turn started (the working stamp), which is what a "working for 42s" counter
      // should count from — the segment's first line would hide the time spent before the first output.
      if (!finished) { typing = { ...typingOf(seg), thread, since: pulse.busySince ?? asked ?? seg[0]?.ts }; unsettled = !pulse.working; break; }
      const msg = foldReply(seg);
      // How long the turn took: from the message it answers to its last word.
      if (msg) lane.post({ ...msg, took: asked && msg.at > asked ? msg.at - asked : undefined }, thread);
      i = j;
    }
    if (pulse.working && !typing) typing = { label: 'Thinking', steps: [], since: pulse.busySince ?? undefined };
    if (typing) liveTyping.set(lane.key, typing); else liveTyping.delete(lane.key);
    // An unsettled tail resolves with TIME, not with a change to the file — so leave a mark that can't
    // match, and the next poll looks again.
    lane.save(i, unsettled ? `${base}:unsettled` : base);
    return { presence, typing };
  }

  /**
   * Get `body` to `agent`'s session: type it into the warm one, resume a reaped one, or — when there is
   * nothing usable — start a new session with `firstPrompt()`. Shared by DMs and rooms.
   */
  private deliver(me: Member, agent: string, roomId: string, sessionId: string | null, body: string, title: string, firstPrompt: () => string):
    { ok: true; sessionId: string; fresh: boolean } | { ok: false; status: number; error: string; held?: boolean } {
    const pulse = sessionId ? this.tm.sessionPulse(sessionId) : undefined;
    if (sessionId && pulse) {
      const held = this.tm.holdHumanPrompt(sessionId, body, 'reply', me.email);
      if (held) return { ok: false, status: 422, error: held, held: true };
    }
    // Resumable means there is a transcript to resume: a session that died before writing one (a failed
    // launch) would only fail the same way again, so that one is replaced rather than relaunched.
    const usable = !!sessionId && !!pulse && !pulse.archived && pulse.resumable
      && (pulse.alive || pulse.size > 0)
      && !(pulse.size > ROLLOVER_BYTES && !pulse.working);
    if (usable) {
      this.tm.noteTyper(sessionId!, me.id, 'composer');
      const r = this.tm.chatSend(sessionId!, body, me.id);
      if (r === 'paused') return { ok: false, status: 409, error: `${agent} is paused — resume it from Sessions to keep talking` };
      if (r === 'sent') return { ok: true, sessionId: sessionId!, fresh: false };
    }
    const s = this.tm.createSession(agent, title, firstPrompt(), `chat:${me.id}`, false, undefined, undefined, me.id, undefined, true);
    this.tm.markDmSession(s.id, roomId);
    return { ok: true, sessionId: s.id, fresh: true };
  }

  /** Send the member's message: deliver, resume, or transparently start a fresh session. */
  send(me: Member, agent: string, text: string, opts: { retry?: boolean; files?: InboundFile[]; thread?: number } = {}): DmSendResult {
    // A retry re-delivers the member's last message rather than posting it a second time.
    const again = opts.retry ? this.lastFromMember(me, agent) : undefined;
    let body = (again?.body ?? text).trim();
    const files = (opts.files ?? []).slice(0, MAX_FILES);
    if (!body && files.length) body = '(see attached)';
    if (!body) return { ok: false, status: 400, error: 'message is required' };
    const denied = this.canChat(me, agent);
    if (denied) return { ok: false, status: 403, error: denied };
    if (!again && body.startsWith('/')) {
      const room0 = this.rooms.ensureDm(me.id, agent);
      // `/new` — the person asks for a clean slate. Never delivered to the agent as text.
      const cmd = NEW_COMMAND.exec(body);
      if (cmd) {
        const marker = this.reset(me, agent);
        body = (cmd[1] ?? '').trim();
        if (!body) return { ok: true, message: marker, sessionId: null };
      } else {
        const at = this.threadRoot(room0.id, opts.thread);
        if (at === false) return { ok: false, status: 404, error: 'that thread no longer exists' };
        const r = this.command(me, room0, [agent], body, at?.seq);
        if (r) return r.ok ? { ok: true, message: r.message, sessionId: room0.sessionId, notes: r.notes } : r;
      }
    }
    // Sync first so the agent's previous reply lands in the room BEFORE this message, not after it.
    const { room } = this.sync(this.rooms.ensureDm(me.id, agent));
    const root = this.threadRoot(room.id, again?.threadId ?? opts.thread);
    if (root === false) return { ok: false, status: 404, error: 'that thread no longer exists' };
    const staged = files.length ? this.tm.stageFilesForAgent(agent, files, me.email) : [];
    const d = this.dmDeliver(me, room, `${body}${staged.length ? ` (attached: ${staged.join(', ')})` : ''}${this.threadHint(root)}`, root?.seq);
    if (!d.ok) return d;
    const message = again ?? this.rooms.post(room.id, 'member', me.id, body, undefined, Date.now(), { files: files.map((f) => f.name), thread: root?.seq });
    this.rooms.markRead(room.id, me.id);
    chatBus.emit('changed', this.os);
    return { ok: true, message, sessionId: d.sessionId };
  }

  /** Deliver `turn` to the DM's agent as `me`. `said` is the bare message, for a fresh session's opening prompt. */
  private dmDeliver(me: Member, room: ChatRoom, turn: string, thread?: number | null): { ok: true; sessionId: string } | { ok: false; status: number; error: string; held?: boolean } {
    const d = this.deliver(me, room.agent, room.id, room.sessionId, `${turn} ${tagFor(thread)}`, `Direct message · ${me.name || me.email}`, () => this.firstPrompt(me, room, turn, thread));
    if (!d.ok) return d;
    if (d.fresh) this.rooms.setSession(room.id, d.sessionId);
    return { ok: true, sessionId: d.sessionId };
  }

  private lastFromMember(me: Member, agent: string): ChatMessage | undefined {
    const room = this.rooms.dm(me.id, agent);
    const last = room ? this.rooms.last(room.id) : undefined;
    return last && last.authorKind === 'member' ? last : undefined;
  }

  /** Start a NEW session behind the room: the visible history stays, but the next message opens a
   *  session that knows nothing of it. Behind `/new` and the menu's "New session". */
  reset(me: Member, agent: string): ChatMessage {
    const room = this.rooms.ensureDm(me.id, agent);
    this.sync(room);
    this.rooms.setSession(room.id, null);
    liveTyping.delete(room.id);
    // The marker is also the recap boundary: a new session is told nothing from before it.
    const last = this.rooms.last(room.id);
    if (last && last.authorKind === 'system' && last.body === NEW_SESSION_MARKER) return last;
    return this.rooms.post(room.id, 'system', me.id, NEW_SESSION_MARKER);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Rooms & group DMs. Several members and agents in one conversation. Each AGENT has its own
  // session per room (its "lane"); a message reaches an agent only when it is ADDRESSED to it —
  // `@agent-id` — except in a room of one person and one agent, where there is nobody else to mean.
  // Everything else is people talking to each other, and no agent runs for it. An agent's reply
  // never triggers another agent: two agents mentioning each other is an unattended loop.
  // The sender must be allowed to run the agent they address (run-as = the sender, as in a DM).
  // ════════════════════════════════════════════════════════════════════════════════════════════

  private person(id: string): RoomPerson {
    const m = this.os.team.getMember(id);
    return { id, name: m?.name || m?.email || 'Former member', avatar: m?.avatar };
  }

  /** Everyone a room could include — names and avatars only. */
  people(): RoomPerson[] {
    return this.os.team.listMembers().filter((m) => m.status === 'active').map((m) => ({ id: m.id, name: m.name || m.email, avatar: m.avatar }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private lane(room: ChatRoom, p: ChatParticipant): Lane {
    return {
      key: `${room.id}:${p.id}`, roomId: room.id, agent: p.id, sessionId: p.sessionId, syncedTurns: p.syncedTurns, syncedMark: p.syncedMark,
      save: (turns, mark) => this.rooms.setLaneSync(room.id, p.id, turns, mark),
      post: (m, thread) => { const msg = this.postAgent(room, p.id, m.body, m.steps, m.at, { thread, took: m.took }); this.relay(room, p.id, msg); this.fanoutReply(room, p.id, msg); },
    };
  }

  /** Sync every agent lane of the room, and describe it for `me`. */
  private describe(room: ChatRoom, me: Member): { summary: RoomSummary; typing: RoomThread['typing']; sessionIds: string[] } {
    const parts = this.rooms.participants(room.id);
    const agents: RoomAgent[] = [];
    const typing: RoomThread['typing'] = [];
    const sessionIds: string[] = [];
    for (const p of parts) {
      if (p.kind !== 'agent') continue;
      const r = this.syncLane(this.lane(room, p));
      const a = this.os.agents.get(p.id);
      agents.push({ id: p.id, description: a?.description ?? '', icon: a?.icon, presence: r.presence });
      if (r.typing) typing.push({ agent: p.id, label: r.typing.label, steps: r.typing.steps, thread: r.typing.thread ?? null, since: r.typing.since });
      if (p.sessionId) sessionIds.push(p.sessionId);
    }
    const fresh = this.rooms.get(room.id) ?? room;
    const last = this.rooms.last(room.id);
    return {
      summary: {
        id: room.id, name: room.name, createdBy: room.memberId, agents, orchestrate: room.orchestrate, summary: fresh.summary ?? undefined,
        members: parts.filter((p) => p.kind === 'member').map((p) => this.person(p.id)),
        lastText: last ? clip(last.body.replace(/\s+/g, ' '), 90) : undefined,
        lastAuthor: !last || last.authorKind === 'system' ? undefined : last.authorKind === 'agent' ? pretty(last.authorId) : last.authorId === me.id ? 'You' : this.person(last.authorId).name.split(' ')[0],
        lastAt: fresh.lastMessageAt ?? fresh.createdAt, unread: this.rooms.unread(room.id, me.id),
        mentions: this.rooms.unreadMentions(room.id, me.id), notify: this.rooms.level(room.id, me.id),
      },
      typing, sessionIds,
    };
  }

  roomList(me: Member): RoomSummary[] { return this.rooms.roomsFor(me.id).map((r) => this.describe(r, me).summary); }

  private roomFor(me: Member, roomId: string): ChatRoom | Fail {
    const room = this.rooms.get(roomId);
    if (!room || room.kind !== 'room') return { ok: false, status: 404, error: 'room not found' };
    if (!this.rooms.isMember(roomId, me.id)) return { ok: false, status: 403, error: 'you are not in this room' };
    return room;
  }

  createRoom(me: Member, input: { name?: string; members?: string[]; agents?: string[] }): { ok: true; id: string } | Fail {
    const name = (input.name ?? '').trim().replace(/^#/, '').slice(0, 60) || null;
    const members = [...new Set([me.id, ...(input.members ?? []).map(String)])];
    const agents = [...new Set((input.agents ?? []).map(String))];
    if (members.length + agents.length < 2) return { ok: false, status: 400, error: 'add at least one other person or agent' };
    if (members.length > MAX_ROOM_PEOPLE || agents.length > MAX_ROOM_AGENTS) return { ok: false, status: 400, error: `a room holds up to ${MAX_ROOM_PEOPLE} people and ${MAX_ROOM_AGENTS} agents` };
    for (const m of members) if (this.os.team.getMember(m)?.status !== 'active') return { ok: false, status: 400, error: 'unknown team member' };
    for (const a of agents) { const denied = this.canChat(me, a); if (denied) return { ok: false, status: 403, error: denied }; }
    const room = this.rooms.createRoom(me.id, name);
    for (const m of members) this.rooms.addParticipant(room.id, 'member', m);
    for (const a of agents) this.rooms.addParticipant(room.id, 'agent', a);
    return { ok: true, id: room.id };
  }

  roomAdd(me: Member, roomId: string, input: { members?: string[]; agents?: string[] }): { ok: true } | Fail {
    const room = this.roomFor(me, roomId);
    if ('ok' in room) return room;
    const parts = this.rooms.participants(roomId);
    const members = (input.members ?? []).map(String), agents = (input.agents ?? []).map(String);
    if (parts.filter((p) => p.kind === 'member').length + members.length > MAX_ROOM_PEOPLE || parts.filter((p) => p.kind === 'agent').length + agents.length > MAX_ROOM_AGENTS) {
      return { ok: false, status: 400, error: `a room holds up to ${MAX_ROOM_PEOPLE} people and ${MAX_ROOM_AGENTS} agents` };
    }
    for (const m of members) if (this.os.team.getMember(m)?.status !== 'active') return { ok: false, status: 400, error: 'unknown team member' };
    for (const a of agents) { const denied = this.canChat(me, a); if (denied) return { ok: false, status: 403, error: denied }; }
    const who = me.name || me.email;
    for (const m of members) if (this.rooms.addParticipant(roomId, 'member', m)) this.rooms.post(roomId, 'system', me.id, `${who} added ${this.person(m).name}`);
    for (const a of agents) if (this.rooms.addParticipant(roomId, 'agent', a)) this.rooms.post(roomId, 'system', me.id, `${who} added ${pretty(a)}`);
    return { ok: true };
  }

  /** Leave (remove yourself), or — the room's creator and admins only — remove someone else. */
  roomRemove(me: Member, roomId: string, kind: 'member' | 'agent', id: string): { ok: true; deleted?: boolean } | Fail {
    const room = this.roomFor(me, roomId);
    if ('ok' in room) return room;
    const self = kind === 'member' && id === me.id;
    if (!self && room.memberId !== me.id && me.role === 'member') return { ok: false, status: 403, error: 'only the person who made the room, or an admin, can remove others' };
    if (!this.rooms.removeParticipant(roomId, kind, id)) return { ok: false, status: 404, error: 'not in this room' };
    liveTyping.delete(`${roomId}:${id}`);
    const who = me.name || me.email;
    this.rooms.post(roomId, 'system', me.id, self ? `${who} left` : `${who} removed ${kind === 'agent' ? pretty(id) : this.person(id).name}`);
    // Nobody left to read it — the room is gone.
    if (!this.rooms.participants(roomId).some((p) => p.kind === 'member')) { this.rooms.deleteRoom(roomId); return { ok: true, deleted: true }; }
    return { ok: true };
  }

  roomSetOrchestrate(me: Member, roomId: string, mode: OrchestrateMode): { ok: true } | Fail {
    const room = this.roomFor(me, roomId);
    if ('ok' in room) return room;
    if (room.orchestrate === mode) return { ok: true };
    this.rooms.setOrchestrate(roomId, mode);
    this.rooms.post(roomId, 'system', me.id, `${me.name || me.email} set agents to ${mode === 'auto' ? 'join in automatically' : mode === 'suggest' ? 'be suggested, not brought in automatically' : 'answer only when @mentioned'}`);
    chatBus.emit('changed', this.os);
    return { ok: true };
  }

  // ── The room orchestrator ───────────────────────────────────────────────────────────────────
  // A message nobody was addressed in still usually has an owner. Rather than make people remember
  // who does what, the room decides: STICKY first (you were just talking to an agent — it's still
  // for them; no model call), else ONE small model call over the room's agents and the recent
  // conversation. It routes only when confident, says why in the room, and otherwise offers one-tap
  // pills or stays out of it — people talking to each other must not wake anything. Everything it
  // starts runs as the sender, who must be allowed to run that agent, at hop 0.

  /** Decide what to do with an unaddressed message. Returns the agents handed it synchronously (sticky). */
  private orchestrate(me: Member, room: ChatRoom, parts: ChatParticipant[], message: ChatMessage): string[] {
    if (room.orchestrate === 'off' || message.body.trim().length < 3) return [];
    const eligible = parts.filter((p) => p.kind === 'agent' && !this.canChat(me, p.id)).map((p) => p.id);
    if (!eligible.length) return [];
    const thread = message.threadId ?? null;
    const stream = (thread ? this.rooms.replies(room.id, thread) : this.rooms.messages(room.id, { limit: 30 })).filter((m) => m.authorKind !== 'system' && m.seq < message.seq);
    // Sticky: the last thing said here was an agent's, moments ago — this is the next line of that exchange.
    const prev = stream[stream.length - 1];
    if (prev && prev.authorKind === 'agent' && eligible.includes(prev.authorId) && message.createdAt - prev.createdAt < STICKY_MS) {
      const d = this.roomDeliver(me, room, parts, prev.authorId, `${message.body}${this.threadHint(this.threadRoot(room.id, thread))}`, me.name || me.email, 0, message.seq, thread);
      return d.ok ? [prev.authorId] : [];
    }
    void this.route(me, room, message, eligible, stream.slice(-12)).catch(() => { /* routing is best-effort; the message is already posted */ });
    return [];
  }

  /** The model half: ask who should take it, then hand it over (auto) or offer pills (suggest / unsure). */
  private async route(me: Member, room: ChatRoom, message: ChatMessage, eligible: string[], recent: ChatMessage[]): Promise<void> {
    if (routing.has(room.id)) return; // one decision at a time per room; a later message rides along as context
    const brain = this.brain();
    if (!brain) return;
    routing.add(room.id);
    let pick: { agents: string[]; confidence: number; reason: string } | null = null;
    try {
      const who = me.name || me.email;
      const roster = eligible.map((id) => `- ${id}: ${clip((this.os.agents.get(id)?.description ?? '').replace(/\s+/g, ' '), 300)}`).join('\n');
      const convo = recent.map((m) => `${m.authorKind === 'agent' ? `${m.authorId} (agent)` : this.person(m.authorId).name}: ${clip(m.body.replace(/\s+/g, ' '), 300)}`).join('\n');
      pick = parseRoute(await brain(ROUTE_SYSTEM, `Agents in this room:\n${roster}\n\n${convo ? `Recent conversation (oldest first):\n${convo}\n\n` : ''}New message from ${who}:\n${clip(message.body, 2000)}`), eligible);
    } finally { routing.delete(room.id); }
    if (!pick || !pick.agents.length || pick.confidence < ROUTE_SUGGEST_AT) return;
    const now = this.rooms.get(room.id);
    if (!now || now.orchestrate === 'off' || !this.rooms.message(room.id, message.seq)) return;
    const parts = this.rooms.participants(room.id);
    const thread = message.threadId ?? null;
    const why = pick.reason ? ` — ${pick.reason}` : '';
    if (now.orchestrate === 'auto' && pick.confidence >= ROUTE_AUTO_AT) {
      const took: string[] = [];
      for (const a of pick.agents.slice(0, 2)) {
        const d = this.roomDeliver(me, now, parts, a, `${message.body}${this.threadHint(this.threadRoot(room.id, thread))}`, me.name || me.email, 0, message.seq, thread);
        if (d.ok) took.push(a);
      }
      if (took.length) this.rooms.post(room.id, 'system', me.id, `→ ${took.map(pretty).join(' and ')} picked this up${why}`, undefined, Date.now(), { thread });
      // Fan-out: more than one agent is on it — remember that, so their answers come back as ONE reply.
      if (took.length > 1) this.rooms.addJob({ roomId: room.id, kind: 'fanout', agent: took.join(','), memberId: me.id, request: message.body, status: 'running', thread, data: { seq: message.seq, replies: {} } });
    } else {
      // Not sure enough to act (or the room only wants suggestions): offer the hand-off as one-tap replies.
      this.rooms.post(room.id, 'system', me.id, `Bring someone in?${why}`, undefined, Date.now(), { thread, actions: pick.agents.slice(0, 3).map((a) => `@${a} can you take this?`) });
    }
    this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: me.id, type: 'chat.routed', data: { room: room.id, agents: pick.agents, confidence: pick.confidence, mode: now.orchestrate } });
    chatBus.emit('changed', this.os);
  }

  /** The orchestrator's model. `maxTokens` > the routing default when it has prose to write. */
  private brain(maxTokens?: number): Brain | null {
    return brains.get(this.os) ?? routerBrain(this.os, () => this.tm.outOfBandCredentialEnv(), maxTokens ? { maxTokens } : {});
  }

  // ── Fan-out and merge ──
  /** An agent answered: if that completes a fan-out, merge the answers into one. */
  private fanoutReply(room: ChatRoom, agent: string, msg: ChatMessage): void {
    for (const job of this.rooms.openJobs(room.id)) {
      if (job.kind !== 'fanout' || (job.threadId ?? null) !== (msg.threadId ?? null)) continue;
      const agents = job.agent.split(',');
      const data = job.data as { seq?: number; replies?: Record<string, number> };
      const replies = { ...(data.replies ?? {}) };
      if (!agents.includes(agent) || replies[agent] || msg.seq <= (data.seq ?? 0)) continue;
      replies[agent] = msg.seq;
      this.rooms.setJobData(job.id, { ...data, replies });
      if (agents.every((a) => replies[a])) void this.merge({ ...job, data: { ...data, replies } }).catch(() => {});
    }
  }

  /** Write the ONE reply a fan-out owes the person: what the agents said, where they agree, where they don't. */
  private async merge(job: ChatJob): Promise<void> {
    if (this.rooms.job(job.id)?.status !== 'running') return;
    this.rooms.finishJob(job.id, 'done'); // first — so a second trigger (the timeout, a late reply) can't merge twice
    const room = this.rooms.get(job.roomId);
    const replies = Object.entries((job.data as { replies?: Record<string, number> }).replies ?? {})
      .map(([agent, seq]) => ({ agent, msg: room ? this.rooms.message(room.id, seq) : undefined })).filter((r) => r.msg);
    const brain = this.brain(700);
    if (!room || replies.length < 2 || !brain) { chatBus.emit('changed', this.os); return; } // one answer needs no merging
    const asker = this.person(job.memberId).name;
    const out = await brain(MERGE_SYSTEM, `${asker} asked:\n${clip(job.request, 1500)}\n\n${replies.map((r) => `--- ${pretty(r.agent)} answered ---\n${clip(r.msg!.body, 3000)}`).join('\n\n')}`);
    const text = (out ?? '').trim();
    if (!text) return;
    const back = job.threadId && this.threadRoot(room.id, job.threadId) ? job.threadId : null;
    const msg = this.rooms.post(room.id, 'agent', ORCHESTRATOR, text, undefined, Date.now(), { tag: 'summary', thread: back });
    this.notify(room, msg);
    chatBus.emit('changed', this.os);
  }

  // ── Stuck detection ──
  /** Notice a lane that needs someone: working a long time in silence, or waiting on a person who hasn't seen it. */
  private watch(room: ChatRoom, agent: string, sessionId: string | null, acting: string | null): void {
    if (!sessionId || (room.kind === 'room' && room.orchestrate === 'off')) return;
    const pulse = this.tm.sessionPulse(sessionId);
    if (!pulse) return;
    const now = Date.now();
    const once = (key: string): boolean => { if (nudged.has(key)) return false; if (nudged.size > 5000) nudged.clear(); nudged.add(key); return true; };
    if (pulse.working && pulse.busySince && now - pulse.busySince > STUCK_WORKING_MS && pulse.mtime && now - pulse.mtime > STUCK_QUIET_MS && once(`${sessionId}:${pulse.busySince}`)) {
      const msg = this.rooms.post(room.id, 'agent', ORCHESTRATOR, `${pretty(agent)} has been working for ${Math.round((now - pulse.busySince) / 60_000)} minutes and has gone quiet for the last ${Math.round((now - pulse.mtime) / 60_000)}. It may be on a long step — or stuck.`, undefined, now, { tag: 'nudge', actions: ['/stop'] });
      this.notify(room, msg);
      chatBus.emit('changed', this.os);
    }
    // In a room the person an agent is waiting on may not be looking: say so where they'll be tagged.
    if (room.kind !== 'room' || !acting) return;
    const rows = [
      ...this.os.db.prepare("SELECT id, prompt AS text, created_at FROM questions WHERE status = 'pending' AND run_id = ?").all<{ id: string; text: string; created_at: number }>(sessionId).map((r) => ({ ...r, what: 'an answer' })),
      ...this.os.db.prepare("SELECT id, reason AS text, created_at FROM approvals WHERE status = 'pending' AND run_id = ?").all<{ id: string; text: string; created_at: number }>(sessionId).map((r) => ({ ...r, what: 'your OK' })),
    ];
    for (const r of rows) {
      if (now - r.created_at < STUCK_WAITING_MS || !once(`ask:${r.id}`)) continue;
      const who = this.person(acting).name.split(/\s+/)[0];
      const msg = this.rooms.post(room.id, 'agent', ORCHESTRATOR, `@${who.toLowerCase()} — ${pretty(agent)} is waiting on ${r.what}: ${clip(r.text.replace(/\s+/g, ' '), 200)}`, undefined, now, { tag: 'nudge', mentions: [acting] });
      this.notify(room, msg);
      chatBus.emit('changed', this.os);
    }
  }

  // ── Rolling summary ──
  /** Keep a room's summary current: every SUMMARY_EVERY new messages, fold all but the latest few into it. */
  private async summarise(room: ChatRoom, force = false): Promise<void> {
    if (room.kind !== 'room' || summarising.has(room.id)) return;
    const pendingCount = this.rooms.countAfter(room.id, room.summarySeq);
    if (pendingCount < (force ? SUMMARY_KEEP + 4 : SUMMARY_EVERY)) return;
    const brain = this.brain(500);
    if (!brain) return;
    summarising.add(room.id);
    try {
      const fresh = this.rooms.messages(room.id, { after: room.summarySeq, limit: 120 }).filter((m) => m.authorKind !== 'system');
      const fold = fresh.slice(0, Math.max(0, fresh.length - SUMMARY_KEEP)); // the latest stay verbatim
      if (fold.length < 4) return;
      const lines = fold.map((m) => `${m.authorKind === 'agent' ? `${pretty(m.authorId)} (agent)` : this.person(m.authorId).name}: ${clip(m.body.replace(/\s+/g, ' '), 400)}`).join('\n');
      const out = await brain(SUMMARY_SYSTEM, `Summary so far:\n${room.summary || '(nothing yet)'}\n\nNew messages (oldest first):\n${lines}`);
      const text = clip((out ?? '').trim(), 2000);
      if (text) { this.rooms.setSummary(room.id, text, fold[fold.length - 1].seq); chatBus.emit('changed', this.os); }
    } finally { summarising.delete(room.id); }
  }

  roomRename(me: Member, roomId: string, name: string): { ok: true } | Fail {
    const room = this.roomFor(me, roomId);
    if ('ok' in room) return room;
    const clean = name.trim().replace(/^#/, '').slice(0, 60) || null;
    this.rooms.rename(roomId, clean);
    this.rooms.post(roomId, 'system', me.id, clean ? `${me.name || me.email} named this room “${clean}”` : `${me.name || me.email} removed the room name`);
    return { ok: true };
  }

  roomThread(me: Member, roomId: string, opts: { before?: number; read?: boolean; thread?: number } = {}): RoomThread | Fail {
    const room = this.roomFor(me, roomId);
    if ('ok' in room) return room;
    const d = this.describe(room, me);
    this.sweepJobs(roomId);
    if (opts.read) { this.rooms.markRead(roomId, me.id); watching.set(`${roomId}:${me.id}`, Date.now()); }
    const messages: RoomMessage[] = this.rooms.messages(roomId, { before: opts.before }).map((m) => this.named(m));
    return {
      room: d.summary, messages, typing: d.typing, sessionIds: d.sessionIds, ...this.extras(roomId, d.sessionIds, me),
      threadView: opts.thread ? this.threadView(roomId, opts.thread) : undefined,
      peopleTyping: typingIn(roomId, me.id).map((id) => this.person(id).name.split(' ')[0]),
    };
  }

  /** The room's agents a message explicitly @mentions. */
  private mentioned(body: string, parts: ChatParticipant[]): string[] {
    const agents = parts.filter((p) => p.kind === 'agent').map((p) => p.id);
    const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    const named = new Set<string>();
    for (const m of body.matchAll(/@([\w.-]+)/g)) {
      const want = squash(m[1]);
      const hit = agents.find((a) => squash(a) === want);
      if (hit) named.add(hit);
    }
    return [...named];
  }

  /** Which of the room's agents a PERSON's message is addressed to. */
  private addressed(body: string, parts: ChatParticipant[]): string[] {
    const named = this.mentioned(body, parts);
    if (named.length) return named;
    // One person, one agent: there is nobody else the message could be for.
    const agents = parts.filter((p) => p.kind === 'agent').map((p) => p.id);
    return agents.length === 1 && parts.filter((p) => p.kind === 'member').length === 1 ? agents : [];
  }

  roomSend(me: Member, roomId: string, text: string, opts: { files?: InboundFile[]; thread?: number } = {}): RoomSendResult {
    const room = this.roomFor(me, roomId);
    if ('ok' in room) return room;
    let body = text.trim();
    const files = (opts.files ?? []).slice(0, MAX_FILES);
    if (!body && files.length) body = '(see attached)';
    if (!body) return { ok: false, status: 400, error: 'message is required' };
    clearTyping(roomId, me.id);
    let parts = this.rooms.participants(roomId);
    // Fold every agent's pending reply into the room BEFORE this message, so the order reads true.
    for (const p of parts) if (p.kind === 'agent') this.syncLane(this.lane(room, p));

    if (body.startsWith('/')) {
      const cmd = NEW_COMMAND.exec(body);
      if (cmd) {
        const marker = this.rooms.post(roomId, 'system', me.id, NEW_SESSION_MARKER);
        for (const p of parts) if (p.kind === 'agent') { this.rooms.setLaneSession(roomId, p.id, null); this.rooms.setLaneSeen(roomId, p.id, marker.seq); liveTyping.delete(`${roomId}:${p.id}`); }
        body = (cmd[1] ?? '').trim();
        chatBus.emit('changed', this.os);
        if (!body) return { ok: true, message: marker, delivered: [], notes: [] };
        parts = this.rooms.participants(roomId);
      } else {
        const at = this.threadRoot(roomId, opts.thread);
        if (at === false) return { ok: false, status: 404, error: 'that thread no longer exists' };
        const r = this.command(me, room, parts.filter((p) => p.kind === 'agent').map((p) => p.id), body, at?.seq);
        if (r) return r.ok ? { ok: true, message: r.message, delivered: [], notes: r.notes } : r;
      }
    }

    const root = this.threadRoot(roomId, opts.thread);
    if (root === false) return { ok: false, status: 404, error: 'that thread no longer exists' };
    const delivered: string[] = [], notes: string[] = [];
    let to = this.addressed(body, parts);
    // In a thread with no @mention, the reply is for the one agent already talking there.
    if (!to.length && root) {
      const there = new Set([root, ...this.rooms.replies(roomId, root.seq)].filter((m) => m.authorKind === 'agent').map((m) => m.authorId));
      for (const a of this.mentioned(root.body, parts)) there.add(a);
      const present = [...there].filter((a) => parts.some((p) => p.kind === 'agent' && p.id === a));
      if (present.length === 1) to = present;
    }
    for (const agent of to) {
      const staged = files.length ? this.tm.stageFilesForAgent(agent, files, me.email) : [];
      const d = this.roomDeliver(me, room, parts, agent, `${body}${staged.length ? ` (attached: ${staged.join(', ')})` : ''}${this.threadHint(root)}`, me.name || me.email, 0, undefined, root?.seq);
      if (!d.ok) { if (d.held) return d; notes.push(`${pretty(agent)} didn't get this — ${d.error}.`); continue; }
      delivered.push(agent);
    }
    const message = this.rooms.post(roomId, 'member', me.id, body, undefined, Date.now(), { files: files.map((f) => f.name), thread: root?.seq, mentions: this.peopleMentioned(body, parts, me.id) });
    for (const agent of delivered) this.rooms.setLaneSeen(roomId, agent, message.seq);
    // Nobody was addressed: the room's orchestrator decides whether an agent should pick this up.
    // (Not when it was addressed to a PERSON — `@priya` is for Priya.)
    if (!to.length && !message.mentions?.length) for (const a of this.orchestrate(me, room, parts, message)) delivered.push(a);
    this.notify(room, message);
    this.rooms.markRead(roomId, me.id);
    chatBus.emit('changed', this.os);
    return { ok: true, message, delivered, notes };
  }

  /**
   * Hand `body` to one agent's lane in a room, on behalf of `me`, said by `from` (a person's name or
   * "<Agent> (agent)"). The agent is first shown what it missed since its last turn. `hop` is how many
   * agent→agent hand-offs separate this turn from a person.
   */
  private roomDeliver(me: Member, room: ChatRoom, parts: ChatParticipant[], agent: string, body: string, from: string, hop: number, upto?: number, thread?: number | null):
    { ok: true } | { ok: false; status: number; error: string; held?: boolean } {
    const denied = this.canChat(me, agent);
    if (denied) return { ok: false, status: 403, error: denied };
    const p = parts.find((x) => x.kind === 'agent' && x.id === agent);
    if (!p) return { ok: false, status: 404, error: 'not in this room' };
    const who = me.name || me.email;
    const label = room.name ? `#${room.name}` : 'group chat';
    // What the agent missed: everything said in the room since it was last shown, minus its own words.
    // An agent that has been away longer than the room's summary reaches gets the summary for the old
    // part and the messages themselves only for what came after it — context at a fraction of the size.
    const summarised = room.summary && p.seenSeq < room.summarySeq ? room.summarySeq : 0;
    const missed = this.rooms.messages(room.id, { limit: 60 })
      .filter((m) => m.seq > Math.max(p.seenSeq, summarised) && (upto == null || m.seq < upto) && m.authorKind !== 'system' && !(m.authorKind === 'agent' && m.authorId === agent))
      .slice(-ROOM_CONTEXT_MESSAGES)
      .map((m) => `${m.authorKind === 'agent' ? pretty(m.authorId) : m.authorId === me.id ? who : this.person(m.authorId).name}: ${clip(m.body.replace(/\s+/g, ' '), RECAP_CHARS)}`);
    if (summarised) missed.unshift(`(Summary of the conversation before that: ${clip(room.summary!.replace(/\s+/g, ' '), 1500)})`);
    const turn = `[${label}] ${missed.length ? `Said since your last turn — ${missed.join(' | ')} — ` : ''}${from} to you: ${body}`;
    const d = this.deliver(me, agent, room.id, p.sessionId, `${turn} ${tagFor(thread)}`, `${room.name ? `#${room.name}` : 'Group chat'} · ${pretty(agent)}`, () => `${this.roomPrompt(room, parts, agent, missed, from, body)}\n${tagFor(thread)}`);
    if (!d.ok) return d;
    if (d.fresh) this.rooms.setLaneSession(room.id, agent, d.sessionId);
    this.rooms.setLaneTurn(room.id, agent, hop, me.id);
    if (upto != null) this.rooms.setLaneSeen(room.id, agent, upto);
    return { ok: true };
  }

  /**
   * An agent's reply mentioned another agent in the room: pass it along — as the same person the first
   * agent was acting for, and only {@link MAX_AGENT_HOPS} times before a person has to step in. Without
   * the limit two agents that mention each other are an unattended loop.
   */
  private relay(room: ChatRoom, from: string, msg: ChatMessage): void {
    const parts = this.rooms.participants(room.id);
    const targets = this.mentioned(msg.body, parts).filter((a) => a !== from);
    if (!targets.length) return;
    const self = parts.find((p) => p.kind === 'agent' && p.id === from);
    const acting = self?.acting ? this.os.team.getMember(self.acting) : undefined;
    if (!acting) return;
    const hop = (self?.hop ?? 0) + 1;
    if (hop > MAX_AGENT_HOPS) {
      this.rooms.post(room.id, 'system', acting.id, `${pretty(from)} mentioned ${targets.map(pretty).join(', ')} — not passed on: agents hand work along at most ${MAX_AGENT_HOPS} times before a person steps in`);
      return;
    }
    for (const t of targets) {
      const d = this.roomDeliver(acting, room, parts, t, msg.body, `${pretty(from)} (agent)`, hop, msg.seq, msg.threadId);
      if (!d.ok) this.rooms.post(room.id, 'system', acting.id, `${pretty(t)} didn't get ${pretty(from)}'s message — ${d.error}`);
    }
  }

  /** The opening prompt of an agent's session in a room: where it is, who is there, how to behave. */
  private roomPrompt(room: ChatRoom, parts: ChatParticipant[], agent: string, missed: string[], who: string, body: string): string {
    const people = parts.filter((p) => p.kind === 'member').map((p) => this.person(p.id).name);
    const otherIds = parts.filter((p) => p.kind === 'agent' && p.id !== agent).map((p) => p.id);
    const firsts = [...new Set(people.map((n) => n.split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean))];
    const lines = [
      `You are ${pretty(agent)}, taking part in ${room.name ? `the room "#${room.name}"` : 'a group chat'} in the Agentric console — a shared chat, like a channel with colleagues.`,
      `People here: ${people.join(', ')}.${otherIds.length ? ` Other agents here: ${otherIds.map(pretty).join(', ')}.` : ''}`,
      // How to reach the others. Without this an agent has no way to know a mention DOES anything.
      `You can pull others in by @mentioning them in your message: ${otherIds.length ? `another agent by its id (${otherIds.map((a) => `@${a}`).join(', ')}) — it is handed your message and answers here; ` : ''}a person by first name (${firsts.map((f) => `@${f}`).join(', ')}) or @everyone — they are notified at once, including outside the app if they are away. Mention someone only when you actually need them; agents can pass work along at most ${MAX_AGENT_HOPS} times before a person has to step in.`,
      'You are only brought in when someone addresses you. Each time, you are shown what was said since your last turn, then the message for you.',
      'Everyone in the room sees ONLY the final message you write each turn; your tool calls and interim notes are tucked away behind it.',
      ACTIONS_HINT,
      'So answer the way a teammate would in a group chat: reply to the person who asked, lead with the answer, keep it short, and do the work rather than describing it. You act on behalf of whoever addressed you.',
    ];
    if (missed.length) { lines.push('', 'Said in the room so far (most recent last):'); lines.push(...missed); }
    lines.push('', `${who} to you: ${body}`);
    return lines.join('\n');
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Comms primitives shared by DMs and rooms: posting as an agent (with away-pings), the stream
  // extras (cards, jobs, hand-offs), slash commands, stop, background runs, reminders, agents
  // writing first, and the background sweep that keeps all of it moving when nobody is looking.
  // ════════════════════════════════════════════════════════════════════════════════════════════

  /** Put an agent's message in a room; in a DM, ping the person if they are not looking. */
  private postAgent(room: ChatRoom, agent: string, body: string, steps: ChatStep[] | undefined, at: number, extra: { tag?: string; thread?: number | null; took?: number } = {}): ChatMessage {
    // A reply whose thread has gone (or was never a main-stream message) lands in the main stream instead.
    const thread = extra.thread && this.threadRoot(room.id, extra.thread) ? extra.thread : null;
    const mentions = room.kind === 'room' ? this.peopleMentioned(body, this.rooms.participants(room.id)) : undefined;
    // Quick actions: a trailing `[[actions: A | B | C]]` line becomes one-tap replies, and leaves the text.
    const offered = splitActions(body);
    const msg = this.rooms.post(room.id, 'agent', agent, offered.body, steps, at, { tag: extra.tag, thread, mentions, took: extra.took, actions: offered.actions });
    chatBus.emit('changed', this.os);
    this.notify(room, msg);
    return msg;
  }

  /**
   * Reach the people a message is for, OUTSIDE the app (Slack/Discord DM via the identity map).
   *
   * Who: in a one-to-one conversation (a DM with an agent, or two people with no agent) every message
   * counts; in a room only an @mention does — a room is not a pager. Each person's own level for the
   * room (`all` / `mentions` / `mute`) narrows that further. And never while they have the conversation
   * open, and only once per unread stretch (re-armed when they read).
   */
  private notify(room: ChatRoom, msg: ChatMessage): void {
    const fn = pingers.get(this.os);
    if (!fn || msg.authorKind === 'system') return;
    const parts = room.kind === 'room' ? this.rooms.participants(room.id) : [];
    const people = room.kind === 'dm' ? [room.memberId] : parts.filter((p) => p.kind === 'member').map((p) => p.id);
    const direct = room.kind === 'dm' || (people.length === 2 && !parts.some((p) => p.kind === 'agent'));
    const from = msg.authorKind === 'agent' ? pretty(msg.authorId) : this.person(msg.authorId).name;
    const where = room.kind === 'dm' ? '' : ` in ${room.name ? `#${room.name}` : 'a group message'}`;
    for (const id of people) {
      if (msg.authorKind === 'member' && id === msg.authorId) continue;
      const mentioned = !!msg.mentions?.includes(id);
      const level = this.rooms.level(room.id, id);
      if (level === 'mute' || (!mentioned && (level === 'mentions' || !direct))) continue;
      if (Date.now() - (watching.get(`${room.id}:${id}`) ?? 0) < WATCH_MS) continue;
      if (this.rooms.pinged(room.id, id)) continue;
      const m = this.os.team.getMember(id);
      if (!m) continue;
      this.rooms.markPinged(room.id, id);
      const link = this.tm.consoleLink(`chat/${room.kind === 'dm' ? room.agent : room.id}`);
      try { fn(m, `💬 ${from} ${mentioned ? 'mentioned you' : 'messaged you'}${where} in Agentric: ${clip(msg.body.replace(/\s+/g, ' '), 220)}\n${link}`); } catch { /* a failed ping must never lose the message */ }
      this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: msg.authorKind === 'agent' ? `agent:${msg.authorId}` : msg.authorId, type: 'chat.pinged', data: { member: m.id, room: room.id, mentioned } });
    }
  }

  /** The PEOPLE a message @mentions: by first name or full name (`@priya`, `@priya-shah`), or `@here`/`@everyone`. */
  private peopleMentioned(body: string, parts: ChatParticipant[], except?: string): string[] {
    const tokens = [...body.matchAll(/@([\w.-]+)/g)].map((m) => m[1].toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (!tokens.length) return [];
    const members = parts.filter((p) => p.kind === 'member' && p.id !== except).map((p) => p.id);
    if (tokens.some((t) => t === 'here' || t === 'everyone' || t === 'all' || t === 'channel')) return members;
    return members.filter((id) => {
      const name = this.person(id).name.toLowerCase();
      const full = name.replace(/[^a-z0-9]/g, ''), first = name.split(/\s+/)[0].replace(/[^a-z0-9]/g, '');
      return tokens.some((t) => t === full || t === first);
    });
  }

  setNotify(me: Member, key: string, level: NotifyLevel): { ok: true } | Fail {
    const room = this.roomOf(me, key);
    if (!room) return { ok: false, status: 404, error: 'conversation not found' };
    this.rooms.setLevel(room.id, me.id, level);
    return { ok: true };
  }

  // ── Threads ──
  /** A message as the page shows it: with its author's name and avatar/icon. */
  private named(m: ChatMessage): RoomMessage {
    if (m.authorKind === 'agent') return { ...m, authorName: pretty(m.authorId), authorIcon: this.os.agents.get(m.authorId)?.icon };
    const p = this.person(m.authorId);
    return { ...m, authorName: p.name, authorAvatar: p.avatar };
  }

  /** The message a thread hangs off: undefined = no thread asked for, false = asked for but not a valid root. */
  private threadRoot(roomId: string, seq?: number | null): ChatMessage | undefined | false {
    if (!seq) return undefined;
    const m = this.rooms.message(roomId, seq);
    return m && !m.threadId && m.authorKind !== 'system' ? m : false;
  }

  private threadHint(root: ChatMessage | undefined | false): string {
    return root ? ` (said in the thread under: "${clip(root.body.replace(/\s+/g, ' '), 140)}")` : '';
  }

  private threadView(roomId: string, seq: number): ThreadView | null {
    const root = this.threadRoot(roomId, seq);
    return root ? { root: this.named(root), replies: this.rooms.replies(roomId, seq).map((m) => this.named(m)) } : null;
  }

  private extras(roomId: string, live: string[], me: Member): ThreadExtras {
    return {
      cardSessionIds: this.tm.dmSessionIds(roomId),
      jobs: this.rooms.openJobs(roomId).map((j) => ({ id: j.id, kind: j.kind, agent: j.agent, request: j.request, status: j.status, createdAt: j.createdAt, dueAt: j.dueAt, thread: j.threadId })),
      handoffs: live.flatMap((sid) => this.handoffs(sid, me)),
    };
  }

  /** Who the conversation's agent handed work to (delegated tasks, `ask_agent`) — from the session chain. */
  private handoffs(sessionId: string, me: Member): DmHandoff[] {
    const hit = handoffCache.get(sessionId);
    if (hit && Date.now() - hit.at < 4000) return hit.v;
    let v: DmHandoff[] = [];
    try {
      const chain = this.tm.sessionChain(sessionId, me);
      v = (chain?.nodes ?? []).filter((n) => n.depth > 0).slice(0, 12).map((n) => ({
        sessionId: n.sessionId, agent: n.agent, title: clip(n.taskTitle || n.title || '', 140), status: n.status, working: !!n.working, blocked: !!n.blocked,
        summary: n.summary ? clip(n.summary, 400) : undefined, createdAt: n.createdAt, kind: n.kind,
      }));
    } catch { /* the chain is a nicety; never fail a thread read over it */ }
    handoffCache.set(sessionId, { at: Date.now(), v });
    if (handoffCache.size > 500) handoffCache.clear();
    return v;
  }

  /** Stop the turn(s) in flight in a conversation — Escape in the pane, the session stays. */
  stop(me: Member, room: ChatRoom): { ok: true; stopped: string[] } {
    const lanes: { agent: string; sessionId: string | null }[] = room.kind === 'dm'
      ? [{ agent: room.agent, sessionId: room.sessionId }]
      : this.rooms.participants(room.id).filter((p) => p.kind === 'agent').map((p) => ({ agent: p.id, sessionId: p.sessionId }));
    const stopped: string[] = [];
    for (const l of lanes) {
      if (!l.sessionId || !this.tm.sessionPulse(l.sessionId)?.working) continue;
      if (this.tm.interruptTurn(l.sessionId, me.email)) stopped.push(l.agent);
    }
    if (stopped.length) { this.rooms.post(room.id, 'system', me.id, `${me.name || me.email} stopped ${stopped.map(pretty).join(', ')}`); chatBus.emit('changed', this.os); }
    return { ok: true, stopped };
  }

  roomOf(me: Member, key: string): ChatRoom | undefined {
    if (key.startsWith('room_')) { const r = this.roomFor(me, key); return 'ok' in r ? undefined : r; }
    return this.canChat(me, key) ? undefined : this.rooms.ensureDm(me.id, key);
  }

  /** Cancel a background run or a reminder — the person who started it, anyone in the room, or an admin. */
  cancelJob(me: Member, jobId: string): { ok: true } | Fail {
    const job = this.rooms.job(jobId);
    const room = job ? this.rooms.get(job.roomId) : undefined;
    if (!job || !room) return { ok: false, status: 404, error: 'job not found' };
    const allowed = room.kind === 'dm' ? room.memberId === me.id : this.rooms.isMember(room.id, me.id);
    if (!allowed && me.role === 'member') return { ok: false, status: 403, error: 'not your conversation' };
    if (job.status !== 'running' && job.status !== 'scheduled') return { ok: true };
    if (job.kind === 'bg' && job.sessionId) { try { this.tm.stopSession(job.sessionId, me.email, 'cancelled from chat'); } catch { /* already gone */ } }
    this.rooms.finishJob(job.id, 'cancelled');
    this.rooms.post(room.id, 'system', me.id, `${me.name || me.email} cancelled ${job.kind === 'bg' ? `${pretty(job.agent)}'s background run` : job.kind === 'fanout' ? 'the combined answer' : 'a reminder'}`);
    chatBus.emit('changed', this.os);
    return { ok: true };
  }

  /**
   * A slash command other than `/new`. Returns null when `body` isn't one (it is then an ordinary
   * message — a path like `/etc/hosts` must still be sayable). `agents` = who the command could be for.
   */
  private command(me: Member, room: ChatRoom, agents: string[], body: string, thread?: number): { ok: true; message: ChatMessage | null; notes: string[] } | Fail | null {
    const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(body);
    const name = m?.[1].toLowerCase();
    if (!m || !COMMANDS.some((c) => c.name === name)) return null;
    const who = me.name || me.email;
    let rest = (m[2] ?? '').trim();
    const note = (...notes: string[]) => ({ ok: true as const, message: null, notes });
    // Which agent the command is for: an explicit @mention, else the only one there is.
    const pick = (): string | undefined => {
      const named = this.mentioned(rest, agents.map((id) => ({ kind: 'agent' as const, id } as ChatParticipant)));
      if (named.length) { rest = rest.replace(/@[\w.-]+\s*/, '').trim(); return named[0]; }
      return agents.length === 1 ? agents[0] : undefined;
    };

    if (name === 'help') return note(...COMMANDS.map((c) => `${c.usage} — ${c.help}`));
    if (name === 'stop') {
      const r = this.stop(me, room);
      return note(r.stopped.length ? `Stopped ${r.stopped.map(pretty).join(', ')}.` : 'Nothing is running right now.');
    }
    if (name === 'status') {
      const lines: string[] = [];
      const lanes = room.kind === 'dm' ? [{ id: room.agent, sessionId: room.sessionId }] : this.rooms.participants(room.id).filter((p) => p.kind === 'agent').map((p) => ({ id: p.id, sessionId: p.sessionId }));
      for (const l of lanes) {
        const p = l.sessionId ? this.tm.sessionPulse(l.sessionId) : undefined;
        lines.push(`${pretty(l.id)}: ${p?.working ? 'working' : p?.alive ? 'active' : 'away (picks up when messaged)'}`);
      }
      for (const j of this.rooms.openJobs(room.id)) lines.push(j.kind === 'bg' ? `Background — ${pretty(j.agent)}: ${clip(j.request, 80)} (${Math.max(1, Math.round((Date.now() - j.createdAt) / 60_000))} min)` : `Reminder at ${new Date(j.dueAt ?? 0).toLocaleString()}: ${clip(j.request, 80)}`);
      return note(...(lines.length ? lines : ['Nothing is running.']));
    }
    if (name === 'bg') {
      const agent = pick();
      if (!agent) return { ok: false, status: 400, error: 'say which agent: /bg @agent <request>' };
      if (!rest) return { ok: false, status: 400, error: 'usage: /bg <request>' };
      const denied = this.canChat(me, agent);
      if (denied) return { ok: false, status: 403, error: denied };
      const recent = this.rooms.messages(room.id, { limit: 8 }).filter((x) => x.authorKind !== 'system');
      const prompt = [
        `${who} asked you, from a chat in the Agentric console, to do this in the background:`, '', rest, '',
        'Work on it without waiting for them. When you are done, your FINAL message is posted back into that chat as the result — so end with the outcome itself: what you found or did, briefly, in plain language.',
        ...(recent.length ? ['', 'For context, the chat so far (most recent last):', ...recent.map((x) => `${x.authorKind === 'agent' ? pretty(x.authorId) : this.person(x.authorId).name}: ${clip(x.body.replace(/\s+/g, ' '), 400)}`)] : []),
      ].join('\n');
      const s = this.tm.createSession(agent, `Background · ${clip(rest, 60)}`, prompt, `chat:${me.id}`, true, undefined, undefined, me.id, undefined, false);
      this.tm.markDmSession(s.id, room.id);
      this.rooms.addJob({ roomId: room.id, kind: 'bg', agent, memberId: me.id, request: rest, sessionId: s.id, status: 'running', thread });
      const message = this.rooms.post(room.id, 'member', me.id, rest, undefined, Date.now(), { tag: 'bg', thread });
      chatBus.emit('changed', this.os);
      return { ok: true, message, notes: [] };
    }
    if (name === 'task') {
      const agent = pick();
      if (!rest) return { ok: false, status: 400, error: 'usage: /task <title>' };
      const task = this.os.tasks.create({ tenant: this.os.tenant, title: clip(rest, 200), assignee: agent ? `agent:${agent}` : undefined, owner: me.id, autoDispatch: false, createdBy: me.id });
      const message = this.rooms.post(room.id, 'system', me.id, `${who} filed a task${agent ? ` for ${pretty(agent)}` : ''}: “${clip(rest, 120)}”`, undefined, Date.now(), { thread });
      chatBus.emit('changed', this.os);
      return { ok: true, message, notes: [`Task filed — ${this.tm.consoleLink(`tasks/${task.id}`)}`] };
    }
    if (name === 'summary') {
      if (room.kind !== 'room') return note('Summaries are kept for rooms.');
      const fresh = this.rooms.get(room.id) ?? room;
      void this.summarise(fresh, true).catch(() => {});
      return note(fresh.summary ? `Summary so far: ${fresh.summary}` : `Nothing summarised yet — the first summary is written once a room has ${SUMMARY_EVERY} messages${this.rooms.countAfter(room.id, 0) >= SUMMARY_KEEP + 4 ? '; writing one now, ask again in a moment' : ''}.`);
    }
    if (name === 'remind') {
      const sp = rest.search(/\s/);
      const ms = parseDuration(sp < 0 ? rest : rest.slice(0, sp));
      const what = sp < 0 ? '' : rest.slice(sp).trim();
      if (!ms || !what) return { ok: false, status: 400, error: 'usage: /remind <30m|2h|1d> <what> — from 1 minute to 30 days' };
      rest = what;
      const agent = pick() ?? '';
      const due = Date.now() + ms;
      this.rooms.addJob({ roomId: room.id, kind: 'remind', agent, memberId: me.id, request: rest, status: 'scheduled', dueAt: due, thread });
      const message = this.rooms.post(room.id, 'system', me.id, `⏰ ${who} set a reminder for ${new Date(due).toLocaleString()}: ${clip(rest, 160)}`, undefined, Date.now(), { thread });
      chatBus.emit('changed', this.os);
      return { ok: true, message, notes: [] };
    }
    return null;
  }

  /** Finish background runs that have ended (post the result) and fire reminders that are due. */
  sweepJobs(roomId?: string): void {
    const now = Date.now();
    for (const job of this.rooms.openJobs(roomId)) {
      const room = this.rooms.get(job.roomId);
      if (!room) { this.rooms.finishJob(job.id, 'cancelled'); continue; }
      if (job.kind === 'bg') {
        if (!job.sessionId || now - job.createdAt < 15_000) continue;
        const pulse = this.tm.sessionPulse(job.sessionId);
        const ended = !pulse || ['done', 'stopped', 'crashed'].includes(pulse.status) || (!pulse.alive && !pulse.working);
        if (!ended || (pulse && pulse.mtime && now - pulse.mtime < SETTLE_MS)) continue;
        const turns = pulse ? this.tm.sessionConversation(job.sessionId).turns.filter((t) => t.kind !== 'user') : [];
        const msg = foldReply(turns);
        // Back to where it was asked for — the thread, if that is still there.
        const back = job.threadId && this.threadRoot(room.id, job.threadId) ? job.threadId : null;
        if (msg) this.postAgent(room, job.agent, msg.body, msg.steps, now, { tag: 'bg', thread: back });
        else this.rooms.post(room.id, 'system', job.memberId, `${pretty(job.agent)}'s background run ended without reporting anything back`, undefined, now, { thread: back });
        this.rooms.finishJob(job.id, msg ? 'done' : 'failed');
        chatBus.emit('changed', this.os);
      } else if (job.kind === 'fanout') {
        // Someone never answered: merge what did come back, rather than leave the room waiting.
        if (now - job.createdAt > FANOUT_WAIT_MS) void this.merge(job).catch(() => {});
      } else if (job.dueAt != null && job.dueAt <= now) {
        this.rooms.finishJob(job.id, 'done');
        const me = this.os.team.getMember(job.memberId);
        const back = job.threadId && this.threadRoot(room.id, job.threadId) ? job.threadId : null;
        this.rooms.post(room.id, 'system', job.memberId, `⏰ Reminder: ${job.request}`, undefined, now, { thread: back });
        // The reminder is also handed to the agent, as the person who set it — so it follows up, not just beeps.
        const agent = room.kind === 'dm' ? room.agent : job.agent;
        if (me && agent && !this.canChat(me, agent)) {
          const text = `This is a reminder ${me.name || me.email} set earlier: ${job.request}`;
          if (room.kind === 'dm') this.dmDeliver(me, this.sync(room).room, text, back);
          else { const parts = this.rooms.participants(room.id); this.roomDeliver(me, room, parts, agent, text, me.name || me.email, 0, undefined, back); }
        }
        chatBus.emit('changed', this.os);
      }
    }
  }

  /**
   * An agent writes FIRST (the `message_send` tool): into its DM with a person — by default the one it
   * is working for — or into a room it belongs to. This is how a cron report, a finished long job or a
   * scheduled follow-up reaches someone in Messages. Posting runs nothing and grants nothing.
   */
  agentPost(sessionId: string, agent: string, input: { to?: string; room?: string; text?: string }): { ok: true; where: string } | Fail {
    const text = String(input.text ?? '').trim();
    if (!text) return { ok: false, status: 400, error: 'text is required' };
    if (text.length > 8000) return { ok: false, status: 400, error: 'message too long (max 8000 characters)' };
    const sent = proactiveSent.get(sessionId) ?? 0;
    if (sent >= MAX_PROACTIVE_PER_SESSION) return { ok: false, status: 429, error: `this session has already sent ${MAX_PROACTIVE_PER_SESSION} messages — finish up instead` };
    let room: ChatRoom | undefined, where: string;
    if (input.room) {
      const want = input.room.trim().replace(/^#/, '').toLowerCase();
      room = this.rooms.allRooms().find((r) => (r.id === input.room || (r.name ?? '').toLowerCase() === want) && this.rooms.participants(r.id).some((p) => p.kind === 'agent' && p.id === agent));
      if (!room) return { ok: false, status: 404, error: `no room "${input.room}" that you are in` };
      where = room.name ? `#${room.name}` : 'the group';
      if (this.rooms.participants(room.id).some((p) => p.kind === 'agent' && p.id === agent && p.sessionId === sessionId)) {
        return { ok: false, status: 409, error: 'you are already answering in that room — your reply is posted there when your turn ends' };
      }
    } else {
      const ref = (input.to ?? '').trim() || this.tm.sessionRunAs(sessionId) || '';
      const m = ref ? this.os.team.resolveMemberRef(ref) ?? this.os.team.listMembers().find((x) => (x.name || '').toLowerCase() === ref.toLowerCase()) : undefined;
      if (!m || m.status !== 'active') return { ok: false, status: 404, error: input.to ? `no team member "${input.to}"` : 'this run has no person to message — pass `to`' };
      room = this.rooms.ensureDm(m.id, agent);
      where = m.name || m.email;
      if (room.sessionId === sessionId) return { ok: false, status: 409, error: 'you are already in that conversation — your reply is posted there when your turn ends' };
    }
    proactiveSent.set(sessionId, sent + 1);
    this.postAgent(room, agent, text, undefined, Date.now(), { tag: 'proactive' });
    this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: `agent:${agent}`, type: 'chat.message.sent', data: { room: room.id, kind: room.kind, chars: text.length } });
    return { ok: true, where };
  }

  /**
   * Keep conversations moving when nobody has one open: fold finished replies in (which is what makes
   * an away-ping possible at all), pass agent→agent mentions along, finish background runs, fire
   * reminders. Called from the scheduler tick; self-throttled.
   */
  sweep(now: number = Date.now()): void {
    if (now - (lastSweep.get(this.os) ?? 0) < SWEEP_MS) return;
    lastSweep.set(this.os, now);
    for (const room of this.rooms.activeDms()) { try { this.watch(this.sync(room).room, room.agent, room.sessionId, null); } catch { /* one bad room must not stall the rest */ } }
    for (const room of this.rooms.allRooms()) {
      for (const p of this.rooms.participants(room.id)) {
        if (p.kind !== 'agent' || !p.sessionId || (p.syncedMark ?? '').endsWith(':0')) continue;
        try { this.syncLane(this.lane(room, p)); this.watch(room, p.id, p.sessionId, p.acting); } catch { /* as above */ }
      }
      if (room.orchestrate !== 'off') void this.summarise(room).catch(() => {});
    }
    try { this.sweepJobs(); } catch { /* as above */ }
  }
  /** The opening prompt of a session behind a DM: what this is, the recent conversation, the message. */
  private firstPrompt(me: Member, room: ChatRoom, body: string, thread?: number | null): string {
    const who = me.name || me.email;
    let recent = this.rooms.messages(room.id, { limit: RECAP_MESSAGES });
    // Nothing from before the last "New session" marker — that is what the person asked for.
    const cut = recent.map((m) => m.authorKind).lastIndexOf('system');
    if (cut >= 0) recent = recent.slice(cut + 1);
    // On a retry the message being delivered is already the room's last row — don't recap it too.
    const tail = recent[recent.length - 1];
    if (tail && tail.authorKind === 'member' && tail.body === body) recent.pop();
    const lines = [
      `You are in a direct-message conversation with ${who} in the Agentric console — a chat window, like a DM with a colleague.`,
      'They see ONLY the final message you write each turn; your tool calls and interim notes are tucked away behind it.',
      ACTIONS_HINT,
      'So answer the way a teammate would in chat: lead with the answer, keep it short, use plain language, and do the work rather than describing it. If something will take a while, say so in a sentence and carry on.',
    ];
    if (recent.length) {
      lines.push('', 'Earlier in this conversation (most recent last):');
      for (const m of recent) lines.push(`${m.authorKind === 'member' ? who : 'You'}: ${clip(m.body.replace(/\s+/g, ' '), RECAP_CHARS)}`);
    }
    lines.push('', `${who}: ${body}`, tagFor(thread));
    return lines.join('\n');
  }
}

const ACTIONS_HINT = 'When there are obvious next moves, you may offer up to 4 one-tap replies by ending your message with one line like `[[actions: Yes, ship it | Show me the diff | Not now]]` — each is sent back to you as their message when tapped, so word them as things THEY would say. Only when it genuinely saves them typing.';
const ACTIONS = /\n?[ \t]*\[\[actions?:([^\]]*)\]\][ \t]*$/i;
/** Peel a trailing `[[actions: …]]` line off an agent's message. */
export function splitActions(text: string): { body: string; actions?: string[] } {
  const trimmed = text.trimEnd();
  const m = ACTIONS.exec(trimmed);
  if (!m) return { body: text };
  const actions = [...new Set(m[1].split('|').map((a) => a.trim().replace(/^["'`]|["'`]$/g, '')).filter((a) => a && a.length <= 80))].slice(0, 4);
  const body = trimmed.slice(0, m.index).trimEnd();
  // A message that is ONLY actions has nothing to hang them on — keep it as written.
  return actions.length && body ? { body, actions } : { body: text };
}

/** Collapse one agent turn into a message: the LAST prose is what was said; the rest is how it got there. */
function foldReply(turns: ChatTurn[]): { body: string; steps: ChatStep[]; at: number } | null {
  let lastSay = -1;
  for (let k = turns.length - 1; k >= 0; k--) { const t = turns[k]; if (t.kind === 'assistant' && t.text.trim()) { lastSay = k; break; } }
  if (lastSay < 0) return null; // tool calls with nothing said — nothing to show as a message
  const reply = turns[lastSay];
  return { body: (reply as { text: string }).text.trim(), steps: stepsOf(turns.filter((_, k) => k !== lastSay)), at: reply.ts || Date.now() };
}

function stepsOf(turns: ChatTurn[]): ChatStep[] {
  const steps: ChatStep[] = [];
  for (const t of turns) {
    if (t.kind === 'assistant') { if (t.text.trim()) steps.push({ t: 'say', text: clip(t.text.trim(), STEP_CHARS) }); }
    else if (t.kind === 'activity') steps.push({ t: 'do', text: t.label, detail: t.detail ? clip(t.detail, 200) : undefined, status: t.status });
  }
  return steps.length > MAX_STEPS ? steps.slice(-MAX_STEPS) : steps;
}

/** The typing indicator for an unfinished turn: its newest step, in words. */
function typingOf(turns: ChatTurn[]): DmTyping {
  const steps = stepsOf(turns);
  const lastDo = [...steps].reverse().find((s) => s.t === 'do');
  const first = turns[0]?.ts;
  return { label: lastDo && lastDo.status === 'running' ? lastDo.text : lastDo ? 'Working' : 'Writing', steps, since: first || undefined };
}
