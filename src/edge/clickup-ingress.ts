/**
 * Native ClickUp ingress — the webhook-source twin of `slack-socket.ts` / `discord-socket.ts`.
 *
 * ClickUp has no outbound socket: a ClickUp **Automation** ("comment added" → POST
 * `/hooks/clickup?key=…&task_id=…`) drives it. So instead of a persistent connection this is a small
 * dispatcher the server route calls per inbound POST. The Automation payload carries no comment text,
 * so we fetch the latest comment via the API, then run the SAME routing the chat sources use:
 *   - **continuity first** — a follow-up on a task already bound to a session resumes THAT conversation
 *     (`continueClickupThread`), keyed on the task id;
 *   - else **route `/agentname`** (`fireClickup` → the shared `/agent` front door), so `/ceoagent <req>`
 *     reaches any agent with no per-agent automation — the direct replacement for the agent-orch
 *     `/ceoagent` ClickUp command;
 *   - **loop-guard**: comments authored by our own API-token user (the bot's acks/replies) are skipped,
 *     and a comment that isn't a `/command` (and doesn't continue a bound task) is ignored — so posting
 *     a reply doesn't re-trigger us.
 *
 * run-as: the commenter's email → an Agent OS member (per-member tools + inbox), else the company
 * identity — exactly like Slack's user→email→member mapping. Reply egress (`clickup_reply`) posts the
 * agent's answer back as a comment on the SAME task, read from the `clickup_threads` binding so the
 * agent never has to supply (or is able to spoof) a task id.
 */
import type { AgentOS } from '../kernel';
import type { Automations } from './automations';
import { addComment, authedUser, fetchLatestComment, taskUrl } from '../connectors/clickup';

export class ClickupIngress {
  /** The ClickUp user id our API token posts as — cached so we can skip our own comments (loop-guard). */
  private botUserId?: string;

  constructor(
    private readonly os: AgentOS,
    private readonly autos: Automations,
  ) {}

  /** Token present — the minimum to read comments + reply. */
  configured(): boolean {
    return this.os.settings.clickupConfigured();
  }

  /** Resolve (and cache) the API token's own ClickUp user id, for the self-comment loop-guard. */
  private async selfUserId(token: string): Promise<string> {
    if (this.botUserId !== undefined) return this.botUserId;
    const who = await authedUser(token);
    this.botUserId = 'id' in who ? who.id : '';
    return this.botUserId;
  }

  /**
   * Handle one inbound ClickUp Automation webhook for `taskId`: fetch the latest comment, drop our own
   * (loop-guard), resolve run-as, continue-or-route, and post an ack. Returns a small status for the
   * HTTP response body. Never throws (a bad token / API blip degrades to an ignored event).
   */
  async dispatch(taskId: string, raw: unknown): Promise<{ ok: boolean; status: string; sessions?: string[] }> {
    const token = this.os.settings.clickupToken();
    if (!token) return { ok: false, status: 'clickup not configured' };
    if (!taskId) return { ok: false, status: 'missing task_id' };

    const comment = await fetchLatestComment(token, taskId);
    if (!comment) return { ok: true, status: 'no comment' };

    // Loop-guard: ignore comments our own bot user posted (its acks/replies), or we'd re-trigger forever.
    const self = await this.selfUserId(token);
    if (self && comment.userId && comment.userId === self) return { ok: true, status: 'own comment' };

    const text = comment.text || '';
    // ⚠ EVERY comment on a covered task fires this webhook, and a ClickUp task's comment section is a
    // SHARED space (not a dedicated bot thread like a Slack thread). So ONLY a comment addressed to an
    // agent (`/agentname …`) acts — a plain comment is ignored, never delivered into a bound session.
    // This matches the old agent-orch behaviour (a `/command` each turn); the loop-guard above already
    // drops our own bot comments. Gate FIRST, before continuity.
    if (!/^\s*\/[A-Za-z0-9]/.test(text)) return { ok: true, status: 'not a command' };

    const member = comment.userEmail ? this.os.team.getMemberByEmail(comment.userEmail) : undefined;
    const runAs = member?.id;
    const actorLabel = member?.name || comment.userEmail || 'a ClickUp user';

    // 1) Continuity: a follow-up `/command` on a task already bound to a live/resumable session resumes it.
    const cont = this.autos.continueClickupThread({ taskId, actorLabel, text, raw }, runAs);
    if (cont.status !== 'none') {
      return { ok: true, status: cont.status, sessions: cont.sessionId ? [cont.sessionId] : [] };
    }

    // 2) Fresh: route the `/agentname` to the shared chat front door.
    const r = await this.autos.fireClickup(
      { taskId, commentId: comment.id, text, taskUrl: taskUrl(taskId), actorLabel, raw },
      runAs,
    );
    // Ack in-thread: a routing/disambiguation reply, or an "on it" when a session started.
    if (r.reply) {
      await addComment(token, taskId, r.reply);
    } else if (r.sessions.length) {
      await addComment(token, taskId, `🤖 On it — ${r.sessions.length === 1 ? 'an agent is' : 'agents are'} working on this; I'll post the result here.`);
    }
    return { ok: true, status: r.sessions.length ? 'dispatched' : 'ignored', sessions: r.sessions };
  }

  /**
   * Native egress: post the agent's reply back as a comment on the session's bound task. Reads the
   * `clickup_threads` binding written at spawn — the agent supplies only text, never a task id. No-op
   * (returns an error) when the session has no bound task, so a non-ClickUp run mirrors nowhere.
   */
  async reply(sessionId: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const row = this.os.db
      .prepare('SELECT task_id FROM clickup_threads WHERE session_id = ?')
      .get<{ task_id: string }>(sessionId);
    if (!row) return { ok: false, error: 'no ClickUp task bound to this session' };
    const body = (text || '').trim();
    if (!body) return { ok: false, error: 'empty reply' };
    const token = this.os.settings.clickupToken();
    if (!token) return { ok: false, error: 'ClickUp not configured' };
    const res = await addComment(token, row.task_id, body);
    if ('ok' in res) {
      this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'clickup', type: 'clickup.reply', data: { task: row.task_id, chars: body.length } });
      return { ok: true };
    }
    this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'clickup', type: 'clickup.reply.failed', data: { task: row.task_id, error: res.error } });
    return { ok: false, error: res.error };
  }
}
