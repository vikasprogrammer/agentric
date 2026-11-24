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
import type { ChatMessage, ChatParticipant, ChatRoom, ChatStep } from '../state/chat-rooms';
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

export interface DmTyping { label: string; steps: ChatStep[]; since?: number }
export type DmPresence = 'working' | 'online' | 'away';

export interface DmContact {
  agent: string; roomId: string; description: string; icon?: string;
  presence: DmPresence; lastText?: string; lastFromMe?: boolean; lastAt: number; unread: number;
  /** The session currently behind the room — used only to attach pending approvals/questions. */
  sessionId: string | null;
}

export interface DmThread {
  agent: string; roomId: string; sessionId: string | null; presence: DmPresence;
  messages: ChatMessage[]; typing: DmTyping | null;
  /** The member's last message got no reply and nothing is running that could produce one. */
  stalled: boolean;
}

// ── Rooms & group DMs (kind 'room') ──
export interface RoomPerson { id: string; name: string; avatar?: string }
export interface RoomAgent { id: string; description: string; icon?: string; presence: DmPresence }
export interface RoomSummary {
  id: string; name: string | null; members: RoomPerson[]; agents: RoomAgent[]; createdBy: string;
  lastText?: string; lastAuthor?: string; lastAt: number; unread: number;
}
export type RoomMessage = ChatMessage & { authorName: string; authorIcon?: string; authorAvatar?: string };
export interface RoomThread {
  room: RoomSummary; messages: RoomMessage[];
  typing: { agent: string; label: string; steps: ChatStep[] }[];
  /** Sessions behind the room's agents — used only to attach pending approvals/questions. */
  sessionIds: string[];
}
export type RoomSendResult =
  | { ok: true; message: ChatMessage; delivered: string[]; notes: string[] }
  | { ok: false; status: number; error: string; held?: boolean };
type Fail = { ok: false; status: number; error: string };
const MAX_ROOM_PEOPLE = 30;
const MAX_ROOM_AGENTS = 8;
const ROOM_CONTEXT_MESSAGES = 20;
const pretty = (id: string): string => id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export type DmSendResult =
  | { ok: true; message: ChatMessage; sessionId: string | null }
  | { ok: false; status: number; error: string; held?: boolean };

