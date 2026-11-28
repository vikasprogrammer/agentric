// Reading an ANTIGRAVITY (`agy`) session's transcript — the agy half of `conversation.ts` + `session-cost.ts`.
//
// agy writes one JSONL per conversation at
//   ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl
// (the path every hook payload names as `transcriptPath`). One STEP per line, verified against 1.5.18:
//   {"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"…Z","content":"<USER_REQUEST>…"}
//   {"source":"MODEL","type":"PLANNER_RESPONSE","model":"gemini-3.8-flash-medium","input_tokens":2379,
//    "cache_read_tokens":7712,"output_tokens":294,"thinking":"…","tool_calls":[{"name":"edit_file","args":{…}}],"content":"…"}
//   {"source":"MODEL","type":"GENERIC","status":"DONE"|"ERROR", …}   ← one per executed tool call, in order
//   {"source":"SYSTEM","type":"SYSTEM_MESSAGE", …}                    ← harness injections (subagent mail, …)
//
// Usage is PER STEP (like Claude, unlike Codex's running total), so it is summed. `input_tokens` already
// EXCLUDES the cached portion, which is reported separately as `cache_read_tokens`.
//
// Cost: priced only where we know the sticker rate — the Claude models agy can serve. Gemini and
// gpt-oss runs are recorded with their real tokens, turns and engaged time but a cost of 0: these boxes
// run agy on a Google subscription, and inventing a per-token price would be a number that means nothing.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Conversation, ChatTurn } from './conversation';
import { SessionCost } from './session-cost';

interface Step {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  model?: string;
  input_tokens?: number;
  cache_read_tokens?: number;
  output_tokens?: number;
  tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>;
}

const IDLE_GAP_MS = 5 * 60_000;
const CLAUDE_RATES: Array<[RegExp, { input: number; output: number }]> = [
  [/opus/i, { input: 5, output: 25 }],
  [/sonnet/i, { input: 3, output: 15 }],
  [/haiku/i, { input: 1, output: 5 }],
];

/** The transcript for a conversation id, or undefined. The id comes from agy's own SessionStart payload,
 *  but is still constrained to an id shape so a stored value can never walk out of `brain/`. */
export function antigravityTranscriptPath(conversationId: string, home = os.homedir()): string | undefined {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(conversationId)) return undefined;
  const file = path.join(home, '.gemini', 'antigravity-cli', 'brain', conversationId, '.system_generated', 'logs', 'transcript_full.jsonl');
  return fs.existsSync(file) ? file : undefined;
}

function readSteps(file: string): Step[] {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: Step[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Step); } catch { /* a half-written last line is normal on a live run */ }
  }
  return out;
}

const ts = (s: Step): number => { const t = Date.parse(s.created_at ?? ''); return Number.isFinite(t) ? t : 0; };

/** The human's words inside agy's `<USER_REQUEST>` envelope (the rest is harness metadata). */
function userText(content: string): string {
  const m = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content);
  return (m ? m[1] : content).trim();
}

export function readAntigravityCost(file: string): SessionCost | null {
  const steps = readSteps(file);
  if (!steps.length) return null;
  let input = 0, cached = 0, output = 0, costUsd = 0, toolCalls = 0, turns = 0;
  for (const s of steps) {
    if (s.type === 'USER_INPUT' && s.source === 'USER_EXPLICIT') turns++;
    if (s.type !== 'PLANNER_RESPONSE') continue;
    const i = s.input_tokens ?? 0, c = s.cache_read_tokens ?? 0, o = s.output_tokens ?? 0;
    input += i; cached += c; output += o;
    toolCalls += Array.isArray(s.tool_calls) ? s.tool_calls.length : 0;
    const rate = /claude/i.test(s.model ?? '') ? CLAUDE_RATES.find(([re]) => re.test(s.model ?? ''))?.[1] : undefined;
    if (rate) costUsd += (i * rate.input + o * rate.output + c * rate.input * 0.1) / 1_000_000;
  }
  const stamps = steps.map(ts).filter((t) => t > 0).sort((a, b) => a - b);
  let activeMs = 0;
  for (let k = 1; k < stamps.length; k++) {
    const gap = stamps[k] - stamps[k - 1];
    if (gap > 0 && gap < IDLE_GAP_MS) activeMs += gap;
  }
  return { costUsd, inputTokens: input, outputTokens: output, cacheReadTokens: cached, cacheWriteTokens: 0, activeMs, turns, toolCalls };
}

function activityFor(name: string, args: Record<string, unknown>): { label: string; detail?: string } {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const file = (p: string) => (p ? path.basename(p) : undefined);
  switch (name) {
    case 'run_command': return { label: 'Ran a command', detail: str(args.CommandLine).split('\n')[0].slice(0, 120) };
    case 'write_file': return { label: 'Wrote a file', detail: file(str(args.Path)) };
    case 'edit_file': return { label: 'Edited a file', detail: file(str(args.Path)) };
    case 'read_file': return { label: 'Read a file', detail: file(str(args.Path)) };
    case 'search_web': return { label: 'Searched the web', detail: str(args.query).slice(0, 120) };
    case 'invoke_subagent': return { label: 'Started a subagent', detail: str(args.Role).slice(0, 120) || undefined };
    case 'call_mcp_tool': {
      // Hub tools are `<server>__<tool>`; anything else is a box-level MCP server.
      const tool = str(args.ToolName);
      const i = tool.indexOf('__');
      return i > 0 ? { label: `Used ${tool.slice(0, i)}`, detail: tool.slice(i + 2) } : { label: `Used ${str(args.ServerName) || 'a connector'}`, detail: tool };
    }
    default: return { label: name.replace(/_/g, ' ') };
  }
}

/** The friendly timeline — the same `ChatTurn[]` shape as the Claude and Codex readers. Tool results
 *  arrive as GENERIC steps in call order, so each one settles the oldest still-running activity. */
export function readAntigravityConversation(file: string): Conversation {
  const steps = readSteps(file);
  if (!steps.length) return { turns: [], found: false };
  const turns: ChatTurn[] = [];
  const running: number[] = [];
  for (const s of steps) {
    const at = ts(s);
    if (s.type === 'USER_INPUT' && s.source === 'USER_EXPLICIT' && s.content) {
      const text = userText(s.content);
      if (text) turns.push({ kind: 'user', text, ts: at });
    } else if (s.type === 'PLANNER_RESPONSE') {
      if (s.content && s.content.trim()) turns.push({ kind: 'assistant', text: s.content.trim(), ts: at });
      for (const c of Array.isArray(s.tool_calls) ? s.tool_calls : []) {
        const name = String(c?.name ?? 'tool');
        const { label, detail } = activityFor(name, (c?.args && typeof c.args === 'object') ? c.args : {});
        running.push(turns.length);
        turns.push({ kind: 'activity', tool: name, label, detail, status: 'running', ts: at });
      }
    } else if (s.type === 'GENERIC' && s.source === 'MODEL') {
      const idx = running.shift();
      const t = idx === undefined ? undefined : turns[idx];
      if (t && t.kind === 'activity') t.status = s.status === 'ERROR' ? 'error' : 'ok';
    }
  }
  return { turns, found: true };
}
