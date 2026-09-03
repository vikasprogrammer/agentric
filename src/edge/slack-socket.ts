/**
 * SlackSocket — the long-lived Socket-Mode connection to the company Slack app.
 *
 * The OS dials OUT to Slack over a WebSocket (no public URL), receives the workspace's events, and
 * for each user message @-mentioning the bot (or DMing it) fires the matching `slack` automations as
 * governed agent sessions — exactly like cron/webhook/composio triggers, so everything downstream
 * (Inbox card, gate hook, approvals, audit) just works.
 *
 * One company app, shared across the workspace. Per-member behaviour rides on top of that one app:
 * each inbound event names the Slack user, we resolve their email → an Agentric member, and run the
 * session AS that member (their personal connectors + their inbox). Unrecognised senders fall back to
 * the company identity. The bot posts an immediate ack in-thread; the agent itself replies using its
 * Slack egress tools (the company Slackbot connected via Composio).
 *
 * Zero-dependency: the global `WebSocket` (Node 22+, undici) handles the wire; no `ws` package.
 */
import { AgentOS } from '../kernel';
import { Automations, chatAck } from './automations';
import { downloadSlackFile, explainSlackError, joinChannel, lookupBotUserId, lookupChannelByName, lookupUserByEmail, lookupUserEmail, openDmChannel, openSocketConnection, parseSlackEvent, postMessage, SlackFileRef } from '../connectors/slack';

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** Attachments per message we'll fetch. A pasted screenshot is one file; a dumped folder is not a chat. */
const MAX_FILES = 5;
/** Per-file ceiling. Big enough for a screenshot, a PDF or a log; small enough that a video doesn't
 *  stall the socket's dispatch or fill the agent folder. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export class SlackSocket {
  private ws?: WebSocket;
  private botUserId = '';
  private reconnectMs = RECONNECT_MIN_MS;
  private reconnectTimer?: NodeJS.Timeout;
  private running = false;
  private generation = 0; // bumped on every (re)start so a stale socket's handlers no-op
  /** slack user id → resolved email, cached for the process to avoid hammering users.info. */
  private readonly emailCache = new Map<string, string>();
  /** email → slack user id (or null when the address isn't in the workspace), cached for the process.
   *  Backs the identity-map auto-link so a notification never re-queries users.lookupByEmail per send. */
  private readonly userByEmailCache = new Map<string, string | null>();
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
    // Slack swallows a leading `/…` as a slash command, so `/support-ops help me` typed in a DM never
    // reaches the events stream at all — the sender just sees "that command doesn't exist". The single
    // declared `/agentric <agent> <request>` command gives that syntax a real home, and Socket Mode
    // delivers it here rather than to a public request URL.
    if (type === 'slash_commands') void this.dispatchSlashCommand(msg).catch(() => { /* same */ });
  }

  private async dispatch(envelope: any): Promise<void> {
    const ev = parseSlackEvent(envelope);
    if (!ev) return;
    if (ev.fromBot || (this.botUserId && ev.user === this.botUserId)) return; // ignore self / other bots
    if (!ev.channel) return;

    // Resolve the triggering Slack user → an Agentric member (per-member run-as). Prefer an explicit
    // identity-map link (provider `slack`, set on the Team page); fall back to matching the Slack
    // profile email to a member. The map wins so a workspace can override / cover users whose Slack
    // email differs from their login email (or when the bot lacks the email scope).
    const { runAsMember, actorLabel } = await this.resolveActor(ev.user);

    // An app_mention arrives as `<@BOTID> /agent …` — strip the leading bot mention so the message
    // (and the `/agent` router prefix) starts clean, matching the Discord path.
    const text = (ev.text || '').replace(new RegExp(`^\\s*<@${this.botUserId}>\\s*`), '').trim();

    // Attachments. Slack hands us metadata, not bytes: the file lives behind an authenticated URL, so we
    // fetch it here (bot token, bounded count + size) and hand the agent real files in its own folder.
    // Downloaded BEFORE routing so the same buffers serve whichever path claims the message.
    const files = await this.fetchFiles(ev.files);

    // Thread continuity: if this message lands inside a thread already bound to a session, continue THAT
    // conversation (resume the same agent + transcript) instead of treating it as a fresh trigger — so
    // a plain "ok, now do X" in the thread keeps talking to the agent rather than hitting the /agent
    // router's help list. Only the FIRST message in a thread (nothing bound yet) falls through below.
    const cont = this.autos.continueSlackThread(
      { channel: ev.channel, threadTs: ev.threadTs, actorLabel, text, raw: ev.raw, files },
      runAsMember,
    );
    if (cont.status !== 'none') {
      // Handled by the thread's warm session — delivered into the live claude, or revived it. No ack:
      // the agent's own `slack_reply` is the feedback (continueSlackThread already audited the turn).
      this.os.audit.append({
        ts: Date.now(),
        runId: cont.sessionId ?? '-',
        tenant: this.os.tenant,
        principal: runAsMember ? `member:${runAsMember}` : 'slack',
        type: 'trigger.slack',
        data: { eventType: ev.eventType, channel: ev.channel, thread: true, continued: cont.status, runAs: runAsMember ?? null },
      });
      return;
    }

    // Not a thread continuation. A plain channel `message` (no @mention) normally reached us only because
    // the app subscribes to `message.channels` FOR that continuity — chatter in a channel the bot happens
    // to sit in, never a fresh trigger, so it is dropped rather than spamming the `/agent` router's help
    // list into the channel.
    //
    // The one exception is a **channel watch**: an automation whose filter names THIS channel id is a
    // standing instruction to act on what lands there ("abuse reports arrive in #trust-safety"), and such
    // reports are pasted, forwarded or relayed — almost never addressed to the bot. Requiring an @mention
    // makes the automation depend on the reporter remembering to summon it. So a watched channel's
    // messages go to `fireSlack` with `channelWatch`, which fires ONLY channel-scoped automations whose
    // `when`/`unless` predicates hold, and never the router. Everything else still drops here.
    //
    // The OTHER exception is a thread we are already IN. A thread the bot opened itself (a cron report
    // posted with `slack_send`, a proactive nudge) never had a `slack_threads` row, and a bound thread
    // whose run has ended unresumably yields `none` above — in both cases a human replying under our own
    // message was dropped as chatter, which reads as the bot ignoring you in the conversation it started.
    // Having spoken in a thread IS the targeting signal, so a reply there routes normally (fresh spawn
    // bound to the thread) instead of demanding an @mention the sender has no reason to add.
    const isDm = ev.channelType === 'im' || ev.channelType === 'mpim';
    if (ev.eventType !== 'app_mention' && !isDm) {
      const ours = !!ev.threadTs && this.autos.knowsSlackThread(ev.channel, ev.threadTs);
      if (ours) {
        const r = await this.autos.fireSlack(
          { eventType: ev.eventType, channel: ev.channel, threadTs: ev.threadTs, user: ev.user, actorLabel, text, raw: ev.raw, files },
          runAsMember,
          { fallbackAgent: this.autos.agentForSlackThread(ev.channel, ev.threadTs) },
        );
        this.stageInto(r.sessions, files);
        this.os.audit.append({
          ts: Date.now(),
          runId: r.sessions[0] ?? '-',
          tenant: this.os.tenant,
          principal: runAsMember ? `member:${runAsMember}` : 'slack',
          type: 'trigger.slack',
          data: { eventType: ev.eventType, channel: ev.channel, thread: true, ourThread: true, runAs: runAsMember ?? null, fired: r.fired, files: files.length || null },
        });
        if (r.fired > 0) await postMessage(this.os.settings.slackBotToken(), ev.channel, chatAck(r.agents), ev.threadTs);
        else if (r.reply) await postMessage(this.os.settings.slackBotToken(), ev.channel, r.reply, ev.threadTs);
        return;
      }
      if (!this.autos.watchesSlackChannel(ev.channel)) return;
      const watch = await this.autos.fireSlack(
        { eventType: ev.eventType, channel: ev.channel, threadTs: ev.threadTs, user: ev.user, actorLabel, text, raw: ev.raw, files },
        runAsMember,
        { channelWatch: true, router: false },
      );
      this.stageInto(watch.sessions, files);
      // Audited only when something happened. A watched channel sees every message pass through here, so
      // an unconditional audit row would make the busiest channel the loudest thing in the audit log.
      if (watch.fired > 0 || watch.dropped) {
        this.os.audit.append({
          ts: Date.now(),
          runId: watch.sessions[0] ?? '-',
          tenant: this.os.tenant,
          principal: runAsMember ? `member:${runAsMember}` : 'slack',
          type: 'trigger.slack',
          data: { eventType: ev.eventType, channel: ev.channel, watch: true, runAs: runAsMember ?? null, fired: watch.fired, dropped: watch.dropped ?? null },
        });
      }
      if (watch.fired > 0) {
        await postMessage(this.os.settings.slackBotToken(), ev.channel, chatAck(watch.agents), ev.threadTs);
      }
      return;
    }

    // Inline approve/deny: a DM reply from someone with a pending approval we sent them resolves the gate
    // directly (no trip to the web Inbox) — the approval-side twin of the question path below. Only for
    // DMs (where the approval ping was sent). Checked first: while an approval is pending, a "yes"/"no"
    // in this DM is a decision, not chat. `null` → nothing bound, fall through to the question/chat router.
    if (isDm) {
      const decided = this.autos.decideApprovalFromChat('slack', ev.user, text);
      if (decided) {
        if (decided.status === 'decided') {
          void this.dmUser(ev.user, decided.approved ? `✅ Approved — \`${decided.capability}\` will proceed.` : `🚫 Rejected — \`${decided.capability}\` was blocked.`);
        } else if (decided.status === 'unclear') {
          void this.dmUser(ev.user, `I couldn't tell if that's a yes or no — reply *approve* or *deny* to decide the pending request.`);
        } else {
          void this.dmUser(ev.user, `You're no longer able to approve that request.`);
        }
        return;
      }
    }

    // Inline answer: a DM reply from someone with a pending `ask_human` question answers it directly (no
    // trip to the web Inbox). Only for DMs — that's where the question was sent. If nothing pending is
    // bound to this sender, fall through to the normal chat router (an ordinary DM is just a chat).
    if (isDm) {
      const answered = this.autos.answerQuestionFromChat('slack', ev.user, text);
      if (answered) {
        void this.dmUser(ev.user, `✅ Got it — your answer was sent to ${answered.agent}.`);
        this.os.audit.append({
          ts: Date.now(), runId: '-', tenant: this.os.tenant,
          principal: runAsMember ? `member:${runAsMember}` : 'slack',
          type: 'question.answered.viaDm', data: { agent: answered.agent, channel: ev.channel },
        });
        return;
      }
    }

    // DM continuity: a reply to a DM we sent ABOUT a run (an agent's `notify`, "your run finished /
    // crashed") goes back INTO that run — the DM-keyed analogue of the thread continuity above, and the
    // last one-way notification channel to be closed. Checked after the two decision paths (a pending
    // approval/question is the more specific claim on the same reply) and before the router, which would
    // otherwise spawn a FRESH session with none of the context the human is replying to.
    if (isDm) {
      const cont = this.autos.continueSessionDm('slack', ev.user, { actorLabel, text, channel: ev.channel }, runAsMember);
      if (cont.status !== 'none' && cont.sessionId) {
        void this.dmUser(ev.user, `✅ Sent to *${cont.agent}* — it'll reply here. (To start something else instead: \`/agent-name your request\`.)`);
        this.os.audit.append({
          ts: Date.now(), runId: cont.sessionId, tenant: this.os.tenant,
          principal: runAsMember ? `member:${runAsMember}` : 'slack',
          type: 'trigger.slack', data: { eventType: ev.eventType, channel: ev.channel, dm: true, continued: cont.status, runAs: runAsMember ?? null },
        });
        return;
      }
    }

    const result = await this.autos.fireSlack(
      {
        eventType: ev.eventType,
        channel: ev.channel,
        threadTs: ev.threadTs,
        user: ev.user,
        actorLabel,
        text,
        raw: ev.raw,
        files,
      },
      runAsMember,
    );
    this.stageInto(result.sessions, files);

    this.os.audit.append({
      ts: Date.now(),
      runId: '-',
      tenant: this.os.tenant,
      principal: runAsMember ? `member:${runAsMember}` : 'slack',
      type: 'trigger.slack',
      data: { eventType: ev.eventType, channel: ev.channel, runAs: runAsMember ?? null, fired: result.fired, files: files.length || null },
    });

    // Immediate in-thread feedback so the user sees the trigger landed. The agent posts the real
    // answer via its own Slack egress tools. If nothing fired but the generic router returned a help
    // list (unknown/unaddressed `/agent`), post that so the sender learns how to reach the fleet.
    if (result.fired > 0) {
      await postMessage(this.os.settings.slackBotToken(), ev.channel, chatAck(result.agents), ev.threadTs);
    } else if (result.reply) {
      await postMessage(this.os.settings.slackBotToken(), ev.channel, result.reply, ev.threadTs);
    }
  }

  /** Resolve a Slack user id → the member to run as (identity map first, then profile email) plus a
   *  human label for prompts and filters. Shared by the events and slash-command paths. */
  private async resolveActor(userId: string): Promise<{ runAsMember?: string; actorLabel: string }> {
    let actorLabel = userId || 'someone';
    if (!userId) return { actorLabel };
    const mapped = this.os.team.memberByExternalId('slack', userId);
    if (mapped) return { runAsMember: mapped.id, actorLabel: mapped.name || mapped.email };
    const email = await this.resolveEmail(userId);
    if (email) {
      const m = this.os.team.getMemberByEmail(email);
      if (m) return { runAsMember: m.id, actorLabel: m.name || m.email };
    }
    return { actorLabel };
  }

  /** Fetch a message's attachments as bytes. Slack only ever hands us metadata — the file itself sits
   *  behind an authenticated URL — so without this an agent sees "here's the screenshot" and no
   *  screenshot. Bounded by MAX_FILES / MAX_FILE_BYTES; a failed download is audited and skipped rather
   *  than failing the whole message, since the text is usually still actionable. */
  private async fetchFiles(refs: SlackFileRef[]): Promise<{ name: string; data: Buffer }[]> {
    if (!refs?.length) return [];
    const token = this.os.settings.slackBotToken();
    const out: { name: string; data: Buffer }[] = [];
    for (const f of refs.slice(0, MAX_FILES)) {
      if (f.size && f.size > MAX_FILE_BYTES) {
        this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'slack', type: 'slack.file.skipped', data: { name: f.name, size: f.size, reason: 'too large' } });
        continue;
      }
      const got = await downloadSlackFile(token, f.url, MAX_FILE_BYTES);
      if ('error' in got) {
        this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'slack', type: 'slack.file.failed', data: { name: f.name, error: got.error } });
        continue;
      }
      out.push({ name: f.name, data: got.data });
      this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'slack', type: 'slack.file.received', data: { name: f.name, bytes: got.data.length, mime: f.mimetype } });
    }
    return out;
  }

  /** Write the downloaded attachments into each freshly spawned session's agent folder. */
  private stageInto(sessions: string[], files: { name: string; data: Buffer }[]): void {
    if (!files.length) return;
    for (const sid of sessions) this.autos.stageInboundFiles(sid, files);
  }

  /**
   * The `/agentric <agent> <request>` slash command. Slack's slash-command interception is the reason
   * this exists: a leading `/` never reaches the events stream, so the `/support-ops …` syntax the help
   * text advertises is dead on arrival in a DM. One declared command restores it for every agent
   * without a per-agent Slack manifest entry.
   *
   * The ack is posted FIRST so its `ts` can become the thread root, then the spawned run is re-bound to
   * that thread — so the agent answers in a thread and follow-ups continue the conversation through the
   * ordinary thread path instead of stranding.
   */
  private async dispatchSlashCommand(envelope: any): Promise<void> {
    const p = envelope?.payload || {};
    const channel = String(p.channel_id || '');
    if (!channel) return;
    const userId = String(p.user_id || '');
    const { runAsMember, actorLabel } = await this.resolveActor(userId);
    // Slack strips the command itself: `/agentric support-ops fix X` arrives as text `support-ops fix X`.
    const body = String(p.text || '').trim();
    const text = body.startsWith('/') ? body : `/${body}`;
    const token = this.os.settings.slackBotToken();
    const result = await this.autos.fireSlack(
      { eventType: 'slash_command', channel, threadTs: '', user: userId, actorLabel, text, raw: p },
      runAsMember,
    );
    this.os.audit.append({
      ts: Date.now(), runId: result.sessions[0] ?? '-', tenant: this.os.tenant,
      principal: runAsMember ? `member:${runAsMember}` : 'slack',
      type: 'trigger.slack', data: { eventType: 'slash_command', command: String(p.command || ''), channel, runAs: runAsMember ?? null, fired: result.fired },
    });
    const ack = result.fired > 0
      ? `<@${userId}> asked: ${body || '(nothing)'}\n${chatAck(result.agents)}`
      : (result.reply || 'Nothing to do.');
    const posted = await postMessage(token, channel, ack);
    if ('error' in posted) return;
    for (const sid of result.sessions) this.autos.rebindSlackThread(sid, channel, posted.ts);
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
    const token = this.os.settings.slackBotToken();
    let res = await postMessage(token, row.channel, body, row.thread_ts || undefined);
    // Parity with sendToChannel: a public channel the bot isn't in returns `not_in_channel`; join once
    // and retry (a private channel's join fails, then explainSlackError guides the agent to get invited).
    if ('error' in res && res.error.startsWith('not_in_channel')) {
      await joinChannel(token, row.channel);
      res = await postMessage(token, row.channel, body, row.thread_ts || undefined);
    }
    if ('error' in res) {
      this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'slack', type: 'slack.reply.failed', data: { channel: row.channel, error: res.error } });
      return { ok: false, error: explainSlackError(res.error, row.channel) };
    }
    // Remember the thread we just spoke in. When the run had no thread of its own (`thread_ts` blank)
    // this post STARTS one, and the reply a human writes under it must find its way back to this run —
    // the case `slack_threads` (one row per session) structurally cannot record.
    this.autos.noteSlackThread(sessionId, row.channel, row.thread_ts || res.ts);
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
    // A proactive post opens a NEW thread. Bind it so a human replying under the daily report is talking
    // to the agent that wrote it, instead of being dropped as unaddressed channel chatter.
    this.autos.noteSlackThread(sessionId, channel, res.ts);
    this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'slack', type: 'slack.send', data: { channel, ts: res.ts, chars: body.length } });
    return { ok: true };
  }

  private sendFailed(sessionId: string, channel: string, error: string): { ok: false; error: string } {
    this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'slack', type: 'slack.send.failed', data: { channel, error } });
    return { ok: false, error: explainSlackError(error, channel) };
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

  /**
   * Resolve a team member's Slack user id from their email (`users.lookupByEmail`) — the discovery half
   * of the identity-map auto-link. Both hits and misses are cached in-process, so an unlinked-and-absent
   * member is queried at most once per process, not on every notification. Returns null when Slack isn't
   * configured or the address isn't in the workspace. Best-effort; never throws.
   */
  async userIdForEmail(email: string): Promise<string | null> {
    const key = (email || '').trim().toLowerCase();
    if (!key) return null;
    const token = this.os.settings.slackBotToken();
    if (!token) return null;
    const cached = this.userByEmailCache.get(key);
    if (cached !== undefined) return cached;
    const found = await lookupUserByEmail(token, key);
    const uid = 'error' in found ? null : found.user;
    this.userByEmailCache.set(key, uid);
    return uid;
  }
}
