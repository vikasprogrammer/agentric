/**
 * Chat rooms — the durable conversations behind the console's **Messages** page.
 *
 * A room owns its messages. That is the whole point of the table: a session is a process with a
 * lifetime (reaped when idle, resumed, occasionally replaced), and a person talking to a teammate
 * should never have to know which one they are talking to. The engine that keeps a room's session
 * alive and folds its transcript into messages is `src/edge/direct-messages.ts`; this store is only
 * the rows.
 *
 * `kind` is 'dm' today — one member + one agent, i.e. the member's CONTACT. The shape (room →
 * messages with an author, per-member read cursor) is deliberately the one multi-party rooms need,
 * so adding them is a new `kind` plus a membership table, not a migration of this one.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from './db';

/** One thing the agent did or said on the way to its reply — shown only when the reader expands it. */
export interface ChatStep { t: 'say' | 'do'; text: string; detail?: string; status?: 'running' | 'ok' | 'error' }

export interface ChatRoom {
  /** 'dm' = one member + one agent. 'room' = several members and/or agents; `name` set = a named room,
   *  unset = a group DM. For a room `memberId` is its creator and `agent` is ''. */
  id: string; kind: 'dm' | 'room'; name: string | null; memberId: string; agent: string; sessionId: string | null;
  syncedTurns: number; syncedMark: string | null; hidden: boolean; createdAt: number; lastMessageAt: number | null;
  pingedAt: number | null;
}

export interface ChatMessage {
  /** 'system' = a marker the room itself wrote (e.g. "New session"), not something anyone said. */
  seq: number; roomId: string; authorKind: 'member' | 'agent' | 'system'; authorId: string; body: string;
  steps?: ChatStep[]; createdAt: number;
  /** 'bg' = the result of a background run · 'proactive' = the agent wrote first · 'reminder'. */
  tag?: string;
  /** Names of files sent with the message. */
  files?: string[];
  /** A reply: the seq of the message it sits under. Absent = the main stream. */
  threadId?: number;
  /** On a main-stream message: how many replies it has, and when the last one came. */
  replies?: number; lastReplyAt?: number;
  /** Member ids this message @mentions. */
  mentions?: string[];
  /** An agent reply: how long the turn that produced it took, in ms. */
  took?: number;
}
export type NotifyLevel = 'all' | 'mentions' | 'mute';

export interface ChatJob {
  id: string; roomId: string; kind: 'bg' | 'remind'; agent: string; memberId: string; request: string;
  sessionId: string | null; status: 'running' | 'scheduled' | 'done' | 'failed' | 'cancelled'; dueAt: number | null; createdAt: number; finishedAt: number | null;
}
interface JobRow { id: string; room_id: string; kind: string; agent: string; member_id: string; request: string; session_id: string | null; status: string; due_at: number | null; created_at: number; finished_at: number | null }
const toJob = (r: JobRow): ChatJob => ({ id: r.id, roomId: r.room_id, kind: r.kind === 'remind' ? 'remind' : 'bg', agent: r.agent, memberId: r.member_id, request: r.request, sessionId: r.session_id, status: r.status as ChatJob['status'], dueAt: r.due_at, createdAt: r.created_at, finishedAt: r.finished_at });

interface RoomRow {
  id: string; kind: string; name?: string | null; member_id: string; agent: string; session_id: string | null;
  synced_turns: number; synced_mark: string | null; hidden: number; created_at: number; last_message_at: number | null; pinged_at?: number | null;
}
interface MsgRow { seq: number; room_id: string; author_kind: string; author_id: string; body: string; meta: string | null; created_at: number; thread_id?: number | null; mentions?: string | null; replies?: number | null; last_reply_at?: number | null }
const MAIN = `m.*, (SELECT COUNT(*) FROM chat_messages r WHERE r.thread_id = m.seq) AS replies, (SELECT MAX(r.created_at) FROM chat_messages r WHERE r.thread_id = m.seq) AS last_reply_at`;

const toRoom = (r: RoomRow): ChatRoom => ({
  id: r.id, kind: r.kind === 'room' ? 'room' : 'dm', name: r.name ?? null, memberId: r.member_id, agent: r.agent, sessionId: r.session_id,
  syncedTurns: r.synced_turns, syncedMark: r.synced_mark, hidden: !!r.hidden, createdAt: r.created_at, lastMessageAt: r.last_message_at, pingedAt: r.pinged_at ?? null,
});

