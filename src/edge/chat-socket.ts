/**
 * The chat socket — push for the console's Messages page (`GET /api/chat/ws`, WebSocket).
 *
 * The page used to poll: its open conversation every 0.9–3 s and its sidebar every 4 s, per tab. That
 * made another person's message arrive "on the next look" and cost a request stream per viewer. This
 * moves the looking to the server: a connection says which conversation it is watching, and the server
 * pushes the thread and the sidebar WHEN THEY CHANGE — immediately on a new message (`chatBus`), and
 * off a short timer for what only a look can reveal (an agent's transcript growing).
 *
 * The payloads are exactly what `GET /api/dm/:agent`, `GET /api/rooms/:id` and `GET /api/dm` return, so
 * the REST routes stay the fallback: a browser whose socket can't open (a proxy that drops upgrades)
 * simply keeps polling them.
 *
 * Zero-dependency on purpose, like the rest of the server: a WebSocket is a 101 handshake plus a small
 * frame format, and this needs only server→client text frames and tiny client→server JSON.
 */
import crypto from 'node:crypto';
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import type { AgentOS } from '../kernel';
import type { TerminalManager } from '../terminal';
import type { Member } from '../types';
import { DirectMessages, chatBus, noteTyping } from './direct-messages';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TICK_MS = 900;
/** An idle conversation is re-read every Nth tick; one with a reply in flight, every tick. */
const IDLE_EVERY = 3;
const LIST_EVERY = 5;
const MAX_FRAME = 64 * 1024;
const MAX_LIFE_MS = 12 * 3_600_000;

interface Conn {
  socket: Duplex; os: AgentOS; tm: TerminalManager; memberId: string;
  watch: string; thread: number; visible: boolean; busy: boolean; dirty: boolean;
  lastThread: string; lastList: string; tick: number; openedAt: number;
  timer: ReturnType<typeof setInterval>; buf: Buffer; closed: boolean;
}
const conns = new Set<Conn>();

chatBus.on('changed', (os: AgentOS) => {
  for (const c of conns) {
    if (c.os !== os || c.dirty) continue;
    c.dirty = true; // coalesce a burst of posts into one push
    setImmediate(() => { c.dirty = false; pump(c, true); });
  }
});

function frame(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const n = body.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 0xff]) : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
  return Buffer.concat([head, body]);
}

function send(c: Conn, payload: unknown): void {
  if (c.closed) return;
  try { c.socket.write(frame(JSON.stringify(payload))); } catch { close(c); }
}

function close(c: Conn): void {
  if (c.closed) return;
  c.closed = true;
  clearInterval(c.timer);
  conns.delete(c);
  try { c.socket.destroy(); } catch { /* already gone */ }
}

/** Look at what this connection is watching and push whatever changed since the last look. */
function pump(c: Conn, force = false): void {
  if (c.closed) return;
  c.tick++;
  const me: Member | undefined = c.os.team.getMember(c.memberId);
  if (!me || me.status !== 'active' || Date.now() - c.openedAt > MAX_LIFE_MS) return close(c);
  try {
    const dms = new DirectMessages(c.os, c.tm);
    if (c.watch && (force || c.busy || c.tick % IDLE_EVERY === 0)) {
      const key = c.watch;
      let data: unknown, error: string | undefined;
      if (key.startsWith('room_')) {
        const r = dms.roomThread(me, key, { read: c.visible, thread: c.thread || undefined });
        if ('ok' in r) error = r.error; else { data = r; c.busy = r.typing.length > 0 || r.jobs.length > 0 || r.peopleTyping.length > 0; }
      } else {
        const denied = dms.canChat(me, key);
        if (denied) error = denied; else { const r = dms.thread(me, key, { read: c.visible, thread: c.thread || undefined }); data = r; c.busy = r.presence === 'working' || r.jobs.length > 0; }
      }
      const json = JSON.stringify(error ? { t: 'thread', key, error } : { t: 'thread', key, data });
      if (json !== c.lastThread) { c.lastThread = json; if (!c.closed) c.socket.write(frame(json)); }
    }
    if (force || c.tick % LIST_EVERY === 0) {
      const json = JSON.stringify({ t: 'list', data: { ...dms.list(me), rooms: dms.roomList(me), people: dms.people() } });
      if (json !== c.lastList) { c.lastList = json; if (!c.closed) c.socket.write(frame(json)); }
    }
  } catch { /* a bad read must not kill the connection; the next tick looks again */ }
}

