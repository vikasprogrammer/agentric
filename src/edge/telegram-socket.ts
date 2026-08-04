/**
 * TelegramSocket — the long-lived long-poll connection to the company Telegram bot.
 *
 * The OS dials OUT to `api.telegram.org` (no public URL), long-polls `getUpdates`, and for each user
 * message that @-mentions the bot (in a group) or is sent in a private chat fires the matching `telegram`
 * automations as governed agent sessions — exactly like cron/webhook/composio/slack/discord triggers, so
 * everything downstream (Inbox card, gate hook, approvals, audit) just works.
 *
 * Mirrors `DiscordSocket` one-for-one. Two real differences:
 *   • The wire is a long-poll HTTPS loop, not a WebSocket — so there is no heartbeat/opcode machinery,
 *     just `getUpdates(offset, timeout)` in a loop with an abortable in-flight request and backoff on error.
 *   • Telegram bots can't branch a thread off a message in a normal group (forum topics need admin
 *     rights), so — unlike Discord's per-mention thread — replies go back into the SAME chat as a reply to
 *     the triggering message, and thread-continuity is keyed on the chat id (+ forum topic id when present),
 *     the Discord per-channel model.
 *
 * Per-member run-as: each inbound update names the Telegram user. Telegram exposes no email, so we map the
 * user id → a member through the **identity map** (member_identities, provider `telegram`), populated from
 * the Team page. An unmapped sender runs as the company identity — the same fallback Discord uses.
 *
 * Zero-dependency: the global `fetch` (Node 22+) handles the wire.
 */
import { AgentOS } from '../kernel';
import { Automations } from './automations';
import { getMe, getUpdates, parseTelegramUpdate, sendMessage } from '../connectors/telegram';

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const LONG_POLL_SEC = 25; // how long Telegram holds an idle getUpdates open

export class TelegramSocket {
  private botId = '';
  private botUsername = '';
  private offset = 0; // next update id to fetch (confirms everything below it)
  private running = false;
  private connected = false;
  private reconnectMs = RECONNECT_MIN_MS;
  private generation = 0; // bumped on every (re)start so a stale poll loop no-ops
  private abort?: AbortController;
  private lastError = '';

  constructor(
    private readonly os: AgentOS,
    private readonly autos: Automations,
  ) {}

  /** Live status for the console (never returns the token). */
  status(): { configured: boolean; connected: boolean; botUserId: string; username: string; lastError?: string } {
    return {
      configured: this.os.settings.telegramConfigured(),
      connected: this.connected && !!this.botId,
      botUserId: this.botId,
      username: this.botUsername,
      lastError: this.lastError || undefined,
    };
  }

  /** Open the connection if Telegram is configured. Idempotent — a no-op when already running or unset. */
  async start(): Promise<void> {
    if (this.running) return;
    if (!this.os.settings.telegramConfigured()) return; // nothing to connect yet
    this.running = true;
    this.generation++;
    await this.connect(this.generation);
  }

  /** Tear the connection down (settings cleared, or shutdown). */
  stop(): void {
    this.running = false;
    this.generation++; // invalidate the in-flight poll loop
    this.connected = false;
    try { this.abort?.abort(); } catch { /* best-effort */ }
    this.abort = undefined;
    this.botId = '';
    this.botUsername = '';
  }

  /** Apply a changed Telegram token: drop the loop and reconnect (or stay down if now unconfigured). */
  async restart(): Promise<void> {
    this.stop();
    await this.start();
  }

