// A NON-TECHNICAL view of a claude-code session.
//
// Claude Code writes a structured JSONL transcript per session (one file, named by the pinned
// `--session-id`, under `$CLAUDE_CONFIG_DIR/projects/<escaped-cwd>/<id>.jsonl`). agent-os already
// pins that id (`term_sessions.claude_session_id`), so we can locate the file by NAME alone —
// regardless of which agent workspace (cwd) the run used.
//
// This module turns that raw transcript (thinking blocks, tool_use JSON, tool_result payloads) into
// a clean chat timeline a support/sales/marketing user can read: plain message bubbles + friendly
// "activity" cards ("Sent a Slack message", "Read a file") instead of tool JSON. It is READ-ONLY and
// has no dependency on how the session is driven — the native chat UI and the ttyd terminal are two
// windows onto the same underlying run.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** One entry in the human-readable timeline. */
export type ChatTurn =
  | { kind: 'user'; text: string; ts: number }
  | { kind: 'assistant'; text: string; ts: number }
  | {
      kind: 'activity';
      tool: string;
      /** friendly one-liner, e.g. "Sent a Slack message" */
      label: string;
      /** short human hint (a filename, a URL host, a query) — the UI may hide this behind a toggle */
      detail?: string;
      status: 'running' | 'ok' | 'error';
      ts: number;
    };

export interface Conversation {
  turns: ChatTurn[];
  /** true once we found and parsed a transcript file (false = the run hasn't written one yet) */
  found: boolean;
}

const claudeConfigDir = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** Locate `<claudeSessionId>.jsonl` under any project dir. Filename is unique, so cwd escaping is irrelevant. */
export function findTranscript(claudeSessionId: string): string | undefined {
  const projects = path.join(claudeConfigDir(), 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return undefined;
  }
  const wanted = `${claudeSessionId}.jsonl`;
  for (const d of dirs) {
    const candidate = path.join(projects, d, wanted);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** "slack_send" / "getFileContent" → "Slack send" / "Get file content" — last-resort humanizer. */
function humanize(raw: string): string {
  const words = raw
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const basename = (p: unknown): string | undefined =>
  typeof p === 'string' && p ? p.split('/').pop() || p : undefined;

const host = (u: unknown): string | undefined => {
  if (typeof u !== 'string') return undefined;
  try {
    return new URL(u).host;
  } catch {
    return u.slice(0, 60);
  }
};

const clip = (s: unknown, n = 80): string | undefined =>
  typeof s === 'string' && s ? (s.length > n ? s.slice(0, n) + '…' : s) : undefined;

/** Map a tool_use block to a friendly label + short detail, tuned for a non-technical reader. */
function friendlyTool(name: string, input: Record<string, unknown>): { label: string; detail?: string } {
  switch (name) {
    case 'Bash':
      return { label: 'Ran a command', detail: clip(input.command) };
    case 'Read':
      return { label: 'Read a file', detail: basename(input.file_path) };
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return { label: 'Updated a file', detail: basename(input.file_path) };
    case 'Grep':
    case 'Glob':
      return { label: 'Searched the files', detail: clip(input.pattern) };
    case 'WebFetch':
      return { label: 'Read a web page', detail: host(input.url) };
    case 'WebSearch':
      return { label: 'Searched the web', detail: clip(input.query) };
    case 'Task':
    case 'Agent':
      return { label: 'Asked a helper to dig in', detail: clip(input.description) };
    case 'ToolSearch':
      return { label: 'Looked up the tools it needs' };
    case 'TodoWrite':
      return { label: 'Updated its plan' };
  }
  // agent-os MCP tools arrive as mcp__<server>__<tool>.
  const mcp = name.match(/^mcp__[^_]*(?:_[^_]+)*__(.+)$/) || name.match(/^mcp__.+?__(.+)$/);
  const bare = mcp ? mcp[1] : name;
  if (/^slack_/.test(bare)) return { label: 'Sent a Slack message', detail: clip(input.text ?? input.message ?? input.channel) };
  if (/^discord_/.test(bare)) return { label: 'Sent a Discord message', detail: clip(input.content ?? input.message) };
  if (/^(remember|recall|revise|forget)$/.test(bare)) return { label: 'Used its memory' };
  if (/^kb_/.test(bare)) return { label: 'Used the knowledge base', detail: clip(input.query ?? input.slug ?? input.title) };
  if (/^task_/.test(bare)) return { label: 'Updated the task board', detail: clip(input.title) };
  if (/^(report|update|notify|publish)$/.test(bare)) return { label: 'Posted an update' };
  if (bare === 'ask') return { label: 'Asked a question', detail: clip(input.question) };
  if (/^secret_/.test(bare)) return { label: 'Used a stored credential', detail: clip(input.key) };
  if (bare === 'directory_lookup') return { label: 'Looked someone up' };
  return { label: humanize(bare), detail: clip((input as any).query ?? (input as any).title) };
}

/** Parse a claude transcript line's `message.content` into ordered turns; merge tool results by id. */
export function readConversation(claudeSessionId: string): Conversation {
  const file = findTranscript(claudeSessionId);
  if (!file) return { turns: [], found: false };

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { turns: [], found: false };
  }

  const turns: ChatTurn[] = [];
  // tool_use_id → index in `turns`, so the tool_result on the NEXT user message resolves the card.
  const activityById = new Map<string, number>();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'assistant' && o.type !== 'user') continue;
    const ts = Date.parse(o.timestamp) || 0;
    const content = o.message?.content;

    if (typeof content === 'string') {
      const text = content.trim();
      if (text) turns.push({ kind: o.type === 'user' ? 'user' : 'assistant', text, ts });
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') {
        const text = String(b.text || '').trim();
        if (text) turns.push({ kind: o.type === 'user' ? 'user' : 'assistant', text, ts });
      } else if (b.type === 'tool_use') {
        const { label, detail } = friendlyTool(String(b.name || ''), (b.input || {}) as Record<string, unknown>);
        activityById.set(String(b.id), turns.length);
        turns.push({ kind: 'activity', tool: String(b.name || ''), label, detail, status: 'running', ts });
      } else if (b.type === 'tool_result') {
        const idx = activityById.get(String(b.tool_use_id));
        if (idx != null) {
          const card = turns[idx];
          if (card && card.kind === 'activity') card.status = b.is_error ? 'error' : 'ok';
        }
      }
      // thinking blocks are deliberately dropped — noise for a non-technical reader.
    }
  }

  return { turns, found: true };
}