function toMsg(r: MsgRow): ChatMessage {
  let steps: ChatStep[] | undefined, tag: string | undefined, files: string[] | undefined, took: number | undefined;
  if (r.meta) { try { const m = JSON.parse(r.meta); if (Array.isArray(m.steps) && m.steps.length) steps = m.steps; if (typeof m.tag === 'string') tag = m.tag; if (Array.isArray(m.files) && m.files.length) files = m.files.map(String); if (typeof m.took === 'number' && m.took > 0) took = m.took; } catch { /* a bad meta blob is just a message without detail */ } }
  const mentions = r.mentions ? r.mentions.split(',').filter(Boolean) : undefined;
  return { tag, files, took, threadId: r.thread_id ?? undefined, replies: r.replies || undefined, lastReplyAt: r.last_reply_at ?? undefined, mentions: mentions?.length ? mentions : undefined, seq: r.seq, roomId: r.room_id, authorKind: r.author_kind === 'agent' ? 'agent' : r.author_kind === 'system' ? 'system' : 'member', authorId: r.author_id, body: r.body, steps, createdAt: r.created_at };
}

export class ChatRoomStore {
  constructor(private readonly db: Db) {}

  dm(memberId: string, agent: string): ChatRoom | undefined {
    const r = this.db.prepare("SELECT * FROM chat_rooms WHERE kind = 'dm' AND member_id = ? AND agent = ?").get<RoomRow>(memberId, agent);
    return r ? toRoom(r) : undefined;
  }

  /** The member's DM with this agent, created (or un-hidden) on demand — "add as a contact". */
  ensureDm(memberId: string, agent: string): ChatRoom {
    const existing = this.dm(memberId, agent);
    if (existing) {
      if (existing.hidden) this.db.prepare('UPDATE chat_rooms SET hidden = 0 WHERE id = ?').run(existing.id);
      return { ...existing, hidden: false };
    }
    const id = `room_${randomBytes(8).toString('hex')}`;
    this.db.prepare("INSERT INTO chat_rooms (id, kind, member_id, agent, created_at) VALUES (?, 'dm', ?, ?, ?)").run(id, memberId, agent, Date.now());
    return this.dm(memberId, agent)!;
  }

  /** The member's contacts, most recently active first. */
  listDms(memberId: string): ChatRoom[] {
    return this.db
      .prepare("SELECT * FROM chat_rooms WHERE kind = 'dm' AND member_id = ? AND hidden = 0 ORDER BY COALESCE(last_message_at, created_at) DESC")
      .all<RoomRow>(memberId).map(toRoom);
  }

  /** Remove the contact. History stays, so re-adding the agent picks the conversation back up. */
  hide(roomId: string): void { this.db.prepare('UPDATE chat_rooms SET hidden = 1 WHERE id = ?').run(roomId); }

  /** Point the room at a (new) session, or at none. Resets the sync cursor — it counts turns of ONE transcript. */
  setSession(roomId: string, sessionId: string | null): void {
    this.db.prepare('UPDATE chat_rooms SET session_id = ?, synced_turns = 0, synced_mark = NULL WHERE id = ?').run(sessionId, roomId);
  }

  setSync(roomId: string, turns: number, mark: string): void {
    this.db.prepare('UPDATE chat_rooms SET synced_turns = ?, synced_mark = ? WHERE id = ?').run(turns, mark, roomId);
  }

