/**
 * DiscordSocket — the long-lived Gateway connection to the company Discord bot.
 *
 * The OS dials OUT to Discord over a WebSocket (no public URL), receives the guilds' message events,
 * and for each user message @-mentioning the bot (or DMing it) fires the matching `discord` automations
 * as governed agent sessions — exactly like cron/webhook/composio/slack triggers, so everything
 * downstream (Inbox card, gate hook, approvals, audit) just works.
 *
 * Mirrors `SlackSocket` one-for-one. The only real difference is Discord's gateway is heartbeat-driven:
 * after HELLO we must heartbeat on the server's interval and send an IDENTIFY; READY then hands us the
 * bot's own user id (so we ignore self/other bots) — the analogue of Slack's `auth.test`. We keep the
 * connection simple (fresh IDENTIFY on every reconnect, no RESUME) to match SlackSocket's stance; a
 * reconnect may miss the handful of events in the gap, which is acceptable for trigger dispatch.
 *
 * Per-member run-as: each inbound event names the Discord user. Unlike Slack a bot cannot read a user's
 * email, so we map the Discord user id → a member through the **identity map** (member_identities,
 * provider `discord`), populated from the Team page. An unmapped sender runs as the company identity,
 * the same fallback Slack uses for an unrecognised sender.
 *
 * Zero-dependency: the global `WebSocket` (Node 22+, undici) handles the wire; no `ws` package.
 */
