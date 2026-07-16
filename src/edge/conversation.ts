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

/** A viewer-safe reference to a Library artifact an activity produced — enough for the chat UI to render
 *  an inline preview card (thumbnail for images, a titled tile + open-in-Library link for everything else).
 *  Resolved by the /conversation route from an activity's {@link ChatTurn} `artifactIds`; carries no
 *  share token. `raw` is the bytes URL (`/api/artifacts/<id>/raw`) for an `<img>`/`<video>`. */
export interface ChatArtifactRef {
  id: string;
  title: string;
  kind: string;
  mime: string;
  filename: string;
  isImage: boolean;
  isVideo: boolean;
  raw: string;
}

/** A viewer-safe reference to a Knowledge Base page an activity wrote (`kb_write`). The chat UI renders a
 *  titled tile deep-linking to `#/kb/<section>/<slug>`. Resolved by the /conversation route from the
 *  activity's `kbRefs`; a page the KB no longer has is dropped. */
export interface ChatKbRef {
  section: string;
  slug: string;
  title: string;
}

/** A viewer-safe reference to a hosted App an activity built or changed (`app_create` / `app_update`). The
 *  chat UI renders a tile deep-linking to `#/apps/<id>` (and, when published, an "open" link to the live
 *  app). Resolved by the /conversation route from the activity's `appIds`; an unknown id is dropped. */
export interface ChatAppRef {
  id: string;
  name: string;
  icon?: string;
  published: boolean;
}

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
      /** Library artifact id(s) this activity produced (publish / image_generate / video_generate / …),
       *  parsed from the tool result. The /conversation route resolves these to rich {@link
       *  ChatArtifactRef} cards the chat UI renders inline; unresolvable ids are dropped there. */
      artifactIds?: string[];
      /** KB page(s) this activity wrote (`kb_write`), captured from the tool INPUT (section/slug). */
      kbRefs?: { section: string; slug: string }[];
      /** Hosted app id(s) this activity built or changed (`app_create` / `app_update`), from the INPUT. */
      appIds?: string[];
      /** Resolved, viewer-filtered previews (populated by the /conversation route from {@link
       *  ChatArtifactRef}/{@link ChatKbRef}/{@link ChatAppRef}); absent in the raw transcript parse. */
      artifacts?: ChatArtifactRef[];
      kbPages?: ChatKbRef[];
      apps?: ChatAppRef[];
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

/** Strip the `mcp__<server>__` wrapper off an agent-os MCP tool name (`mcp__aos__publish` → `publish`);
 *  a plain built-in name (`Bash`) passes through unchanged. */
function bareName(name: string): string {
  const mcp = name.match(/^mcp__[^_]*(?:_[^_]+)*__(.+)$/) || name.match(/^mcp__.+?__(.+)$/);
  return mcp ? mcp[1] : name;
}

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
  const bare = bareName(name);
  if (/^slack_/.test(bare)) return { label: 'Sent a Slack message', detail: clip(input.text ?? input.message ?? input.channel) };
  if (/^discord_/.test(bare)) return { label: 'Sent a Discord message', detail: clip(input.content ?? input.message) };
  if (/^(remember|recall|revise|forget)$/.test(bare)) return { label: 'Used its memory' };
  if (bare === 'kb_write') return { label: 'Updated the knowledge base', detail: clip(input.title ?? input.slug) };
  if (/^kb_/.test(bare)) return { label: 'Used the knowledge base', detail: clip(input.query ?? input.slug ?? input.title) };
  if (/^task_/.test(bare)) return { label: 'Updated the task board', detail: clip(input.title) };
  if (bare === 'app_create') return { label: 'Built an app', detail: clip(input.name ?? input.id) };
  if (bare === 'app_update') return { label: 'Updated an app', detail: clip(input.id) };
  // Artifact-producing tools: keep a distinct label so the inline artifact card reads naturally under it.
  if (bare === 'publish') return { label: 'Published to the Library', detail: clip(input.title ?? basename(input.path)) };
  if (bare === 'image_generate') return { label: 'Created an image', detail: clip(input.prompt) };
  if (bare === 'image_edit') return { label: 'Edited an image', detail: clip(input.prompt ?? input.operation) };
  if (bare === 'video_generate') return { label: 'Created a video', detail: clip(input.prompt) };
  if (/^(report|update|notify)$/.test(bare)) return { label: 'Posted an update' };
  if (bare === 'ask') return { label: 'Asked a question', detail: clip(input.question) };
  if (/^secret_/.test(bare)) return { label: 'Used a stored credential', detail: clip(input.key) };
  if (bare === 'directory_lookup') return { label: 'Looked someone up' };
  return { label: humanize(bare), detail: clip((input as any).query ?? (input as any).title) };
}

