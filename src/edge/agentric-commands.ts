/**
 * `/agentric` helper commands — a small, CLOSED verb set for working the Tasks board from chat and from a
 * ClickUp comment without starting an agent. Everything here is answered deterministically by the server:
 * no LLM, no run, no quota. A free-text request ("/agentric support-ops fix X") is NOT a command and falls
 * through to the ordinary routing untouched.
 *
 * The grammar is deliberately strict, because a looser one eats ordinary messages: on ClickUp,
 * `/agentric done testing, looks good` is a COMMENT for the ticket's task, not a request to close it. So a
 * status verb only counts when it is the WHOLE message (optionally followed by a task id), and every other
 * verb is anchored on a second keyword (`task new …`) or a task id (`task tsk_… …`).
 *
 *   chat (Slack · Discord · Telegram)          ClickUp comment (the ticket already IS a task)
 *   ─────────────────────────────────          ───────────────────────────────────────────────
 *   help                                        help
 *   tasks [open|done|all]                       —
 *   task new <title> [@agent]                   —
 *   task <id> <text>                            — (`/agentric <text>` already does this)
 *   done|reopen|status <id>                     done|reopen|status [<id>]  (default: the ticket's task)
 *
 * Verbs win over agent names: an agent literally called `help`, `task`, `tasks`, `done`, `reopen` or
 * `status` can't be addressed as `/agentric <name> …` — address it as `/<name> …` instead.
 */

export type AgentricSurface = 'slack' | 'discord' | 'telegram' | 'clickup';

export type AgentricCommand =
  | { verb: 'help' }
  | { verb: 'tasks'; scope: 'open' | 'done' | 'all' }
  | { verb: 'new'; title: string; agent?: string }
  | { verb: 'say'; id: string; text: string }
  | { verb: 'done' | 'reopen' | 'status'; id?: string }
  /** A chat-only verb used on ClickUp — answered with a pointer, never silently treated as a comment. */
  | { verb: 'unsupported'; what: string };

/** The text after a leading `/agentric` (Telegram's `/agentric@BotName` form included), or null when the
 *  message doesn't start with it. `''` for a bare `/agentric`. */
export function agentricBody(text: string): string | null {
  const m = (text || '').match(/^\s*\/agentric(?:@[\w]+)?(?=\s|$)\s*([\s\S]*)$/i);
  return m ? m[1].trim() : null;
}

const TASK_ID = /^#?(tsk_[a-z0-9]+)$/i;

/** Parse the body of an `/agentric …` message. null = not a helper command (route it as before). */
export function parseAgentricCommand(body: string, surface: AgentricSurface): AgentricCommand | null {
  const text = (body || '').trim();
  if (!text) return null;
  const words = text.split(/\s+/);
  const verb = words[0].toLowerCase();
  const clickup = surface === 'clickup';

  if ((verb === 'help' || verb === '?') && words.length === 1) return { verb: 'help' };

  if (verb === 'tasks' && words.length <= 2) {
    const scope = (words[1] || 'open').toLowerCase();
    if (scope !== 'open' && scope !== 'done' && scope !== 'all') return null;
    return clickup ? { verb: 'unsupported', what: 'tasks' } : { verb: 'tasks', scope };
  }

  // done|reopen|status [<id>] — the WHOLE message, so a sentence that merely starts with "done" stays text.
  const statusVerb = (v: string): v is 'done' | 'reopen' | 'status' => v === 'done' || v === 'reopen' || v === 'status';
  const idAt = (i: number) => (words[i] ? words[i].match(TASK_ID)?.[1] : undefined);
  if (statusVerb(verb)) {
    if (words.length === 1) return { verb };
    if (words.length === 2 && idAt(1)) return { verb, id: idAt(1) };
    return null;
  }

  if (verb === 'task' && words.length >= 2) {
    const sub = words[1].toLowerCase();
    if (sub === 'new') {
      if (clickup) return { verb: 'unsupported', what: 'task new' };
      let rest = text.replace(/^task\s+new\b\s*/i, '');
      let agent: string | undefined;
      const tail = rest.match(/\s*@([A-Za-z0-9][\w-]*)\s*$/);
      if (tail && tail.index! > 0) { agent = tail[1]; rest = rest.slice(0, tail.index).trim(); }
      return { verb: 'new', title: rest.trim(), agent };
    }
    if (statusVerb(sub) && words.length === 3 && idAt(2)) return { verb: sub, id: idAt(2) };
    const id = idAt(1);
    if (id) {
      if (clickup) return { verb: 'unsupported', what: 'task <id>' };
      const said = text.replace(/^task\s+\S+\s*/i, '').trim();
      return said ? { verb: 'say', id, text: said } : { verb: 'status', id };
    }
  }
  return null;
}

/** The help reply. Plain text on purpose — ClickUp renders no markdown, and it reads fine everywhere. */
export function agentricHelp(surface: AgentricSurface): string {
  if (surface === 'clickup') {
    return [
      'Agentric on this ticket:',
      '/agentric <text> — add to this ticket\'s Agentric task (created on first use)',
      '/agentric <agent> <request> — put an agent on it',
      '/agentric status — where the task stands',
      '/agentric done · /agentric reopen — close or reopen it',
      '/<agent> <request> — ask an agent without tracking it as a task',
    ].join('\n');
  }
  return [
    'Agentric commands:',
    '/agentric tasks [open|done|all] — your tasks',
    '/agentric task new <title> [@agent] — create one (naming an agent starts it)',
    '/agentric task <id> <text> — add to a task\'s discussion',
    '/agentric status <id> · done <id> · reopen <id>',
    '/agentric <agent> <request> — ask an agent directly',
  ].join('\n');
}
