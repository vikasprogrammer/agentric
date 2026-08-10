/**
 * Native ClickUp — a thin, zero-dependency client for the slice of ClickUp's API the OS needs to run a
 * company ClickUp integration: fetch the latest comment on a task (ClickUp's Automation webhook carries
 * no comment text) and post a comment back (the agent's reply).
 *
 * Unlike Slack/Discord (an outbound Socket/Gateway WebSocket), ClickUp ingress is a **webhook** —
 * a ClickUp Automation POSTs to `/hooks/clickup?key=…&task_id=…` when a comment is added. So there is
 * no connection to dial and nothing to "restart": the company just points a ClickUp Automation at our
 * hook URL once (Settings → Integrations shows it).
 *
 * One company API token (a ClickUp personal/team token, `pk_…`), configured once in Settings →
 * Integrations, is shared across the workspace: it reads comments (ingress enrichment) and posts
 * replies (egress). Each inbound comment names the ClickUp user *with email* — the join key to an
 * Agentric member for run-as, exactly like Slack's user→email→member mapping.
 *
 * Deliberately ClickUp-specific (a connector plugin, not core). All calls use the global `fetch`
 * (Node 22+) — no runtime dependency, matching the Slack/Composio connectors' stance, and every call
 * returns `{ error }` rather than throwing so a flaky network degrades gracefully.
 */

const CLICKUP_API = 'https://api.clickup.com/api/v2';

/** A ClickUp task comment resolved from the API (the Automation webhook itself carries no text). */
export interface ClickupComment {
  id: string;
  text: string;
  /** The commenter's ClickUp user id ('' if unknown). */
  userId: string;
  /** The commenter's email (lowercased) — the join key for member run-as ('' if unknown). */
  userEmail: string;
}

/** Fetch the most recent comment on a task. ClickUp returns comments newest-first. Never throws. */
export async function fetchLatestComment(token: string, taskId: string): Promise<ClickupComment | null> {
  if (!token || !taskId) return null;
  try {
    const res = await fetch(`${CLICKUP_API}/task/${encodeURIComponent(taskId)}/comment`, {
      headers: { authorization: token, 'content-type': 'application/json' },
    });
    const j: any = await res.json().catch(() => ({}));
    const c = (j?.comments || [])[0];
    if (!c) return null;
    return {
      id: String(c.id || ''),
      text: String(c.comment_text || ''),
      userId: String(c.user?.id || ''),
      userEmail: String(c.user?.email || '').trim().toLowerCase(),
    };
  } catch {
    return null;
  }
}

/** Post a plain-text comment to a task (ClickUp comments don't render markdown). Returns the new
 *  comment's id on success (used by the ingress to skip its own posts — loop-guard). Never throws. */
export async function addComment(token: string, taskId: string, text: string): Promise<{ ok: true; id: string } | { error: string }> {
  if (!token) return { error: 'no ClickUp API token' };
  if (!taskId) return { error: 'no task id' };
  try {
    const res = await fetch(`${CLICKUP_API}/task/${encodeURIComponent(taskId)}/comment`, {
      method: 'POST',
      headers: { authorization: token, 'content-type': 'application/json' },
      body: JSON.stringify({ comment_text: text, notify_all: false }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (res.ok && (j?.id || j?.comment)) return { ok: true, id: String(j.id || j.comment?.id || '') };
    return { error: String(j?.err || j?.error || `comment POST failed (${res.status})`) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'comment POST failed' };
  }
}

/** Add an emoji reaction to a comment (ClickUp wants the emoji SHORTCODE, e.g. `eyes` for 👀 — NOT the
 *  unicode char). Used to mark a triggering comment as "read / processing". Never throws. */
export async function addReaction(token: string, commentId: string, reaction = 'eyes'): Promise<{ ok: true } | { error: string }> {
  if (!token || !commentId) return { error: 'missing token or comment id' };
  try {
    const res = await fetch(`${CLICKUP_API}/comment/${encodeURIComponent(commentId)}/reaction`, {
      method: 'POST',
      headers: { authorization: token, 'content-type': 'application/json' },
      body: JSON.stringify({ reactions: [reaction] }),
    });
    const j: any = await res.json().catch(() => ({}));
    // `{ added: [...] }` on success; an ALREADY-reacted comment returns a benign error we treat as ok.
    if (res.ok || (Array.isArray(j?.added))) return { ok: true };
    return { error: String(j?.err || `reaction POST failed (${res.status})`) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'reaction POST failed' };
  }
}

/** Fetch the authorized user for a token: `{ id, email, name }`, or `{ error }`. Used by Settings →
 *  Integrations "test connection" and by the ingress loop-guard (the bot posts comments as THIS user,
 *  so we skip comments authored by it to avoid re-triggering on our own replies). Never throws. */
export async function authedUser(token: string): Promise<{ id: string; email: string; name: string } | { error: string }> {
  if (!token) return { error: 'no ClickUp API token' };
  try {
    const res = await fetch(`${CLICKUP_API}/user`, { headers: { authorization: token } });
    const j: any = await res.json().catch(() => ({}));
    if (res.ok && j?.user) return {
      id: String(j.user.id || ''),
      email: String(j.user.email || '').trim().toLowerCase(),
      name: String(j.user.username || j.user.email || j.user.id || 'ok'),
    };
    return { error: String(j?.err || `auth failed (${res.status})`) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'auth failed' };
  }
}

/**
 * A normalized inbound ClickUp event: a comment posted on a task (the task id comes from the Automation
 * webhook's `task_id` query param; the comment text + commenter are fetched via {@link fetchLatestComment}).
 * The task id is the thread key; the comment text drives `/agentname` routing.
 */
export interface ClickupCommentEvent {
  taskId: string;
  commentId: string;
  text: string;
  /** Commenter user id + email (email is the run-as join key). */
  userId: string;
  userEmail: string;
  /** Best-effort task url for context/deep-links. */
  taskUrl: string;
  /** The raw webhook payload (capped when injected into a task template). */
  raw: any;
}

/** Build the canonical task URL from a task id (for context + deep-links). */
export function taskUrl(taskId: string): string {
  return `https://app.clickup.com/t/${encodeURIComponent(taskId)}`;
}