/** Bare (mcp-stripped) names of tools whose result yields Library artifact id(s) we render inline. */
const ARTIFACT_TOOLS = new Set(['publish', 'image_generate', 'image_edit', 'video_generate']);

/** From a tool_use's bare name + INPUT, derive the KB / app reference(s) that call SUCCEEDS produces — the
 *  keys (section/slug, app id) live in the input, so unlike artifact ids we needn't parse the result text.
 *  Attached to the activity card at tool_use time and cleared if the tool_result comes back an error. */
function refsFromInput(bare: string, input: Record<string, unknown>): { kbRefs?: { section: string; slug: string }[]; appIds?: string[] } {
  if (bare === 'kb_write') {
    const section = typeof input.section === 'string' ? input.section.trim() : '';
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
    if (section && slug) return { kbRefs: [{ section, slug }] };
  }
  if (bare === 'app_create' || bare === 'app_update') {
    const id = typeof input.id === 'string' ? input.id.trim().toLowerCase() : '';
    if (id) return { appIds: [id] };
  }
  return {};
}

/** Flatten a tool_result's `content` (string, or an array of `{type:'text',text}` blocks) to plain text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as any).type === 'text' ? String((b as any).text ?? '') : ''))
      .join('\n');
  }
  return '';
}

/** Pull Library artifact ids out of a tool result. New ids are prefixed (`art_<hex>`); this deliberately
 *  matches only the prefixed form (all publish/generate outputs mint prefixed ids), so we never mistake a
 *  stray hex token for an id. De-duped, order preserved. */
function extractArtifactIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\bart_[0-9a-f]+\b/g)) {
    if (!seen.has(m[0])) { seen.add(m[0]); ids.push(m[0]); }
  }
  return ids;
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
        const rawName = String(b.name || '');
        const input = (b.input || {}) as Record<string, unknown>;
        const { label, detail } = friendlyTool(rawName, input);
        activityById.set(String(b.id), turns.length);
        // KB / app refs come from the INPUT (the section/slug or app id) — attach them optimistically now;
        // a failed tool_result clears them below so a broken write never shows a card.
        const { kbRefs, appIds } = refsFromInput(bareName(rawName), input);
        turns.push({ kind: 'activity', tool: rawName, label, detail, status: 'running', kbRefs, appIds, ts });
      } else if (b.type === 'tool_result') {
        const idx = activityById.get(String(b.tool_use_id));
        if (idx != null) {
          const card = turns[idx];
          if (card && card.kind === 'activity') {
            card.status = b.is_error ? 'error' : 'ok';
            if (b.is_error) {
              // The write failed — drop the optimistic KB/app refs so no card is shown.
              delete card.kbRefs;
              delete card.appIds;
            } else if (ARTIFACT_TOOLS.has(bareName(card.tool))) {
              // Artifact-producing tool that succeeded → capture the Library id(s) it returned, so the
              // route can resolve them into inline preview cards.
              const ids = extractArtifactIds(resultText(b.content));
              if (ids.length) card.artifactIds = ids;
            }
          }
        }
      }
      // thinking blocks are deliberately dropped — noise for a non-technical reader.
    }
  }

  return { turns, found: true };
}
