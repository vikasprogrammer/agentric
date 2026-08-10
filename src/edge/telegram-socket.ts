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
import { isCodingRuntime } from '../types';
import { Automations } from './automations';
import { getMe, getUpdates, parseTelegramUpdate, sendMessage, setMyCommands, telegramCommandName } from '../connectors/telegram';

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
    // Register the chat-reachable fleet as the bot's `/command` menu (best-effort, off the hot path).
    void this.syncCommands();
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
    // the `/agent` router prefix — starts clean, then map a registered Telegram command name back to its
    // real (possibly hyphenated) agent id so a tapped `/agent_author` reaches `agent-author`.
    let text = this.resolveCommand(this.stripMention(ev.text));

    // `/new` (or `/reset`) — end the current conversation in this chat and start fresh. Detected before
    // continuity so the command itself never gets delivered into the live session. `/new` alone acks and
    // returns; `/new <request>` resets then falls through with the request as a fresh spawn. Skipped if an
    // agent is literally named `new`/`reset` (resolveCommand would already have rewritten a tapped one).
    const reset = text.match(/^\/(new|reset|newchat)(?:@\w+)?\b\s*/i);
    if (reset && !this.os.agents.has(reset[1].toLowerCase())) {
      const r = this.autos.resetTelegramChat(ev.chatId, ev.messageThreadId);
      this.os.audit.append({
        ts: Date.now(), runId: '-', tenant: this.os.tenant,
        principal: runAsMember ? `member:${runAsMember}` : 'telegram',
        type: 'telegram.chat.reset', data: { chat: ev.chatId, closed: r.closed, agent: r.agent ?? null },
      });
      text = text.slice(reset[0].length).trim();
      if (!text) {
        void this.dmUser(ev.chatId, r.closed
          ? `🆕 Ended the conversation with ${r.agent}. Send your next request, or tap /command to pick an agent.`
          : `🆕 Fresh start — send your next request, or tap /command to pick an agent.`);
        return;
      }
      // else: fall through with the remaining text as a brand-new request.
    }

    // Helper commands — read-only, reply-and-return. Detected before continuity/routing so they never get
    // delivered into a live session or mistaken for an agent. `/start` is Telegram's implicit first-open
    // command; we treat it as help. Guarded so an agent literally named help/agents/whoami still wins.
    const meta = text.match(/^\/(help|start|agents|whoami)(?:@\w+)?\b/i);
    if (meta && !this.os.agents.has(meta[1].toLowerCase())) {
      const cmd = meta[1].toLowerCase();
      const reply = cmd === 'agents' ? this.agentsText()
        : cmd === 'whoami' ? this.whoamiText(ev.user, actorLabel)
        : this.helpText();
      void this.dmUser(ev.chatId, reply);
      return;
    }

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

    // Thread continuity: a message in a chat already bound to a session continues THAT conversation
    // (resume the same agent + transcript) instead of firing a fresh trigger. Keyed on chat id (+ forum
    // topic). Runs for BOTH a group AND a private chat — a Telegram DM is one persistent 1:1 conversation
    // (chat id == the user id), so a plain follow-up continues the last run rather than spawning a fresh
    // one. The `continueSessionDm` path above is the narrower case (a run the OS proactively DM'd about);
    // this is the general "keep talking in this chat". Only the first message (nothing bound yet) falls
    // through to a fresh spawn below.
    {
      const cont = this.autos.continueTelegramThread({ chat: ev.chatId, messageThreadId: ev.messageThreadId, actorLabel, text, raw: ev.raw }, runAsMember);
      if (cont.status !== 'none') {
        this.os.audit.append({
          ts: Date.now(), runId: cont.sessionId ?? '-', tenant: this.os.tenant,
          principal: runAsMember ? `member:${runAsMember}` : 'telegram', type: 'trigger.telegram',
          data: { eventType: ev.eventType, chat: ev.chatId, thread: true, dm: isDM, continued: cont.status, runAs: runAsMember ?? null },
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

  /** Map a Telegram user id → Agentric member id via the identity map (provider `telegram`). Undefined
   *  when the sender isn't linked to a member → the run falls back to the company identity. */
  private resolveMember(userId: string): string | undefined {
    if (!userId) return undefined;
    return this.os.team.memberByExternalId('telegram', userId)?.id;
  }

  /** The chat-reachable claude-code fleet — the same set the `/agent` router addresses. */
  private chatAgents(): { id: string; description?: string }[] {
    return [...this.os.agents.values()]
      .filter((a: any) => isCodingRuntime(a.runtime) && a.category !== 'System' && a.chatReachable !== false)
      .map((a: any) => ({ id: a.id, description: a.description }));
  }

  /** The `/help` (and `/start`) reply — how to drive the bot. Plain text (messages are sent without a
   *  parse_mode), so no markdown. */
  private helpText(): string {
    return [
      '🤖 Agentric — how to use this bot:',
      '',
      '• Address an agent by name:  /agent_name your request',
      "• …or just describe what you need and I'll route it to the best-fit agent.",
      '• Follow-up messages continue the same conversation.',
      '',
      'Commands:',
      '• /agents — list the agents you can reach',
      '• /new — end this conversation and start a fresh one',
      '• /whoami — how I identify you',
      '• /help — this message',
    ].join('\n');
  }

  /** The `/agents` reply — the reachable fleet as tappable command names + one-line descriptions. */
  private agentsText(): string {
    const agents = this.chatAgents();
    if (!agents.length) return 'No agents are reachable from chat right now.';
    const lines = agents.map((a) => {
      const desc = (a.description || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      return `• /${telegramCommandName(a.id)}${desc ? ` — ${desc}` : ''}`;
    });
    return ['Agents you can reach:', ...lines, '', 'Address one with /name <request>, or just describe your task.'].join('\n');
  }

  /** The `/whoami` reply — which member the sender resolves to (run-as), or the unmapped fallback. */
  private whoamiText(userId: string, actorLabel: string): string {
    const member = this.os.team.memberByExternalId('telegram', userId);
    if (member) {
      return `You're linked as ${member.name || member.email} (${member.email} · ${member.role}). Runs act as you — your connectors and inbox.`;
    }
    return [
      `You're not linked to a member yet, so runs use the shared company identity (not your personal connectors).`,
      `Your Telegram id is ${userId}${actorLabel ? ` (${actorLabel})` : ''} — an owner/admin can map it on the Team page (Chat identities → Telegram) so runs act as you.`,
    ].join('\n');
  }

  /**
   * Register the fleet as the bot's `/command` menu (`setMyCommands`) so a user sees the agents when they
   * type `/`. Each agent id is normalised to a Telegram-safe command name (`telegramCommandName`), deduped
   * on collision (first wins), and capped at Telegram's 100-command limit. `resolveCommand` reverses the
   * mapping on an inbound tap. Best-effort — a failure is audited and the bot still works via typed names.
   * Re-run on every (re)connect, so a token re-save (or restart) refreshes the menu after the roster changes.
   */
  private async syncCommands(): Promise<void> {
    const token = this.os.settings.telegramBotToken();
    if (!token) return;
    // Built-in helper commands first (see the meta/`/new` branches in dispatch). Seed `seen` with their
    // names so an agent that normalises to one of them can't override the helper.
    const commands: { command: string; description: string }[] = [
      { command: 'agents', description: 'List the agents you can reach' },
      { command: 'new', description: 'End this conversation and start a fresh one' },
      { command: 'whoami', description: 'Show how I identify you' },
      { command: 'help', description: 'How to use this bot' },
    ];
    const seen = new Set<string>(commands.map((c) => c.command));
    for (const a of this.chatAgents()) {
      const command = telegramCommandName(a.id);
      if (!command || seen.has(command)) continue;
      seen.add(command);
      const desc = (a.description || `Chat with ${a.id}`).replace(/\s+/g, ' ').trim().slice(0, 256) || `Chat with ${a.id}`;
      commands.push({ command, description: desc });
      if (commands.length >= 100) break;
    }
    const res = await setMyCommands(token, commands);
    this.os.audit.append({
      ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'telegram',
      type: 'error' in res ? 'telegram.commands.failed' : 'telegram.commands.synced',
      data: 'error' in res ? { error: res.error } : { count: commands.length },
    });
  }

  /** Reverse `telegramCommandName`: a leading `/token` (a tapped menu command) whose normalised form
   *  matches a real agent id is rewritten to `/<real-id> …` so the downstream `/agent` router resolves it.
   *  A `/token` that IS already a known agent id, or matches none, is left untouched. */
  private resolveCommand(text: string): string {
    const m = text.match(/^\/([A-Za-z0-9_]+)(?:@\w+)?/);
    if (!m) return text;
    const tok = m[1];
    if (this.os.agents.has(tok)) return text; // already the real id
    const hit = [...this.os.agents.values()].find((a: any) => telegramCommandName(a.id) === tok.toLowerCase());
    return hit ? `/${hit.id}${text.slice(m[0].length)}` : text;
  }
}
