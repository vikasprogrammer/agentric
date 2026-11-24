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
  id: string; kind: 'dm'; memberId: string; agent: string; sessionId: string | null;
  syncedTurns: number; syncedMark: string | null; hidden: boolean; createdAt: number; lastMessageAt: number | null;
}

export interface ChatMessage {
  /** 'system' = a marker the room itself wrote (e.g. "New session"), not something anyone said. */
  seq: number; roomId: string; authorKind: 'member' | 'agent' | 'system'; authorId: string; body: string;
  steps?: ChatStep[]; createdAt: number;
}

interface RoomRow {
  id: string; kind: string; member_id: string; agent: string; session_id: string | null;
  synced_turns: number; synced_mark: string | null; hidden: number; created_at: number; last_message_at: number | null;
}
interface MsgRow { seq: number; room_id: string; author_kind: string; author_id: string; body: string; meta: string | null; created_at: number }

const toRoom = (r: RoomRow): ChatRoom => ({
  id: r.id, kind: 'dm', memberId: r.member_id, agent: r.agent, sessionId: r.session_id,
  syncedTurns: r.synced_turns, syncedMark: r.synced_mark, hidden: !!r.hidden, createdAt: r.created_at, lastMessageAt: r.last_message_at,
});

function toMsg(r: MsgRow): ChatMessage {
  let steps: ChatStep[] | undefined;
  if (r.meta) { try { const m = JSON.parse(r.meta); if (Array.isArray(m.steps) && m.steps.length) steps = m.steps; } catch { /* a bad meta blob is just a message without detail */ } }
  return { seq: r.seq, roomId: r.room_id, authorKind: r.author_kind === 'agent' ? 'agent' : r.author_kind === 'system' ? 'system' : 'member', authorId: r.author_id, body: r.body, steps, createdAt: r.created_at };
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

  post(roomId: string, authorKind: 'member' | 'agent' | 'system', authorId: string, body: string, steps?: ChatStep[], at: number = Date.now()): ChatMessage {
    const meta = steps?.length ? JSON.stringify({ steps }) : null;
    const r = this.db.prepare('INSERT INTO chat_messages (room_id, author_kind, author_id, body, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(roomId, authorKind, authorId, body, meta, at);
    this.db.prepare('UPDATE chat_rooms SET last_message_at = ? WHERE id = ?').run(Date.now(), roomId);
    return { seq: Number(r.lastInsertRowid), roomId, authorKind, authorId, body, steps: steps?.length ? steps : undefined, createdAt: at };
  }

  /** Messages after `after` (oldest first); with no cursor, the newest `limit`. `before` pages backwards. */
  messages(roomId: string, opts: { after?: number; before?: number; limit?: number } = {}): ChatMessage[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 300);
    if (opts.after != null) {
      return this.db.prepare('SELECT * FROM chat_messages WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?').all<MsgRow>(roomId, opts.after, limit).map(toMsg);
    }
    const rows = opts.before != null
      ? this.db.prepare('SELECT * FROM chat_messages WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all<MsgRow>(roomId, opts.before, limit)
      : this.db.prepare('SELECT * FROM chat_messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?').all<MsgRow>(roomId, limit);
    return rows.reverse().map(toMsg);
  }

  last(roomId: string): ChatMessage | undefined {
    const r = this.db.prepare('SELECT * FROM chat_messages WHERE room_id = ? ORDER BY seq DESC LIMIT 1').get<MsgRow>(roomId);
    return r ? toMsg(r) : undefined;
  }

  /** Agent messages this member hasn't seen yet. */
  unread(roomId: string, memberId: string): number {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS c FROM chat_messages WHERE room_id = ? AND author_kind = 'agent'
          AND seq > COALESCE((SELECT last_read_seq FROM chat_reads WHERE room_id = ? AND member_id = ?), 0)`,
    ).get<{ c: number }>(roomId, roomId, memberId);
    return r?.c ?? 0;
  }

  markRead(roomId: string, memberId: string): void {
    this.db.prepare(
      `INSERT INTO chat_reads (room_id, member_id, last_read_seq) VALUES (?, ?, COALESCE((SELECT MAX(seq) FROM chat_messages WHERE room_id = ?), 0))
       ON CONFLICT(room_id, member_id) DO UPDATE SET last_read_seq = excluded.last_read_seq`,
    ).run(roomId, memberId, roomId);
  }
}
