/**
 * Per-session working mode — `draft` and `readonly`, set by a person on a running session.
 *
 * Mining 30 days of fleet chats (2026-10-26) found the same two instructions typed into 40+ sessions:
 * "do not post anything, give me the comment and I'll post it" and "investigate only, do not edit
 * anything". Typed as prose, they bind only as far as the model remembers them across a long session; the
 * product already mediates every effect, so the instruction belongs at the gate.
 *
 *   - `draft`    — nothing goes OUT under anyone's name: no email, chat post or DM to a third party, no
 *                  ticket/PR/issue comment, no PR or issue created, no `git push`, no write call to an
 *                  external API. Replying in the conversation the person is having with the agent (a
 *                  `*_reply` tool) is not "out" — it is how the agent talks to them.
 *   - `readonly` — `draft`, plus no file edits outside the temp dir and no local state change by shell
 *                  (commits, resets, deletes, package installs, service restarts, SQL writes).
 *
 * Engine-level and combined with `stricterDecision`, like the file and host guards, so it holds on every
 * tenant whatever its persisted policy. Best-effort by nature for the shell — an agent determined to write
 * through a script can — but it covers the channels agents actually use, and every denial tells the agent
 * what to do instead.
 */
import os from 'node:os';
import path from 'node:path';
import type { Decision } from '../types';

export type SessionMode = 'normal' | 'draft' | 'readonly';
export const SESSION_MODES: SessionMode[] = ['normal', 'draft', 'readonly'];

export function isSessionMode(v: unknown): v is SessionMode {
  return typeof v === 'string' && (SESSION_MODES as string[]).includes(v);
}

const ALLOW: Decision = { effect: 'allow', riskClass: 'green', reason: 'no session-mode restriction' };

/** Canonical capabilities that are an outward effect by definition. */
const OUTWARD_CAPS = /^(email\.send|messaging\.post|repo\.pr\.create|repo\.issue\.create|payments\..+)$/;

/** Agentric's own tools that speak to someone OTHER than the person in this conversation. The `*_reply`
 *  tools answer the thread the person is talking in, so they stay allowed. */
const AGENTOS_OUTWARD = /^mcp__agentos__(slack_send|slack_dm|discord_send|discord_dm|email_send|send_email)$/;

/** A connector action that writes somewhere outside: Composio slugs (`CLICKUP_CREATE_TASK_COMMENT`,
 *  `GMAIL_REPLY_TO_THREAD`), first-class MCP tools (`create_pull_request`). Read verbs never match. */
const OUTWARD_TOOL = /(^|[_\W])(create|send|post|reply|comment|update|edit|delete|remove|publish|merge|upload|invite|assign|close|archive|move|add|patch|put|set|submit|approve|transfer|refund|charge|pay)([_\W]|$)/i;

/** Shell commands that put something out under a name. */
const OUTWARD_SHELL: RegExp[] = [
  /\bgit\s+push\b/,
  /\bgh\s+(pr|issue)\s+(create|comment|merge|review|close|edit|reopen|ready|lock)\b/,
  /\bgh\s+(release|gist|repo)\s+(create|edit|delete|upload)\b/,
  /\bgh\s+api\b[^|;&]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s--method\s+(POST|PUT|PATCH|DELETE)|\s-[fF]\s|\s--(raw-)?field\s)/i,
  /\bcurl\b[^|;&]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s--request\s+(POST|PUT|PATCH|DELETE)|\s(-d|--data[\w-]*|-F|--form|--json)\b)/i,
  /\b(npm|pnpm|yarn)\s+publish\b/,
  /\b(sendmail|mailx?)\b\s/,
];