  post(roomId: string, authorKind: 'member' | 'agent' | 'system', authorId: string, body: string, steps?: ChatStep[], at: number = Date.now(), extra: { tag?: string; files?: string[]; thread?: number | null; mentions?: string[]; took?: number } = {}): ChatMessage {
    const m = { ...(steps?.length ? { steps } : {}), ...(extra.tag ? { tag: extra.tag } : {}), ...(extra.files?.length ? { files: extra.files } : {}), ...(extra.took && extra.took > 0 ? { took: Math.round(extra.took) } : {}) };
    const meta = Object.keys(m).length ? JSON.stringify(m) : null;
    const mentions = extra.mentions?.length ? `,${extra.mentions.join(',')},` : null;
    const r = this.db.prepare('INSERT INTO chat_messages (room_id, author_kind, author_id, body, meta, created_at, thread_id, mentions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(roomId, authorKind, authorId, body, meta, at, extra.thread ?? null, mentions);
    this.db.prepare('UPDATE chat_rooms SET last_message_at = ? WHERE id = ?').run(Date.now(), roomId);
    return { seq: Number(r.lastInsertRowid), roomId, authorKind, authorId, body, steps: steps?.length ? steps : undefined, createdAt: at, tag: extra.tag, files: extra.files?.length ? extra.files : undefined, threadId: extra.thread ?? undefined, mentions: extra.mentions?.length ? extra.mentions : undefined, took: extra.took && extra.took > 0 ? Math.round(extra.took) : undefined };
  }

  /** Messages after `after` (oldest first); with no cursor, the newest `limit`. `before` pages backwards. */
  messages(roomId: string, opts: { after?: number; before?: number; limit?: number } = {}): ChatMessage[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 300);
    // The MAIN stream only — replies live under their message (see `thread`).
    if (opts.after != null) {
      return this.db.prepare(`SELECT ${MAIN} FROM chat_messages m WHERE m.room_id = ? AND m.thread_id IS NULL AND m.seq > ? ORDER BY m.seq LIMIT ?`).all<MsgRow>(roomId, opts.after, limit).map(toMsg);
    }
    const rows = opts.before != null
      ? this.db.prepare(`SELECT ${MAIN} FROM chat_messages m WHERE m.room_id = ? AND m.thread_id IS NULL AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`).all<MsgRow>(roomId, opts.before, limit)
      : this.db.prepare(`SELECT ${MAIN} FROM chat_messages m WHERE m.room_id = ? AND m.thread_id IS NULL ORDER BY m.seq DESC LIMIT ?`).all<MsgRow>(roomId, limit);
    return rows.reverse().map(toMsg);
  }

  /** One message of a room (any depth). */
  message(roomId: string, seq: number): ChatMessage | undefined {
    const r = this.db.prepare(`SELECT ${MAIN} FROM chat_messages m WHERE m.room_id = ? AND m.seq = ?`).get<MsgRow>(roomId, seq);
    return r ? toMsg(r) : undefined;
  }

  /** A thread: the replies under a main-stream message, oldest first. */
  replies(roomId: string, rootSeq: number, limit = 300): ChatMessage[] {
    return this.db.prepare('SELECT * FROM chat_messages WHERE room_id = ? AND thread_id = ? ORDER BY seq LIMIT ?').all<MsgRow>(roomId, rootSeq, limit).map(toMsg);
  }

