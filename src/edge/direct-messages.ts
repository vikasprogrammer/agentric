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
import type { ChatMessage, ChatRoom, ChatStep } from '../state/chat-rooms';
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

export type DmSendResult =
  | { ok: true; message: ChatMessage; sessionId: string }
  | { ok: false; status: number; error: string; held?: boolean };

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
    if (!room.sessionId) return { room, presence: 'away', typing: null };
    const pulse = this.tm.sessionPulse(room.sessionId);
    if (!pulse) return { room, presence: 'away', typing: null };
    const presence: DmPresence = pulse.working ? 'working' : pulse.alive ? 'online' : 'away';
    const base = `${pulse.size}:${pulse.mtime}:${pulse.working ? 1 : 0}:${pulse.alive ? 1 : 0}`;
    if (base === room.syncedMark) {
      return { room, presence, typing: pulse.working ? liveTyping.get(room.id) ?? { label: 'Working', steps: [] } : null };
    }

    const turns = this.tm.sessionConversation(room.sessionId).turns;
    let i = Math.min(room.syncedTurns, turns.length);
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
      if (msg) this.rooms.post(room.id, 'agent', room.agent, msg.body, msg.steps, msg.at);
      i = j;
    }
    if (pulse.working && !typing) typing = { label: 'Thinking', steps: [] };
    if (typing) liveTyping.set(room.id, typing); else liveTyping.delete(room.id);
    // An unsettled tail resolves with TIME, not with a change to the file — so leave a mark that can't
    // match, and the next poll looks again.
    this.rooms.setSync(room.id, i, unsettled ? `${base}:unsettled` : base);
    return { room: this.rooms.dm(room.memberId, room.agent) ?? room, presence, typing };
  }

  /** Send the member's message: deliver, resume, or transparently start a fresh session. */
  send(me: Member, agent: string, text: string, opts: { retry?: boolean } = {}): DmSendResult {
    // A retry re-delivers the member's last message rather than posting it a second time.
    const again = opts.retry ? this.lastFromMember(me, agent) : undefined;
    const body = (again?.body ?? text).trim();
    if (!body) return { ok: false, status: 400, error: 'message is required' };
    const denied = this.canChat(me, agent);
    if (denied) return { ok: false, status: 403, error: denied };
    // Sync first so the agent's previous reply lands in the room BEFORE this message, not after it.
    let { room } = this.sync(this.rooms.ensureDm(me.id, agent));

    let sessionId = room.sessionId;
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
    let delivered = false;
    if (usable) {
      this.tm.noteTyper(sessionId!, me.id, 'composer');
      const r = this.tm.chatSend(sessionId!, body, me.id);
      if (r === 'paused') return { ok: false, status: 409, error: `${agent} is paused — resume it from Sessions to keep talking` };
      delivered = r === 'sent';
    }
    if (!delivered) {
      const s = this.tm.createSession(
        agent, `Direct message · ${me.name || me.email}`, this.firstPrompt(me, room, body),
        `chat:${me.id}`, false, undefined, undefined, me.id, undefined, true,
      );
      sessionId = s.id;
      this.tm.markDmSession(s.id, room.id);
      this.rooms.setSession(room.id, s.id);
      room = this.rooms.dm(me.id, agent) ?? room;
    }
    const message = again ?? this.rooms.post(room.id, 'member', me.id, body);
    this.rooms.markRead(room.id, me.id);
    return { ok: true, message, sessionId: sessionId! };
  }

  private lastFromMember(me: Member, agent: string): ChatMessage | undefined {
    const room = this.rooms.dm(me.id, agent);
    const last = room ? this.rooms.last(room.id) : undefined;
    return last && last.authorKind === 'member' ? last : undefined;
  }

  /** Forget the session behind the room (history stays). The next message starts clean — the escape
   *  hatch from a wedged or confused conversation. */
  reset(me: Member, agent: string): void {
    const room = this.rooms.dm(me.id, agent);
    if (!room) return;
    this.sync(room);
    this.rooms.setSession(room.id, null);
    liveTyping.delete(room.id);
  }

  /** The opening prompt of a session behind a DM: what this is, the recent conversation, the message. */
  private firstPrompt(me: Member, room: ChatRoom, body: string): string {
    const who = me.name || me.email;
    const recent = this.rooms.messages(room.id, { limit: RECAP_MESSAGES });
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