/** Client → server frames: `{watch, visible}`. Everything else (pings, close) is protocol housekeeping. */
function onData(c: Conn, chunk: Buffer): void {
  c.buf = c.buf.length ? Buffer.concat([c.buf, chunk]) : chunk;
  for (;;) {
    if (c.buf.length < 2) return;
    const op = c.buf[0] & 0x0f;
    const masked = (c.buf[1] & 0x80) !== 0;
    let len = c.buf[1] & 0x7f, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) return close(c); // nothing a client legitimately sends is that large
    if (len > MAX_FRAME || !masked) return close(c); // RFC 6455: client frames MUST be masked
    if (c.buf.length < off + 4 + len) return;
    const mask = c.buf.subarray(off, off + 4);
    const payload = Buffer.from(c.buf.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    c.buf = c.buf.subarray(off + 4 + len);
    if (op === 0x8) return close(c);
    if (op === 0x9) { try { c.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); } catch { return close(c); } continue; }
    if (op !== 0x1) continue;
    let msg: { watch?: unknown; visible?: unknown; typing?: unknown; thread?: unknown };
    try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
    if (typeof msg.visible === 'boolean') c.visible = msg.visible;
    if (typeof msg.watch === 'string' && /^[\w.-]{0,80}$/.test(msg.watch) && msg.watch !== c.watch) { c.watch = msg.watch; c.thread = 0; c.lastThread = ''; c.busy = false; }
    // The open thread panel, if any — its replies ride along in the pushed thread (`threadView`).
    if ('thread' in msg) { const t = Number(msg.thread) || 0; if (t !== c.thread) { c.thread = t; c.lastThread = ''; } }
    // "I'm typing" — rooms only (a DM has nobody else to tell), and only from someone actually in it.
    if (msg.typing === true) {
      if (c.watch.startsWith('room_') && c.os.chatRooms.isMember(c.watch, c.memberId)) { noteTyping(c.watch, c.memberId); chatBus.emit('changed', c.os); }
      continue;
    }
    pump(c, true);
  }
}

/** Accept the upgrade for a signed-in member. `me` undefined (no/expired session) → 401. */
export function chatUpgrade(os: AgentOS, tm: TerminalManager, me: Member | undefined, req: http.IncomingMessage, socket: Duplex): void {
  const key = String(req.headers['sec-websocket-key'] || '');
  const refuse = (line: string) => { try { socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`); } catch { /* gone */ } socket.destroy(); };
  if (!me) return refuse('401 Unauthorized');
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return refuse('400 Bad Request');
  // A page on another site must not be able to open this with the visitor's cookie.
  const origin = String(req.headers.origin || '');
  if (origin) {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    let ohost = '';
    try { ohost = new URL(origin).host; } catch { /* unparseable → refused below */ }
    if (!ohost || ohost !== host) return refuse('403 Forbidden');
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const c: Conn = {
    socket, os, tm, memberId: me.id, watch: '', thread: 0, visible: true, busy: false, dirty: false, lastThread: '', lastList: '', tick: 0,
    openedAt: Date.now(), buf: Buffer.alloc(0), closed: false, timer: setInterval(() => pump(c), TICK_MS),
  };
  c.timer.unref?.();
  conns.add(c);
  socket.on('data', (d: Buffer) => onData(c, d));
  socket.on('close', () => close(c));
  socket.on('error', () => close(c));
  send(c, { t: 'hello' });
  pump(c, true);
}

/** How many chat sockets are open (tests, diagnostics). */
export const chatSocketCount = (): number => conns.size;