  /** Unread messages that @mention this member. */
  unreadMentions(roomId: string, memberId: string): number {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS c FROM chat_messages WHERE room_id = ? AND mentions LIKE ?
          AND seq > COALESCE((SELECT last_read_seq FROM chat_reads WHERE room_id = ? AND member_id = ?), 0)`,
    ).get<{ c: number }>(roomId, `%,${memberId},%`, roomId, memberId);
    return r?.c ?? 0;
  }

  /** This member's notification level for a room (default: all). */
  level(roomId: string, memberId: string): NotifyLevel {
    const r = this.db.prepare('SELECT notify FROM chat_reads WHERE room_id = ? AND member_id = ?').get<{ notify: string | null }>(roomId, memberId);
    return r?.notify === 'mentions' || r?.notify === 'mute' ? r.notify : 'all';
  }
  setLevel(roomId: string, memberId: string, level: NotifyLevel): void {
    this.db.prepare(`INSERT INTO chat_reads (room_id, member_id, last_read_seq, notify) VALUES (?, ?, 0, ?)
      ON CONFLICT(room_id, member_id) DO UPDATE SET notify = excluded.notify`).run(roomId, memberId, level === 'all' ? null : level);
  }
  /** Has an away-ping gone to this member that they haven't read yet? */
  pinged(roomId: string, memberId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM chat_reads WHERE room_id = ? AND member_id = ? AND pinged_at IS NOT NULL').get(roomId, memberId);
  }
  markPinged(roomId: string, memberId: string): void {
    this.db.prepare(`INSERT INTO chat_reads (room_id, member_id, last_read_seq, pinged_at) VALUES (?, ?, 0, ?)
      ON CONFLICT(room_id, member_id) DO UPDATE SET pinged_at = excluded.pinged_at`).run(roomId, memberId, Date.now());
  }

  last(roomId: string): ChatMessage | undefined {
    const r = this.db.prepare('SELECT * FROM chat_messages WHERE room_id = ? ORDER BY seq DESC LIMIT 1').get<MsgRow>(roomId);
    return r ? toMsg(r) : undefined;
  }

  /** Messages from anyone else (agents, other members) this member hasn't seen yet. */
  unread(roomId: string, memberId: string): number {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS c FROM chat_messages WHERE room_id = ? AND author_kind != 'system'
          AND NOT (author_kind = 'member' AND author_id = ?)
          AND seq > COALESCE((SELECT last_read_seq FROM chat_reads WHERE room_id = ? AND member_id = ?), 0)`,
    ).get<{ c: number }>(roomId, memberId, roomId, memberId);
    return r?.c ?? 0;
  }

  markRead(roomId: string, memberId: string): void {
    this.db.prepare(
      `INSERT INTO chat_reads (room_id, member_id, last_read_seq) VALUES (?, ?, COALESCE((SELECT MAX(seq) FROM chat_messages WHERE room_id = ?), 0))
       ON CONFLICT(room_id, member_id) DO UPDATE SET last_read_seq = excluded.last_read_seq, pinged_at = NULL`,
    ).run(roomId, memberId, roomId);
    // Reading a DM re-arms its away-ping.
    this.db.prepare("UPDATE chat_rooms SET pinged_at = NULL WHERE id = ? AND kind = 'dm' AND pinged_at IS NOT NULL").run(roomId);
  }

  // ── Multi-party rooms (kind 'room') ─────────────────────────────────────────────────────────────

  get(roomId: string): ChatRoom | undefined {
    const r = this.db.prepare('SELECT * FROM chat_rooms WHERE id = ?').get<RoomRow>(roomId);
    return r ? toRoom(r) : undefined;
  }

  createRoom(creatorId: string, name: string | null): ChatRoom {
    const id = `room_${randomBytes(8).toString('hex')}`;
    this.db.prepare("INSERT INTO chat_rooms (id, kind, name, member_id, agent, created_at) VALUES (?, 'room', ?, ?, '', ?)").run(id, name, creatorId, Date.now());
    return this.get(id)!;
  }

  rename(roomId: string, name: string | null): void { this.db.prepare('UPDATE chat_rooms SET name = ? WHERE id = ?').run(name, roomId); }

  /** Rooms this member is in, most recently active first. */
  roomsFor(memberId: string): ChatRoom[] {
    return this.db.prepare(
      `SELECT r.* FROM chat_rooms r JOIN chat_participants p ON p.room_id = r.id AND p.kind = 'member' AND p.id = ?
        WHERE r.kind = 'room' ORDER BY COALESCE(r.last_message_at, r.created_at) DESC`,
    ).all<RoomRow>(memberId).map(toRoom);
  }

  participants(roomId: string): ChatParticipant[] {
    return this.db.prepare('SELECT * FROM chat_participants WHERE room_id = ? ORDER BY added_at, id').all<PartRow>(roomId).map((p) => ({
      roomId: p.room_id, kind: p.kind === 'agent' ? 'agent' : 'member', id: p.id, sessionId: p.session_id,
      syncedTurns: p.synced_turns, syncedMark: p.synced_mark, seenSeq: p.seen_seq, hop: p.hop ?? 0, acting: p.acting ?? null,
    }));
  }

  isMember(roomId: string, memberId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM chat_participants WHERE room_id = ? AND kind = 'member' AND id = ?").get(roomId, memberId);
  }

  addParticipant(roomId: string, kind: 'member' | 'agent', id: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO chat_participants (room_id, kind, id, added_at) VALUES (?, ?, ?, ?)').run(roomId, kind, id, Date.now()).changes > 0;
  }

  removeParticipant(roomId: string, kind: 'member' | 'agent', id: string): boolean {
    return this.db.prepare('DELETE FROM chat_participants WHERE room_id = ? AND kind = ? AND id = ?').run(roomId, kind, id).changes > 0;
  }

  /** Point an agent's lane in a room at a (new) session, or at none. Resets its transcript cursor. */
  setLaneSession(roomId: string, agent: string, sessionId: string | null): void {
    this.db.prepare("UPDATE chat_participants SET session_id = ?, synced_turns = 0, synced_mark = NULL WHERE room_id = ? AND kind = 'agent' AND id = ?").run(sessionId, roomId, agent);
  }

  setLaneSync(roomId: string, agent: string, turns: number, mark: string): void {
    this.db.prepare("UPDATE chat_participants SET synced_turns = ?, synced_mark = ? WHERE room_id = ? AND kind = 'agent' AND id = ?").run(turns, mark, roomId, agent);
  }

  /** How far into the room this agent has been shown — the next message it gets carries what came after. */
  setLaneSeen(roomId: string, agent: string, seq: number): void {
    this.db.prepare("UPDATE chat_participants SET seen_seq = ? WHERE room_id = ? AND kind = 'agent' AND id = ?").run(seq, roomId, agent);
  }

  /** Record the turn an agent lane is now answering: how far from a person, and for whom. */
  setLaneTurn(roomId: string, agent: string, hop: number, acting: string): void {
    this.db.prepare("UPDATE chat_participants SET hop = ?, acting = ? WHERE room_id = ? AND kind = 'agent' AND id = ?").run(hop, acting, roomId, agent);
  }

  setPinged(roomId: string, at: number | null): void { this.db.prepare('UPDATE chat_rooms SET pinged_at = ? WHERE id = ?').run(at, roomId); }

  /** DMs whose session may still produce something — the set a background sweep needs to look at. */
  activeDms(): ChatRoom[] {
    return this.db.prepare("SELECT * FROM chat_rooms WHERE kind = 'dm' AND session_id IS NOT NULL AND (synced_mark IS NULL OR synced_mark NOT LIKE '%:0')").all<RoomRow>().map(toRoom);
  }

  allRooms(): ChatRoom[] { return this.db.prepare("SELECT * FROM chat_rooms WHERE kind = 'room'").all<RoomRow>().map(toRoom); }

  // ── Jobs: background runs + reminders ──
  addJob(j: { roomId: string; kind: 'bg' | 'remind'; agent: string; memberId: string; request: string; sessionId?: string | null; status: ChatJob['status']; dueAt?: number | null }): ChatJob {
    const id = `job_${randomBytes(6).toString('hex')}`;
    this.db.prepare('INSERT INTO chat_jobs (id, room_id, kind, agent, member_id, request, session_id, status, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, j.roomId, j.kind, j.agent, j.memberId, j.request, j.sessionId ?? null, j.status, j.dueAt ?? null, Date.now());
    return this.job(id)!;
  }
  job(id: string): ChatJob | undefined { const r = this.db.prepare('SELECT * FROM chat_jobs WHERE id = ?').get<JobRow>(id); return r ? toJob(r) : undefined; }
  /** Jobs still in flight (running background runs, scheduled reminders) — for one room, or all. */
  openJobs(roomId?: string): ChatJob[] {
    const rows = roomId
      ? this.db.prepare("SELECT * FROM chat_jobs WHERE status IN ('running','scheduled') AND room_id = ? ORDER BY created_at").all<JobRow>(roomId)
      : this.db.prepare("SELECT * FROM chat_jobs WHERE status IN ('running','scheduled') ORDER BY created_at").all<JobRow>();
    return rows.map(toJob);
  }
  finishJob(id: string, status: 'done' | 'failed' | 'cancelled'): void { this.db.prepare('UPDATE chat_jobs SET status = ?, finished_at = ? WHERE id = ?').run(status, Date.now(), id); }

  deleteRoom(roomId: string): void {
    for (const t of ['chat_messages', 'chat_participants', 'chat_reads', 'chat_jobs']) this.db.prepare(`DELETE FROM ${t} WHERE room_id = ?`).run(roomId);
    this.db.prepare("DELETE FROM chat_rooms WHERE id = ? AND kind = 'room'").run(roomId);
  }
}

export interface ChatParticipant {
  roomId: string; kind: 'member' | 'agent'; id: string; sessionId: string | null;
  syncedTurns: number; syncedMark: string | null; seenSeq: number;
  /** Agent lane: how many agent→agent hops from a person the turn it is answering sits, and who it acts for. */
  hop: number; acting: string | null;
}
interface PartRow { room_id: string; kind: string; id: string; session_id: string | null; synced_turns: number; synced_mark: string | null; seen_seq: number; added_at: number; hop?: number; acting?: string | null }