/** Shell commands that change local state (read-only mode). */
const WRITE_SHELL: RegExp[] = [
  /\bgit\s+(commit|merge|rebase|reset|cherry-pick|revert|am|apply|stash|tag|clean)\b/,
  /\bgit\s+branch\s+-[dDmM]\b/,
  /(^|[;&|]\s*|\s)(rm|mv|rmdir|truncate|shred|chmod|chown|ln)\s/,
  /\bsed\s+(-[a-zA-Z]*i|--in-place)/,
  /\b(npm|pnpm|yarn|pip3?|brew|apt(-get)?|gem|cargo|go)\s+(install|add|remove|uninstall|upgrade|update|i)\b/,
  /\b(docker|podman)\s+(run|rm|rmi|stop|kill|build|compose|exec)\b/,
  /\bkubectl\s+(apply|delete|patch|edit|scale|rollout|create)\b/,
  /\b(systemctl|launchctl|service)\s+(start|stop|restart|reload|enable|disable|kickstart|load|unload)\b/,
  /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|DATABASE)|ALTER\s+TABLE|TRUNCATE\s+TABLE|CREATE\s+TABLE)\b/i,
  /\bwp\s+(plugin|theme|core|option|post|user|db|search-replace)\s+(install|activate|deactivate|delete|update|set|create|import|reset|search-replace)\b/,
];

/** A shell redirect into a real file (not /dev/null, not the temp dir). */
const REDIRECT = />>?\s*(['"]?)([^\s'";&|]+)\1/g;

const TEMP_ROOTS = [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].map((p) => path.resolve(p));
const inTemp = (p: string) => TEMP_ROOTS.some((r) => path.resolve(p) === r || path.resolve(p).startsWith(r + path.sep));

function deny(reason: string): Decision {
  return { effect: 'deny', riskClass: 'deny', reason };
}

const DRAFT_HINT = 'this session is DRAFT-ONLY — nothing goes out under anyone\'s name. Write the text here (the message, comment, PR description, email) for the person to send themselves, or ask them to switch the session back to normal.';
const READONLY_HINT = 'this session is READ-ONLY — investigate and report, change nothing. Describe the change you would make instead, or ask the person to switch the session back to normal.';

/**
 * The mode's verdict on one gated action. `capability` is the post-normalization id the gate classifies;
 * `toolName` the raw connector tool (`args.tool`); `command` the shell command text.
 */
export function sessionModeDecision(mode: SessionMode | undefined, capability: string, toolName: string | undefined, command: string, writeTargets: string[] = []): Decision {
  if (!mode || mode === 'normal') return ALLOW;
  const hint = mode === 'readonly' ? READONLY_HINT : DRAFT_HINT;

  // ── outward: blocked in both modes ──
  if (OUTWARD_CAPS.test(capability)) return deny(`${capability} blocked: ${hint}`);
  if (toolName) {
    if (toolName.startsWith('mcp__agentos__')) {
      if (AGENTOS_OUTWARD.test(toolName)) return deny(`${toolName.replace('mcp__agentos__', '')} blocked: ${hint}`);
    } else if ((capability === 'connector.call' || capability.startsWith('connector')) && OUTWARD_TOOL.test(toolName.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, ''))) {
      return deny(`${toolName} blocked: ${hint}`);
    }
  }
  if (command && OUTWARD_SHELL.some((re) => re.test(command))) return deny(`this command sends something out: ${hint}`);

  if (mode !== 'readonly') return ALLOW;

  // ── local changes: blocked in read-only ──
  if (capability === 'file.write') {
    if (writeTargets.length && writeTargets.every(inTemp)) return ALLOW;
    return deny(`file edit blocked: ${hint}`);
  }
  if (command) {
    if (WRITE_SHELL.some((re) => re.test(command))) return deny(`this command changes local state: ${hint}`);
    for (const m of command.matchAll(REDIRECT)) {
      const target = m[2];
      if (target === '/dev/null' || target.startsWith('&') || /^\d$/.test(target)) continue;
      if (!inTemp(target)) return deny(`writing to ${target} blocked: ${hint}`);
    }
  }
  return ALLOW;
}

/** What the agent is told when a person changes the mode mid-session (typed into its pane). */
export function sessionModeNotice(mode: SessionMode, who: string): string {
  if (mode === 'draft') {
    return `[Agentric] ${who} set this session to DRAFT-ONLY. From now on nothing goes out under anyone's name: no emails, chat posts, DMs, ticket or PR comments, new PRs/issues, or git push. Write the text here for them to send. Everything else works as before.`;
  }
  if (mode === 'readonly') {
    return `[Agentric] ${who} set this session to READ-ONLY. Investigate and report only: no file edits, commits, pushes, posts, sends or other changes. Describe any change you'd make instead of making it.`;
  }
  return `[Agentric] ${who} set this session back to NORMAL — the draft-only/read-only restriction is lifted.`;
}