  // ── connection lifecycle ─────────────────────────────────────────────────────────
  private async connect(gen: number): Promise<void> {
    if (!this.running || gen !== this.generation) return;
    const me = await getMe(this.os.settings.telegramBotToken());
    if (gen !== this.generation) return; // superseded while we awaited
    if ('error' in me) {
      this.lastError = me.error;
      this.connected = false;
      this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'telegram', type: 'telegram.connect.failed', data: { error: me.error } });
      return this.scheduleReconnect(gen);
    }
    this.botId = me.id;
    this.botUsername = me.username;
    this.lastError = '';
    this.reconnectMs = RECONNECT_MIN_MS;
    this.connected = true;
    this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'telegram', type: 'telegram.connected', data: { botId: this.botId, username: this.botUsername } });
    // Drain the backlog: fetch only the latest queued update and advance the offset past it WITHOUT
    // processing, so a restart never replays hours-old messages (Telegram re-sends everything above the
    // last confirmed offset, and a fresh process starts at offset 0).
    const drain = await getUpdates(this.os.settings.telegramBotToken(), -1, 0);
    if (gen !== this.generation) return;
    if ('updates' in drain && drain.updates.length) {
      this.offset = Math.max(...drain.updates.map((u: any) => Number(u.update_id) || 0)) + 1;
    }
    void this.poll(gen);
  }

  private scheduleReconnect(gen: number): void {
    if (!this.running || gen !== this.generation) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    const t = setTimeout(() => { void this.connect(gen); }, delay);
    t.unref?.();
  }

  /** The long-poll loop: block on getUpdates, dispatch each update, advance the offset. Runs until the
   *  generation changes (stop/restart). A network error backs off (via reconnect) and re-enters connect. */
  private async poll(gen: number): Promise<void> {
    while (this.running && gen === this.generation) {
      this.abort = new AbortController();
      const res = await getUpdates(this.os.settings.telegramBotToken(), this.offset, LONG_POLL_SEC, this.abort.signal);
      if (gen !== this.generation) return;
      if ('error' in res) {
        this.connected = false;
        this.lastError = res.error;
        this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'telegram', type: 'telegram.poll.failed', data: { error: res.error } });
        return this.scheduleReconnect(gen); // back off, then re-validate + resume
      }
      this.connected = true;
      this.reconnectMs = RECONNECT_MIN_MS;
      for (const u of res.updates) {
        this.offset = Math.max(this.offset, (Number(u.update_id) || 0) + 1);
        void this.dispatch(u).catch(() => { /* never let one update kill the loop */ });
      }
    }
  }

  private async dispatch(update: any): Promise<void> {
    const ev = parseTelegramUpdate(update, this.botId, this.botUsername);
    if (!ev) return;
    if (ev.fromBot || (this.botId && ev.user === this.botId)) return; // ignore self / other bots
    if (!ev.chatId) return;

    const runAsMember = this.resolveMember(ev.user);
    const actorLabel = ev.username || ev.user || 'someone';
    const isDM = ev.eventType === 'direct_message';
    // Strip a leading @botusername (and the `@bot` appended to a `/cmd@bot` command) so the message — and
    // the `/agent` router prefix — starts clean.
    const text = this.stripMention(ev.text);

    // Inline approve/deny: a private-chat reply from someone with a pending approval we sent them resolves
    // the gate directly (no trip to the web Inbox). Only for private chats (where the ping was sent).
    // Checked first: while an approval is pending, a "yes"/"no" here is a decision, not chat.
    if (isDM) {
      const decided = this.autos.decideApprovalFromChat('telegram', ev.user, text);
      if (decided) {
        if (decided.status === 'decided') {
          void this.dmUser(ev.chatId, decided.approved ? `✅ Approved — ${decided.capability} will proceed.` : `🚫 Rejected — ${decided.capability} was blocked.`);
        } else if (decided.status === 'unclear') {
          void this.dmUser(ev.chatId, `I couldn't tell if that's a yes or no — reply "approve" or "deny" to decide the pending request.`);
        } else {
          void this.dmUser(ev.chatId, `You're no longer able to approve that request.`);
        }
        return;
      }
    }

    // Inline answer: a private-chat reply from someone with a pending `ask_human` question answers it
    // directly. Only for private chats — that's where the question was sent.
    if (isDM) {
      const answered = this.autos.answerQuestionFromChat('telegram', ev.user, text);
      if (answered) {
        void this.dmUser(ev.chatId, `✅ Got it — your answer was sent to ${answered.agent}.`);
        this.os.audit.append({
          ts: Date.now(), runId: '-', tenant: this.os.tenant,
          principal: runAsMember ? `member:${runAsMember}` : 'telegram',
          type: 'question.answered.viaDm', data: { agent: answered.agent, chat: ev.chatId },
        });
        return;
      }
    }

    // DM continuity: a reply to a private-chat message we sent ABOUT a run (an agent's `notify`, "your run
    // finished / crashed") goes back INTO that run — after the two decision paths, before the router.
    if (isDM) {
      const cont = this.autos.continueSessionDm('telegram', ev.user, { actorLabel, text, channel: ev.chatId }, runAsMember);
      if (cont.status !== 'none' && cont.sessionId) {
        void this.dmUser(ev.chatId, `✅ Sent to ${cont.agent} — it'll reply here. (To start something else instead: /agent-name your request.)`);
        this.os.audit.append({
          ts: Date.now(), runId: cont.sessionId, tenant: this.os.tenant,
          principal: runAsMember ? `member:${runAsMember}` : 'telegram',
          type: 'trigger.telegram', data: { eventType: ev.eventType, chat: ev.chatId, dm: true, continued: cont.status, runAs: runAsMember ?? null },
        });
        return;
      }
    }

    // Thread continuity: a message in a group chat already bound to a session continues THAT conversation
    // (resume the same agent + transcript) instead of firing a fresh trigger. Keyed on chat id (+ forum
    // topic). Group-only; a private chat is covered by the DM-continuity path above. Only the first
    // @mention (nothing bound yet) falls through to a fresh spawn below.
    if (!isDM) {
      const cont = this.autos.continueTelegramThread({ chat: ev.chatId, messageThreadId: ev.messageThreadId, actorLabel, text, raw: ev.raw }, runAsMember);
      if (cont.status !== 'none') {
        this.os.audit.append({
          ts: Date.now(), runId: cont.sessionId ?? '-', tenant: this.os.tenant,
          principal: runAsMember ? `member:${runAsMember}` : 'telegram', type: 'trigger.telegram',
          data: { eventType: ev.eventType, chat: ev.chatId, thread: true, continued: cont.status, runAs: runAsMember ?? null },
        });
        return;
      }
    }

    // Not a continuation. A group message that didn't @-mention us (or isn't a command/reply) was surfaced
    // only for the check above — drop it so ordinary group chatter never spawns a run or spams the router
    // (mirrors Discord's non-mention drop). Private chats always proceed.
    if (!ev.mentioned) return;

    const result = await this.autos.fireTelegram(
      {
        eventType: ev.eventType,
        chat: ev.chatId,
        messageThreadId: ev.messageThreadId,
        messageId: ev.messageId,
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
      principal: runAsMember ? `member:${runAsMember}` : 'telegram',
      type: 'trigger.telegram',
      data: { eventType: ev.eventType, chat: ev.chatId, runAs: runAsMember ?? null, fired: result.fired },
    });

    // Immediate feedback so the user sees the trigger landed. The agent posts the real answer via its own
    // `telegram_reply` tool, bound to the same chat. If nothing fired but the generic router returned a
    // help list, post that so the sender learns how to reach the fleet.
    if (result.fired > 0) {
      await sendMessage(this.os.settings.telegramBotToken(), ev.chatId, '🤖 On it — working on this now.', { replyToMessageId: ev.messageId, messageThreadId: ev.messageThreadId });
    } else if (result.reply) {
      await sendMessage(this.os.settings.telegramBotToken(), ev.chatId, result.reply, { replyToMessageId: ev.messageId, messageThreadId: ev.messageThreadId });
    }
  }

  /**
   * Native egress: post an agent's reply back to the Telegram chat/message bound to its session. Called
   * by the server's `telegram_reply` agent endpoint (session-secret verified upstream). The
   * chat/thread/message come from the `telegram_threads` binding written at spawn — the agent never
   * supplies a chat, so it can only ever reply where it was triggered. Audited as `telegram.reply`.
   */
  async reply(sessionId: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const row = this.os.db
      .prepare('SELECT chat_id, message_thread_id, message_id FROM telegram_threads WHERE session_id = ?')
      .get<{ chat_id: string; message_thread_id: string; message_id: string }>(sessionId);
    if (!row) return { ok: false, error: 'no Telegram chat bound to this session' };
    const body = (text || '').trim();
    if (!body) return { ok: false, error: 'empty reply' };
    const res = await sendMessage(this.os.settings.telegramBotToken(), row.chat_id, body, {
      replyToMessageId: row.message_id || undefined,
      messageThreadId: row.message_thread_id || undefined,
    });
    if ('error' in res) {
      this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'telegram', type: 'telegram.reply.failed', data: { chat: row.chat_id, error: res.error } });
      return { ok: false, error: res.error };
    }
    this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'telegram', type: 'telegram.reply', data: { chat: row.chat_id, id: res.id, chars: body.length } });
    return { ok: true };
  }

  /** Post to a Telegram chat by id — best-effort, used for the inline acks above. Returns ok / a reason;
   *  never throws. No-op when Telegram isn't configured. */
  async dmUser(chatId: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const token = this.os.settings.telegramBotToken();
    if (!token || !chatId) return { ok: false, error: 'telegram not configured' };
    const res = await sendMessage(token, chatId, text);
    return 'error' in res ? { ok: false, error: res.error } : { ok: true };
  }

  /** Strip a leading @botusername mention and any `@botusername` appended to a `/cmd@bot` command, so a
   *  re-mention doesn't land in the message the router / a live claude sees. */
  private stripMention(text: string): string {
    if (!this.botUsername) return (text || '').trim();
    const re = new RegExp(`@${this.botUsername.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'ig');
    return (text || '').replace(re, '').trim();
  }

  /** Map a Telegram user id → Agent OS member id via the identity map (provider `telegram`). Undefined
   *  when the sender isn't linked to a member → the run falls back to the company identity. */
  private resolveMember(userId: string): string | undefined {
    if (!userId) return undefined;
    return this.os.team.memberByExternalId('telegram', userId)?.id;
  }
}
