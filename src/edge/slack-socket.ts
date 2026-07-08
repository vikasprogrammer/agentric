/**
 * SlackSocket — the long-lived Socket-Mode connection to the company Slack app.
 *
 * The OS dials OUT to Slack over a WebSocket (no public URL), receives the workspace's events, and
 * for each user message @-mentioning the bot (or DMing it) fires the matching `slack` automations as
 * governed agent sessions — exactly like cron/webhook/composio triggers, so everything downstream
 * (Inbox card, gate hook, approvals, audit) just works.
 *
 * One company app, shared across the workspace. Per-member behaviour rides on top of that one app:
 * each inbound event names the Slack user, we resolve their email → an Agent OS member, and run the
 * session AS that member (their personal connectors + their inbox). Unrecognised senders fall back to
 * the company identity. The bot posts an immediate ack in-thread; the agent itself replies using its
 * Slack egress tools (the company Slackbot connected via Composio).
 *
 * Zero-dependency: the global `WebSocket` (Node 22+, undici) handles the wire; no `ws` package.
 */
import { AgentOS } from '../kernel';
import { Automations } from './automations';
import { joinChannel, lookupBotUserId, lookupChannelByName, lookupUserByEmail, lookupUserEmail, openDmChannel, openSocketConnection, parseSlackEvent, postMessage } from '../connectors/slack';

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class SlackSocket {
  private ws?: WebSocket;
  private botUserId = '';
  private reconnectMs = RECONNECT_MIN_MS;
  private reconnectTimer?: NodeJS.Timeout;
  private running = false;
  private generation = 0; // bumped on every (re)start so a stale socket's handlers no-op
  /** slack user id → resolved email, cached for the process to avoid hammering users.info. */
  private readonly emailCache = new Map<string, string>();
  private lastError = '';

  constructor(
    private readonly os: AgentOS,
    private readonly autos: Automations,
  ) {}

  /** Live status for the console (never returns the tokens). */
  status(): { configured: boolean; connected: boolean; botUserId: string; lastError?: string } {
    return {
      configured: this.os.settings.slackConfigured(),
      connected: this.ws?.readyState === WebSocket.OPEN,
      botUserId: this.botUserId,
      lastError: this.lastError || undefined,
    };
  }

  /** Open the connection if Slack is configured. Idempotent — a no-op when already running or unset. */
  async start(): Promise<void> {
    if (this.running) return;
    if (!this.os.settings.slackConfigured()) return; // nothing to connect yet
    this.running = true;
    this.generation++;
    this.emailCache.clear();
    this.botUserId = await lookupBotUserId(this.os.settings.slackBotToken());
    await this.connect(this.generation);
  }

  /** Tear the connection down (settings cleared, or shutdown). */
  stop(): void {
    this.running = false;
    this.generation++; // invalidate in-flight handlers
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    try { this.ws?.close(); } catch { /* best-effort */ }
    this.ws = undefined;
  }

  /** Apply changed Slack tokens: drop the old socket and reconnect (or stay down if now unconfigured). */
  async restart(): Promise<void> {
    this.stop();
    await this.start();
  }

  // ── connection lifecycle ─────────────────────────────────────────────────────────
  private async connect(gen: number): Promise<void> {
    if (!this.running || gen !== this.generation) return;
    const opened = await openSocketConnection(this.os.settings.slackAppToken());
    if (gen !== this.generation) return; // superseded while we awaited
    if ('error' in opened) {
      this.lastError = opened.error;
      this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'slack', type: 'slack.connect.failed', data: { error: opened.error } });
      return this.scheduleReconnect(gen);
    }
    try {
      const ws = new WebSocket(opened.url);
      this.ws = ws;
      ws.addEventListener('open', () => {
        if (gen !== this.generation) { try { ws.close(); } catch { /* */ } return; }
        this.reconnectMs = RECONNECT_MIN_MS; // healthy connection → reset backoff
        this.lastError = '';
        this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'slack', type: 'slack.connected', data: { botUserId: this.botUserId } });
      });
      ws.addEventListener('message', (e: MessageEvent) => { if (gen === this.generation) this.onMessage(String(e.data)); });
      ws.addEventListener('error', () => { this.lastError = 'websocket error'; });
      ws.addEventListener('close', () => { if (gen === this.generation) this.scheduleReconnect(gen); });
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

  // ── protocol ─────────────────────────────────────────────────────────────────────
  private onMessage(data: string): void {
    let msg: any;
    try { msg = JSON.parse(data); } catch { return; }
    const type = msg?.type;
    if (type === 'hello') return; // connection established
    if (type === 'disconnect') { // Slack asks us to reconnect (refresh / too many conns)
      try { this.ws?.close(); } catch { /* */ }
      return; // the 'close' handler schedules the reconnect
    }
    // Every events_api / slash / interactive envelope must be ACKed by echoing its envelope_id.
    if (msg?.envelope_id) {
      try { this.ws?.send(JSON.stringify({ envelope_id: msg.envelope_id })); } catch { /* */ }
    }
    if (type === 'events_api') void this.dispatch(msg).catch(() => { /* never let one event kill the socket */ });
  }

  private async dispatch(envelope: any): Promise<void> {
    const ev = parseSlackEvent(envelope);
    if (!ev) return;
    if (ev.fromBot || (this.botUserId && ev.user === this.botUserId)) return; // ignore self / other bots
    if (!ev.channel) return;

    // Resolve the triggering Slack user → an Agent OS member (per-member run-as). Prefer an explicit
    // identity-map link (provider `slack`, set on the Team page); fall back to matching the Slack
    // profile email to a member. The map wins so a workspace can override / cover users whose Slack
    // email differs from their login email (or when the bot lacks the email scope).
    let runAsMember: string | undefined;
    let actorLabel = ev.user || 'someone';
    if (ev.user) {
      const mapped = this.os.team.memberByExternalId('slack', ev.user);
      if (mapped) {
        runAsMember = mapped.id; actorLabel = mapped.name || mapped.email;
      } else {
        const email = await this.resolveEmail(ev.user);
        if (email) {
          const m = this.os.team.getMemberByEmail(email);
          if (m) { runAsMember = m.id; actorLabel = m.name || m.email; }
        }
      }
    }

    // An app_mention arrives as `<@BOTID> /agent …` — strip the leading bot mention so the message
    // (and the `/agent` router prefix) starts clean, matching the Discord path.
    const text = (ev.text || '').replace(new RegExp(`^\\s*<@${this.botUserId}>\\s*`), '').trim();

    // Thread continuity: if this message lands inside a thread already bound to a session, continue THAT
    // conversation (resume the same agent + transcript) instead of treating it as a fresh trigger — so
    // a plain "ok, now do X" in the thread keeps talking to the agent rather than hitting the /agent
    // router's help list. Only the FIRST message in a thread (nothing bound yet) falls through below.
    const cont = this.autos.continueSlackThread(
      { channel: ev.channel, threadTs: ev.threadTs, actorLabel, text, raw: ev.raw },
      runAsMember,
    );
    if (cont.status !== 'none') {
      this.os.audit.append({
        ts: Date.now(),
        runId: cont.sessionId ?? '-',
        tenant: this.os.tenant,
        principal: runAsMember ? `member:${runAsMember}` : 'slack',
        type: 'trigger.slack',
        data: { eventType: ev.eventType, channel: ev.channel, thread: true, continued: cont.status, runAs: runAsMember ?? null },
      });
      const note =
        cont.status === 'resumed'
          ? ':robot_face: On it — continuing this thread.'
          : ':hourglass_flowing_sand: Still working on your previous message — I’ll pick this up next.';
      await postMessage(this.os.settings.slackBotToken(), ev.channel, note, ev.threadTs);
      return;
    }

    const result = this.autos.fireSlack(
      {
        eventType: ev.eventType,
        channel: ev.channel,
        threadTs: ev.threadTs,
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
      principal: runAsMember ? `member:${runAsMember}` : 'slack',
      type: 'trigger.slack',
      data: { eventType: ev.eventType, channel: ev.channel, runAs: runAsMember ?? null, fired: result.fired },
    });

    // Immediate in-thread feedback so the user sees the trigger landed. The agent posts the real
    // answer via its own Slack egress tools. If nothing fired but the generic router returned a help
    // list (unknown/unaddressed `/agent`), post that so the sender learns how to reach the fleet.
    if (result.fired > 0) {
      await postMessage(this.os.settings.slackBotToken(), ev.channel, `:robot_face: On it — working on this now.`, ev.threadTs);
    } else if (result.reply) {
      await postMessage(this.os.settings.slackBotToken(), ev.channel, result.reply, ev.threadTs);
    }
  }

  /**
   * Native egress: post an agent's reply back to the Slack thread bound to its session. Called by the
   * server's `slack_reply` agent endpoint (session-secret verified upstream). The channel/thread come
   * from the `slack_threads` binding written at spawn — the agent never supplies a channel, so it can
   * only ever reply where it was triggered. Audited as `slack.reply`. Returns ok / a reason.
   */
  async reply(sessionId: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const row = this.os.db
      .prepare('SELECT channel, thread_ts FROM slack_threads WHERE session_id = ?')
      .get<{ channel: string; thread_ts: string }>(sessionId);
    if (!row) return { ok: false, error: 'no Slack thread bound to this session' };
    const body = (text || '').trim();
    if (!body) return { ok: false, error: 'empty reply' };
    const res = await postMessage(this.os.settings.slackBotToken(), row.channel, body, row.thread_ts || undefined);
    if ('error' in res) {
      this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'slack', type: 'slack.reply.failed', data: { channel: row.channel, error: res.error } });
      return { ok: false, error: res.error };
    }
    this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'slack', type: 'slack.reply', data: { channel: row.channel, ts: res.ts, chars: body.length } });
    return { ok: true };
  }

  /**
   * Native egress: post to ANY channel by id (`C…`/`G…`) or by name (`general` / `#general`). Unlike
   * `reply` this is not bound to the triggering thread — it lets an agent proactively message a channel
   * (e.g. a cron automation posting a daily summary). Public channels the bot isn't in are auto-joined
   * on `not_in_channel` and the post retried once. Audited as `slack.send`. Returns ok / a reason.
   */
  async sendToChannel(sessionId: string, channelRef: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const token = this.os.settings.slackBotToken();
    if (!token) return { ok: false, error: 'slack not configured' };
    const body = (text || '').trim();
    if (!body) return { ok: false, error: 'empty message' };
    const ref = (channelRef || '').trim().replace(/^#/, '');
    if (!ref) return { ok: false, error: 'channel is required' };
    // Slack channel/group ids look like C/G/D + base32; anything else is treated as a channel name.
    let channel = ref;
    if (!/^[CGD][A-Z0-9]{6,}$/.test(ref)) {
      const found = await lookupChannelByName(token, ref);
      if ('error' in found) return this.sendFailed(sessionId, ref, `channel "${ref}" not found: ${found.error}`);
      channel = found.channel;
    }
    let res = await postMessage(token, channel, body);
    if ('error' in res && res.error === 'not_in_channel') {
      await joinChannel(token, channel); // best-effort; retry once whether or not the join reported ok
      res = await postMessage(token, channel, body);
    }
    if ('error' in res) return this.sendFailed(sessionId, channel, res.error);
    this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'slack', type: 'slack.send', data: { channel, ts: res.ts, chars: body.length } });
    return { ok: true };
  }

  private sendFailed(sessionId: string, channel: string, error: string): { ok: false; error: string } {
    this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'slack', type: 'slack.send.failed', data: { channel, error } });
    return { ok: false, error };
  }

  /**
   * Native egress: DM a person by their Slack user id (`U…`) or by email (resolved via
   * `users.lookupByEmail`). Opens the DM channel then posts. Lets an agent reach anyone in the
   * workspace, not just the triggering thread. Audited as `slack.dm`. Returns ok / a reason.
   */
  async dmMember(sessionId: string, to: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const token = this.os.settings.slackBotToken();
    if (!token) return { ok: false, error: 'slack not configured' };
    const body = (text || '').trim();
    if (!body) return { ok: false, error: 'empty message' };
    const ref = (to || '').trim();
    if (!ref) return { ok: false, error: 'recipient is required' };
    let userId = ref;
    if (ref.includes('@')) {
      const found = await lookupUserByEmail(token, ref);
      if ('error' in found) return this.dmFailed(sessionId, ref, `no Slack user for ${ref}: ${found.error}`);
      userId = found.user;
    }
    const ch = await openDmChannel(token, userId);
    if ('error' in ch) return this.dmFailed(sessionId, userId, ch.error);
    const res = await postMessage(token, ch.channel, body);
    if ('error' in res) return this.dmFailed(sessionId, userId, res.error);
    this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'slack', type: 'slack.dm', data: { to: userId, ts: res.ts, chars: body.length } });
    return { ok: true };
  }

  private dmFailed(sessionId: string, to: string, error: string): { ok: false; error: string } {
    this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'slack', type: 'slack.dm.failed', data: { to, error } });
    return { ok: false, error };
  }

  /** DM a Slack user (by their Slack user id) — best-effort, used for approval notifications.
   *  Returns ok / a reason; never throws. No-op when Slack isn't configured. */
  async dmUser(slackUserId: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const token = this.os.settings.slackBotToken();
    if (!token || !slackUserId) return { ok: false, error: 'slack not configured' };
    const ch = await openDmChannel(token, slackUserId);
    if ('error' in ch) return { ok: false, error: ch.error };
    const res = await postMessage(token, ch.channel, text);
    return 'error' in res ? { ok: false, error: res.error } : { ok: true };
  }

  private async resolveEmail(userId: string): Promise<string> {
    const cached = this.emailCache.get(userId);
    if (cached !== undefined) return cached;
    const email = await lookupUserEmail(this.os.settings.slackBotToken(), userId);
    this.emailCache.set(userId, email);
    return email;
  }
}
