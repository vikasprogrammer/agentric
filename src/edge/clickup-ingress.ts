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
 * run-as: the commenter's email → an Agentric member (per-member tools + inbox), else the company
 * identity — exactly like Slack's user→email→member mapping. Reply egress (`clickup_reply`) posts the
 * agent's answer back as a comment on the SAME task, read from the `clickup_threads` binding so the
 * agent never has to supply (or is able to spoof) a task id.
 */
import type { AgentOS } from '../kernel';
import type { Automations } from './automations';
import { chatAck } from './automations';
import { ClickupFileRef, addComment, addReaction, downloadClickupFile, fetchLatestComment, taskUrl } from '../connectors/clickup';

/** Attachments per comment we'll fetch. A pasted screenshot is one file; a dumped folder is not a comment. */
const MAX_FILES = 5;
/** Per-file ceiling — a screenshot, a PDF or a log, but not a video. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export class ClickupIngress {
  /**
   * Comment ids we've already acted on OR posted ourselves — the loop-guard. We do NOT guard by the
   * token's user id: the API token is often a PERSONAL token, so the human who runs `/agentname` IS the
   * token user (guarding by user id would silently skip their own commands — a real bug we hit). Guarding
   * by comment id instead is personal-token-safe: our acks/replies are skipped because WE posted them, and
   * a racing duplicate webhook for the same command is skipped because we already handled it. Bounded.
   */
  private readonly handled = new Set<string>();

  constructor(
    private readonly os: AgentOS,
    private readonly autos: Automations,
  ) {}

  /** Token present — the minimum to read comments + reply. */
  configured(): boolean {
    return this.os.settings.clickupConfigured();
  }

  /** Record a comment id as handled (our own post, or a command we acted on) so a re-fetch skips it. */
  private remember(id?: string): void {
    if (!id) return;
    this.handled.add(id);
    if (this.handled.size > 500) for (const k of this.handled) { this.handled.delete(k); if (this.handled.size <= 300) break; }
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

    // Loop-guard: skip a comment we already acted on or posted ourselves (see `handled`). Personal-token-safe.
    if (comment.id && this.handled.has(comment.id)) return { ok: true, status: 'already handled' };

    const text = comment.text || '';
    // ⚠ EVERY comment on a covered task fires this webhook, and a ClickUp task's comment section is a
    // SHARED space (not a dedicated bot thread like a Slack thread). So ONLY a comment addressed to an
    // agent (`/agentname …`) acts — a plain comment is ignored, never delivered into a bound session.
    // This matches the old agent-orch behaviour (a `/command` each turn), and also drops our own acks/
    // replies (they don't start with `/agentname`). Gate FIRST, before continuity.
    if (!/^\s*\/[A-Za-z0-9]/.test(text)) return { ok: true, status: 'not a command' };

    // Mark this command comment handled BEFORE dispatching, so a racing second webhook for the same
    // comment (ClickUp fetches "latest", which may still be this one) doesn't double-spawn.
    this.remember(comment.id);

    // 👀 "read / processing" signal — react to the triggering comment so the caller knows we picked it up
    // (lighter + less noisy than an "on it" comment). Best-effort; the eventual reply is the real answer.
    void addReaction(token, comment.id, 'eyes');

    // Attachments. `comment_text` is flattened text, so a screenshot dropped on the task leaves no trace
    // in it — the files live only in the structured blocks, behind an EXPIRING presigned URL. Fetch the
    // bytes now, before routing, so the same buffers serve whichever path claims the comment.
    const files = await this.fetchFiles(comment.files);

    const member = comment.userEmail ? this.os.team.getMemberByEmail(comment.userEmail) : undefined;
    const runAs = member?.id;
    const actorLabel = member?.name || comment.userEmail || 'a ClickUp user';

    // 1) Continuity: a follow-up `/command` on a task already bound to a live/resumable session resumes it.
    const cont = this.autos.continueClickupThread({ taskId, actorLabel, text, raw, files }, runAs);
    if (cont.status !== 'none') {
      return { ok: true, status: cont.status, sessions: cont.sessionId ? [cont.sessionId] : [] };
    }

    // 2) Fresh: route the `/agentname` to the shared chat front door.
    const r = await this.autos.fireClickup(
      { taskId, commentId: comment.id, text, taskUrl: taskUrl(taskId), actorLabel, raw, files },
      runAs,
    );
    for (const sid of r.sessions) this.autos.stageInboundFiles(sid, files);
    // A routing/disambiguation reply (help list / "which agent?") carries TEXT, so it's a comment — and
    // we remember its id to skip the webhook it triggers. A dispatch the commenter STEERED posts no
    // "on it" comment: they typed `/support-ops`, so the 👀 reaction above says enough and a second
    // comment is noise on a shared task. But when the ROUTER picked the agent — an auto-route, or a
    // resolved disambiguation — the commenter has no way to know who took it, so we name them.
    if (r.reply) {
      const a = await addComment(token, taskId, r.reply);
      if ('ok' in a) this.remember(a.id);
    } else if (r.agents.length && !this.commenterNamed(text, r.agents)) {
      const a = await addComment(token, taskId, chatAck(r.agents, ''));
      if ('ok' in a) this.remember(a.id);
    }
    return { ok: true, status: r.sessions.length ? 'dispatched' : 'ignored', sessions: r.sessions };
  }

  /** Did the comment itself name every agent that ran? `/support-ops …` did; an auto-route did not. */
  private commenterNamed(text: string, agents: string[]): boolean {
    const head = (text || '').trim().replace(/^\/agent-?os\s+\/?/i, '/').match(/^\/([A-Za-z0-9][\w-]*)/);
    return !!head && agents.every((a) => a === head[1]);
  }

  /** Fetch a comment's attachments as bytes. A failed download is audited and skipped rather than failing
   *  the whole comment — the text is usually still actionable. */
  private async fetchFiles(refs: ClickupFileRef[]): Promise<{ name: string; data: Buffer }[]> {
    if (!refs?.length) return [];
    const out: { name: string; data: Buffer }[] = [];
    for (const f of refs.slice(0, MAX_FILES)) {
      if (f.size && f.size > MAX_FILE_BYTES) {
        this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'clickup', type: 'clickup.file.skipped', data: { name: f.name, size: f.size, reason: 'too large' } });
        continue;
      }
      const got = await downloadClickupFile(f.url, MAX_FILE_BYTES);
      if ('error' in got) {
        this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'clickup', type: 'clickup.file.failed', data: { name: f.name, error: got.error } });
        continue;
      }
      out.push({ name: f.name, data: got.data });
      this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'clickup', type: 'clickup.file.received', data: { name: f.name, bytes: got.data.length, mime: f.mimetype } });
    }
    return out;
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
      this.remember(res.id); // skip the webhook our own reply triggers (loop-guard)
      this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'clickup', type: 'clickup.reply', data: { task: row.task_id, chars: body.length } });
      return { ok: true };
    }
    this.os.audit.append({ ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal: 'clickup', type: 'clickup.reply.failed', data: { task: row.task_id, error: res.error } });
    return { ok: false, error: res.error };
  }
}