/** One agent's session inside one room, as the sync sees it. */
interface Lane {
  key: string; roomId: string; agent: string; sessionId: string | null; syncedTurns: number; syncedMark: string | null;
  save(turns: number, mark: string): void;
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
        lastAt: room.lastMessageAt ?? room.createdAt, unread: this.rooms.unread(room.id, me.id), sessionId: room.sessionId,
      });
    }
    const added = new Set(contacts.map((c) => c.agent));
    return { contacts, directory: reachable.filter((a) => !added.has(a.id)) };
  }

  thread(me: Member, agent: string, opts: { after?: number; before?: number; read?: boolean } = {}): DmThread {
    const { room, presence, typing } = this.sync(this.rooms.ensureDm(me.id, agent));
    if (opts.read) this.rooms.markRead(room.id, me.id);
    const last = this.rooms.last(room.id);
    return {
      agent, roomId: room.id, sessionId: room.sessionId, presence, typing,
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
      return { presence, typing: pulse.working ? liveTyping.get(lane.key) ?? { label: 'Working', steps: [] } : null };
    }

    const turns = this.tm.sessionConversation(lane.sessionId).turns;
    let i = Math.min(lane.syncedTurns, turns.length);
    let typing: DmTyping | null = null;
    let unsettled = false;
    const quiet = pulse.mtime ? Date.now() - pulse.mtime : Infinity;
    while (i < turns.length) {
      if (turns[i].kind === 'user') { i++; continue; }
      let j = i;
      while (j < turns.length && turns[j].kind !== 'user') j++;
      // A run of agent turns is a finished reply once something came after it, or the turn has ended AND
      // the transcript has gone quiet (see SETTLE_MS). Until then it is the typing indicator.
      const seg = turns.slice(i, j);
      const said = seg.some((t) => t.kind === 'assistant' && t.text.trim());
      const finished = j < turns.length || (!pulse.working && quiet > (said ? SETTLE_MS : TEXTLESS_DROP_MS));
      if (!finished) { typing = typingOf(seg); unsettled = !pulse.working; break; }
      const msg = foldReply(seg);
      if (msg) this.rooms.post(lane.roomId, 'agent', lane.agent, msg.body, msg.steps, msg.at);
      i = j;
    }
    if (pulse.working && !typing) typing = { label: 'Thinking', steps: [] };
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
  send(me: Member, agent: string, text: string, opts: { retry?: boolean } = {}): DmSendResult {
    // A retry re-delivers the member's last message rather than posting it a second time.
    const again = opts.retry ? this.lastFromMember(me, agent) : undefined;
    let body = (again?.body ?? text).trim();
    if (!body) return { ok: false, status: 400, error: 'message is required' };
    const denied = this.canChat(me, agent);
    if (denied) return { ok: false, status: 403, error: denied };
    // `/new` — the person asks for a clean slate. Never delivered to the agent as text.
    const cmd = again ? null : NEW_COMMAND.exec(body);
    if (cmd) {
      const marker = this.reset(me, agent);
      body = (cmd[1] ?? '').trim();
      if (!body) return { ok: true, message: marker, sessionId: null };
    }
    // Sync first so the agent's previous reply lands in the room BEFORE this message, not after it.
    let { room } = this.sync(this.rooms.ensureDm(me.id, agent));

    const d = this.deliver(me, agent, room.id, room.sessionId, body, `Direct message · ${me.name || me.email}`, () => this.firstPrompt(me, room, body));
    if (!d.ok) return d;
    const sessionId = d.sessionId;
    if (d.fresh) { this.rooms.setSession(room.id, sessionId); room = this.rooms.dm(me.id, agent) ?? room; }
    const message = again ?? this.rooms.post(room.id, 'member', me.id, body);
    this.rooms.markRead(room.id, me.id);
    return { ok: true, message, sessionId };
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
      if (r.typing) typing.push({ agent: p.id, label: r.typing.label, steps: r.typing.steps });
      if (p.sessionId) sessionIds.push(p.sessionId);
    }
    const fresh = this.rooms.get(room.id) ?? room;
    const last = this.rooms.last(room.id);
    return {
      summary: {
        id: room.id, name: room.name, createdBy: room.memberId, agents,
        members: parts.filter((p) => p.kind === 'member').map((p) => this.person(p.id)),
        lastText: last ? clip(last.body.replace(/\s+/g, ' '), 90) : undefined,
        lastAuthor: !last || last.authorKind === 'system' ? undefined : last.authorKind === 'agent' ? pretty(last.authorId) : last.authorId === me.id ? 'You' : this.person(last.authorId).name.split(' ')[0],
        lastAt: fresh.lastMessageAt ?? fresh.createdAt, unread: this.rooms.unread(room.id, me.id),
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

  roomRename(me: Member, roomId: string, name: string): { ok: true } | Fail {
    const room = this.roomFor(me, roomId);
    if ('ok' in room) return room;
    const clean = name.trim().replace(/^#/, '').slice(0, 60) || null;
    this.rooms.rename(roomId, clean);
    this.rooms.post(roomId, 'system', me.id, clean ? `${me.name || me.email} named this room “${clean}”` : `${me.name || me.email} removed the room name`);
    return { ok: true };
  }

  roomThread(me: Member, roomId: string, opts: { before?: number; read?: boolean } = {}): RoomThread | Fail {
    const room = this.roomFor(me, roomId);
    if ('ok' in room) return room;
    const d = this.describe(room, me);
    if (opts.read) this.rooms.markRead(roomId, me.id);
    const cache = new Map<string, RoomPerson>();
    const messages: RoomMessage[] = this.rooms.messages(roomId, { before: opts.before }).map((m) => {
      if (m.authorKind === 'agent') return { ...m, authorName: pretty(m.authorId), authorIcon: this.os.agents.get(m.authorId)?.icon };
      let p = cache.get(m.authorId);
      if (!p) cache.set(m.authorId, (p = this.person(m.authorId)));
      return { ...m, authorName: p.name, authorAvatar: p.avatar };
    });
    return { room: d.summary, messages, typing: d.typing, sessionIds: d.sessionIds };
  }

  /** Which of the room's agents a message is addressed to. */
  private addressed(body: string, parts: ChatParticipant[]): string[] {
    const agents = parts.filter((p) => p.kind === 'agent').map((p) => p.id);
    const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const named = new Set<string>();
    for (const m of body.matchAll(/@([\w.-]+)/g)) {
      const want = squash(m[1]);
      const hit = agents.find((a) => squash(a) === want);
      if (hit) named.add(hit);
    }
    if (named.size) return [...named];
    // One person, one agent: there is nobody else the message could be for.
    return agents.length === 1 && parts.filter((p) => p.kind === 'member').length === 1 ? agents : [];
  }

  roomSend(me: Member, roomId: string, text: string): RoomSendResult {
    const room = this.roomFor(me, roomId);
    if ('ok' in room) return room;
    let body = text.trim();
    if (!body) return { ok: false, status: 400, error: 'message is required' };
    let parts = this.rooms.participants(roomId);
    // Fold every agent's pending reply into the room BEFORE this message, so the order reads true.
    for (const p of parts) if (p.kind === 'agent') this.syncLane(this.lane(room, p));

    const cmd = NEW_COMMAND.exec(body);
    if (cmd) {
      const marker = this.rooms.post(roomId, 'system', me.id, NEW_SESSION_MARKER);
      for (const p of parts) if (p.kind === 'agent') { this.rooms.setLaneSession(roomId, p.id, null); this.rooms.setLaneSeen(roomId, p.id, marker.seq); liveTyping.delete(`${roomId}:${p.id}`); }
      body = (cmd[1] ?? '').trim();
      if (!body) return { ok: true, message: marker, delivered: [], notes: [] };
      parts = this.rooms.participants(roomId);
    }

    const who = me.name || me.email;
    const label = room.name ? `#${room.name}` : 'group chat';
    const history = this.rooms.messages(roomId, { limit: 60 });
    const delivered: string[] = [], notes: string[] = [];
    const lanes = new Map(parts.filter((p) => p.kind === 'agent').map((p) => [p.id, p]));
    for (const agent of this.addressed(body, parts)) {
      const denied = this.canChat(me, agent);
      if (denied) { notes.push(`${pretty(agent)} didn't get this — ${denied}.`); continue; }
      const p = lanes.get(agent)!;
      // What the agent missed: everything said in the room since it was last shown, minus its own words.
      const missed = history.filter((m) => m.seq > p.seenSeq && m.authorKind !== 'system' && !(m.authorKind === 'agent' && m.authorId === agent)).slice(-ROOM_CONTEXT_MESSAGES)
        .map((m) => `${m.authorKind === 'agent' ? pretty(m.authorId) : m.authorId === me.id ? who : this.person(m.authorId).name}: ${clip(m.body.replace(/\s+/g, ' '), RECAP_CHARS)}`);
      const turn = `[${label}] ${missed.length ? `Said since your last turn — ${missed.join(' | ')} — ` : ''}${who} to you: ${body}`;
      const d = this.deliver(me, agent, roomId, p.sessionId, turn, `${room.name ? `#${room.name}` : 'Group chat'} · ${pretty(agent)}`, () => this.roomPrompt(room, parts, agent, missed, who, body));
      if (!d.ok) { if (d.held) return d; notes.push(`${pretty(agent)} didn't get this — ${d.error}.`); continue; }
      if (d.fresh) this.rooms.setLaneSession(roomId, agent, d.sessionId);
      delivered.push(agent);
    }
    const message = this.rooms.post(roomId, 'member', me.id, body);
    for (const agent of delivered) this.rooms.setLaneSeen(roomId, agent, message.seq);
    this.rooms.markRead(roomId, me.id);
    return { ok: true, message, delivered, notes };
  }

  /** The opening prompt of an agent's session in a room: where it is, who is there, how to behave. */
  private roomPrompt(room: ChatRoom, parts: ChatParticipant[], agent: string, missed: string[], who: string, body: string): string {
    const people = parts.filter((p) => p.kind === 'member').map((p) => this.person(p.id).name);
    const others = parts.filter((p) => p.kind === 'agent' && p.id !== agent).map((p) => pretty(p.id));
    const lines = [
      `You are ${pretty(agent)}, taking part in ${room.name ? `the room "#${room.name}"` : 'a group chat'} in the Agentric console — a shared chat, like a channel with colleagues.`,
      `People here: ${people.join(', ')}.${others.length ? ` Other agents here: ${others.join(', ')}.` : ''}`,
      'You are only brought in when someone addresses you. Each time, you are shown what was said since your last turn, then the message for you.',
      'Everyone in the room sees ONLY the final message you write each turn; your tool calls and interim notes are tucked away behind it.',
      'So answer the way a teammate would in a group chat: reply to the person who asked, lead with the answer, keep it short, and do the work rather than describing it. You act on behalf of whoever addressed you.',
    ];
    if (missed.length) { lines.push('', 'Said in the room so far (most recent last):'); lines.push(...missed); }
    lines.push('', `${who} to you: ${body}`);
    return lines.join('\n');
  }

  /** The opening prompt of a session behind a DM: what this is, the recent conversation, the message. */
  private firstPrompt(me: Member, room: ChatRoom, body: string): string {
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
      'So answer the way a teammate would in chat: lead with the answer, keep it short, use plain language, and do the work rather than describing it. If something will take a while, say so in a sentence and carry on.',
    ];
    if (recent.length) {
      lines.push('', 'Earlier in this conversation (most recent last):');
      for (const m of recent) lines.push(`${m.authorKind === 'member' ? who : 'You'}: ${clip(m.body.replace(/\s+/g, ' '), RECAP_CHARS)}`);
    }
    lines.push('', `${who}: ${body}`);
    return lines.join('\n');
  }
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