import { AgentOS } from '../kernel';
import { Automations } from './automations';
import { GATEWAY_INTENTS, OP, getGatewayUrl, openDmChannel, parseDiscordMessage, postMessage, startThread } from '../connectors/discord';

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** A concise Discord thread title from the triggering message (Discord caps names at 100 chars). */
function threadName(text: string, actor: string): string {
  const t = (text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return t || `Agent OS — ${actor}`;
}

export class DiscordSocket {
  private ws?: WebSocket;
  private botUserId = '';
  private reconnectMs = RECONNECT_MIN_MS;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private lastSeq: number | null = null; // last dispatch sequence (heartbeat payload)
  private heartbeatAcked = true; // false once a heartbeat is in flight; a missed ACK = zombie → reconnect
  private running = false;
  private generation = 0; // bumped on every (re)start so a stale socket's handlers no-op
  private lastError = '';

  constructor(
    private readonly os: AgentOS,
    private readonly autos: Automations,
  ) {}

  /** Live status for the console (never returns the token). */
  status(): { configured: boolean; connected: boolean; botUserId: string; lastError?: string } {
    return {
      configured: this.os.settings.discordConfigured(),
      connected: this.ws?.readyState === WebSocket.OPEN && !!this.botUserId,
      botUserId: this.botUserId,
      lastError: this.lastError || undefined,
    };
  }

  /** Open the connection if Discord is configured. Idempotent — a no-op when already running or unset. */
  async start(): Promise<void> {
    if (this.running) return;
    if (!this.os.settings.discordConfigured()) return; // nothing to connect yet
    this.running = true;
    this.generation++;
    await this.connect(this.generation);
  }

  /** Tear the connection down (settings cleared, or shutdown). */
  stop(): void {
    this.running = false;
    this.generation++; // invalidate in-flight handlers
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    try { this.ws?.close(); } catch { /* best-effort */ }
    this.ws = undefined;
    this.botUserId = '';
  }

  /** Apply a changed Discord token: drop the old socket and reconnect (or stay down if now unconfigured). */
  async restart(): Promise<void> {
    this.stop();
    await this.start();
  }

  // ── connection lifecycle ─────────────────────────────────────────────────────────
  private async connect(gen: number): Promise<void> {
    if (!this.running || gen !== this.generation) return;
    const opened = await getGatewayUrl(this.os.settings.discordBotToken());
    if (gen !== this.generation) return; // superseded while we awaited
    if ('error' in opened) {
      this.lastError = opened.error;
      this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'discord', type: 'discord.connect.failed', data: { error: opened.error } });
      return this.scheduleReconnect(gen);
    }
    try {
      const ws = new WebSocket(opened.url);
      this.ws = ws;
      this.lastSeq = null;
      this.heartbeatAcked = true;
      ws.addEventListener('open', () => {
        if (gen !== this.generation) { try { ws.close(); } catch { /* */ } return; }
        this.reconnectMs = RECONNECT_MIN_MS; // healthy socket → reset backoff (full READY confirms below)
        this.lastError = '';
      });
      ws.addEventListener('message', (e: MessageEvent) => { if (gen === this.generation) this.onMessage(String(e.data), gen); });
      ws.addEventListener('error', () => { this.lastError = 'websocket error'; });
      ws.addEventListener('close', () => { if (gen === this.generation) { this.clearHeartbeat(); this.scheduleReconnect(gen); } });
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : 'websocket open failed';
      this.scheduleReconnect(gen);
    }
  }

  private scheduleReconnect(gen: number): void {
    if (!this.running || gen !== this.generation) return;
    if (this.reconnectTimer) return; // already scheduled
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect(gen);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  // ── gateway protocol ───────────────────────────────────────────────────────────
  private onMessage(data: string, gen: number): void {
    let msg: any;
    try { msg = JSON.parse(data); } catch { return; }
    if (typeof msg?.s === 'number') this.lastSeq = msg.s; // track the dispatch sequence for heartbeats
    switch (msg?.op) {
      case OP.HELLO: // server tells us the heartbeat interval → start beating + IDENTIFY
        this.startHeartbeat(Number(msg?.d?.heartbeat_interval) || 41_250, gen);
        this.identify();
        return;
      case OP.HEARTBEAT: // server asked for an immediate heartbeat
        this.sendHeartbeat();
        return;
      case OP.HEARTBEAT_ACK:
        this.heartbeatAcked = true;
        return;
      case OP.INVALID_SESSION: // our session is dead → re-IDENTIFY on a fresh socket
      case OP.RECONNECT:
        try { this.ws?.close(); } catch { /* */ }
        return; // the 'close' handler schedules the reconnect
      case OP.DISPATCH:
        if (msg.t === 'READY') {
          this.botUserId = String(msg?.d?.user?.id || '');
          const guildCount = Array.isArray(msg?.d?.guilds) ? msg.d.guilds.length : 0;
          this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'discord', type: 'discord.connected', data: { botUserId: this.botUserId, guilds: guildCount } });
        } else if (msg.t === 'MESSAGE_CREATE') {
          void this.dispatch(msg.d).catch(() => { /* never let one event kill the socket */ });
        }
        return;
      default:
        return;
    }
  }

  private identify(): void {
    const payload = {
      op: OP.IDENTIFY,
      d: {
        token: this.os.settings.discordBotToken(),
        intents: GATEWAY_INTENTS,
        properties: { os: 'linux', browser: 'agent-os', device: 'agent-os' },
      },
    };
    try { this.ws?.send(JSON.stringify(payload)); } catch { /* the close handler will recover */ }
  }

  private startHeartbeat(intervalMs: number, gen: number): void {
    this.clearHeartbeat();
    this.heartbeatAcked = true;
    this.heartbeatTimer = setInterval(() => {
      if (gen !== this.generation) return;
      if (!this.heartbeatAcked) { // missed the previous ACK → zombie connection, force a reconnect
        try { this.ws?.close(); } catch { /* */ }
        return;
      }
      this.sendHeartbeat();
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private sendHeartbeat(): void {
    this.heartbeatAcked = false;
    try { this.ws?.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.lastSeq })); } catch { /* */ }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private async dispatch(d: any): Promise<void> {
    const ev = parseDiscordMessage(d, this.botUserId);
    if (!ev) return;
    if (ev.fromBot || (this.botUserId && ev.user === this.botUserId)) return; // ignore self / other bots
    if (!ev.channel) return;

    // Resolve the triggering Discord user → an Agent OS member (per-member run-as). See the class
    // note: no email join key on Discord, so this is a seam (undefined → company identity) until the
    // member_identities map lands.
    const runAsMember = this.resolveMember(ev.user);
    const actorLabel = ev.username || ev.user || 'someone';
    // A guild @mention arrives as `<@botid> /agent …` — strip the leading bot mention so the message
    // (and the `/agent` router prefix) starts clean. `<@!id>` is the legacy nickname-mention form.
    const text = (ev.text || '').replace(new RegExp(`^\\s*<@!?${this.botUserId}>\\s*`), '').trim();

    // Inline answer: a DM reply from someone with a pending `ask_human` question answers it directly (no
    // trip to the web Inbox). Only for DMs — that's where the question was sent. If nothing pending is
    // bound to this sender, fall through to the normal chat router (an ordinary DM is just a chat).
    if (ev.eventType === 'direct_message') {
      const answered = this.autos.answerQuestionFromChat('discord', ev.user, text);
      if (answered) {
        void this.dmUser(ev.user, `✅ Got it — your answer was sent to ${answered.agent}.`);
        this.os.audit.append({
          ts: Date.now(), runId: '-', tenant: this.os.tenant,
          principal: runAsMember ? `member:${runAsMember}` : 'discord',
          type: 'question.answered.viaDm', data: { agent: answered.agent, channel: ev.channel },
        });
        return;
      }
    }

    // Thread continuity: a message inside a guild thread already bound to a session continues THAT
    // conversation (resume the same agent + transcript) instead of firing a fresh trigger — so a plain
    // "ok, now do X" in the thread keeps talking to the agent rather than hitting the /agent router's help
    // list. Guild-only (DMs have no threads); only the first @mention (nothing bound yet) falls through to
    // a fresh spawn below. Mirrors slack-socket's continueSlackThread branch.
    if (ev.guildId) {
      const cont = this.autos.continueDiscordThread({ channel: ev.channel, actorLabel, text, raw: ev.raw }, runAsMember);
      if (cont.status !== 'none') {
        this.os.audit.append({
          ts: Date.now(), runId: cont.sessionId ?? '-', tenant: this.os.tenant,
          principal: runAsMember ? `member:${runAsMember}` : 'discord', type: 'trigger.discord',
          data: { eventType: ev.eventType, channel: ev.channel, thread: true, continued: cont.status, runAs: runAsMember ?? null },
        });
        return;
      }
    }

    // Not a thread continuation. A guild message that didn't @-mention us was surfaced only for the check
    // above — drop it so ordinary channel chatter never spawns a run or spams the router (mirrors Slack's
    // non-mention drop; the parser now lets these through solely for continuity). DMs always proceed.
    if (!ev.mentioned) return;

    // Keep the whole exchange in ONE thread. For a guild @mention, branch a thread off the user's
    // message so the ack, the agent's replies, and everything after live together (not scattered as
    // channel replies). DMs have no threads → post back in the DM channel as before. If thread creation
    // fails (perms), fall back to the parent channel with a reply-reference. `channel` is what we bind to
    // the session + post into; `replyRef` inline-references the original message only when NOT in a thread.
    let channel = ev.channel;
    let replyRef: string | undefined = ev.messageId;
    if (ev.eventType === 'mention' && ev.guildId) {
      const th = await startThread(this.os.settings.discordBotToken(), ev.channel, ev.messageId, threadName(text, actorLabel));
      if ('id' in th) { channel = th.id; replyRef = undefined; }
    }

    const result = this.autos.fireDiscord(
      {
        eventType: ev.eventType,
        // Bind the THREAD (when we made one) so `discord_reply` posts back into it. Inside a thread we
        // don't need a per-message reply-reference, so clear messageId there.
        channel,
        messageId: channel === ev.channel ? ev.messageId : '',
        user: ev.user,
        actorLabel,
        text,
        raw: ev.raw,
      },
      runAsMember,
    );

    this.os.audit.append({
      ts: Date.now(),
      runId: '-',
      tenant: this.os.tenant,
      principal: runAsMember ? `member:${runAsMember}` : 'discord',
      type: 'trigger.discord',
      data: { eventType: ev.eventType, channel, thread: channel !== ev.channel, runAs: runAsMember ?? null, fired: result.fired },
    });

    // Immediate feedback so the user sees the trigger landed (in the thread when we made one). The agent
    // posts the real answer via its own `discord_reply` tool, bound to the same thread/channel. If nothing
    // fired but the generic router returned a help list, post that so the sender learns how to reach the fleet.
    if (result.fired > 0) {
      await postMessage(this.os.settings.discordBotToken(), channel, '🤖 On it — working on this now.', replyRef);
    } else if (result.reply) {
      await postMessage(this.os.settings.discordBotToken(), channel, result.reply, replyRef);
    }
  }

  /**
   * Native egress: post an agent's reply back to the Discord channel/message bound to its session.
   * Called by the server's `discord_reply` agent endpoint (session-secret verified upstream). The
   * channel/message come from the `discord_threads` binding written at spawn — the agent never supplies
   * a channel, so it can only ever reply where it was triggered. Audited as `discord.reply`.
   */
  async reply(sessionId: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const row = this.os.db
      .prepare('SELECT channel, message_id FROM discord_threads WHERE session_id = ?')
      .get<{ channel: string; message_id: string }>(sessionId);
    if (!row) return { ok: false, error: 'no Discord channel bound to this session' };
    const body = (text || '').trim();
    if (!body) return { ok: false, error: 'empty reply' };
    const res = await postMessage(this.os.settings.discordBotToken(), row.channel, body, row.message_id || undefined);
    if ('error' in res) {
      this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'discord', type: 'discord.reply.failed', data: { channel: row.channel, error: res.error } });
      return { ok: false, error: res.error };
    }
    this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'discord', type: 'discord.reply', data: { channel: row.channel, id: res.id, chars: body.length } });
    return { ok: true };
  }

  /**
   * Native egress: post to ANY channel by id. Unlike `reply` this is not bound to the triggering
   * message — it lets an agent proactively message a channel (e.g. a cron posting a daily summary).
   * Discord has no email/name lookup, so the caller supplies a channel id. Audited as `discord.send`.
   */
  async sendToChannel(sessionId: string, channelId: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const token = this.os.settings.discordBotToken();
    if (!token) return { ok: false, error: 'discord not configured' };
    const body = (text || '').trim();
    if (!body) return { ok: false, error: 'empty message' };
    const channel = (channelId || '').trim();
    if (!channel) return { ok: false, error: 'channel is required' };
    const res = await postMessage(token, channel, body);
    if ('error' in res) {
      this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'discord', type: 'discord.send.failed', data: { channel, error: res.error } });
      return { ok: false, error: res.error };
    }
    this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'discord', type: 'discord.send', data: { channel, id: res.id, chars: body.length } });
    return { ok: true };
  }

  /**
   * Native egress: DM a person by their Discord user id (Discord exposes no email lookup, so the id is
   * the only handle). Opens the DM channel then posts. Audited as `discord.dm`. Returns ok / a reason.
   */
  async dmMember(sessionId: string, to: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const token = this.os.settings.discordBotToken();
    if (!token) return { ok: false, error: 'discord not configured' };
    const body = (text || '').trim();
    if (!body) return { ok: false, error: 'empty message' };
    const userId = (to || '').trim();
    if (!userId) return { ok: false, error: 'recipient is required' };
    const ch = await openDmChannel(token, userId);
    if ('error' in ch) {
      this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'discord', type: 'discord.dm.failed', data: { to: userId, error: ch.error } });
      return { ok: false, error: ch.error };
    }
    const res = await postMessage(token, ch.channel, body);
    if ('error' in res) {
      this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'discord', type: 'discord.dm.failed', data: { to: userId, error: res.error } });
      return { ok: false, error: res.error };
    }
    this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'discord', type: 'discord.dm', data: { to: userId, id: res.id, chars: body.length } });
    return { ok: true };
  }

  /** DM a Discord user (by their Discord user id) — best-effort, used for approval notifications.
   *  Returns ok / a reason; never throws. No-op when Discord isn't configured. */
  async dmUser(discordUserId: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const token = this.os.settings.discordBotToken();
    if (!token || !discordUserId) return { ok: false, error: 'discord not configured' };
    const ch = await openDmChannel(token, discordUserId);
    if ('error' in ch) return { ok: false, error: ch.error };
    const res = await postMessage(token, ch.channel, text);
    return 'error' in res ? { ok: false, error: res.error } : { ok: true };
  }

  /** Map a Discord user id → Agent OS member id via the identity map (provider `discord`). Undefined
   *  when the sender isn't linked to a member → the run falls back to the company identity. */
  private resolveMember(userId: string): string | undefined {
    if (!userId) return undefined;
    return this.os.team.memberByExternalId('discord', userId)?.id;
  }
}
