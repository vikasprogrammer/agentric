// Reading a CODEX session's transcript — the Codex half of `conversation.ts` + `session-cost.ts`.
//
// Codex writes a JSONL "rollout" per session, but nothing else about it matches Claude Code:
//
//   - LOCATION. Claude's transcripts live in a global `~/.claude/projects/<cwd>/<id>.jsonl`, so
//     `findTranscript` can search by filename alone. Codex writes into `$CODEX_HOME/sessions/YYYY/MM/DD/
//     rollout-<ts>-<uuid>.jsonl`, and Agent OS gives every run its OWN `$CODEX_HOME` — so the file is
//     found by walking that one session dir, and the id in the name is the id we captured at launch.
//   - SHAPE. One record per line, `{timestamp, type, payload}`. `type` is `session_meta` |
//     `turn_context` | `event_msg` | `response_item` | `world_state`, and the interesting variants are
//     nested under `payload.type`.
//   - USAGE IS CUMULATIVE. Claude reports per-request usage that we SUM; Codex's `token_count` carries a
//     running `total_token_usage` for the whole session, so we take the LAST one and must NOT add them
//     up (doing so would multiply the bill by the number of turns).
//   - `input_tokens` INCLUDES the cached portion, where Anthropic reports them separately. Uncached
//     input is therefore `input_tokens - cached_input_tokens`, which is what `SessionCost.inputTokens`
//     means and what the input rate is applied to.
//
// Read-only and best-effort: an unreadable/absent rollout yields `null` (cost "not known yet") or an
// empty conversation, exactly like the Claude path.
import * as fs from 'fs';
import * as path from 'path';
import { Conversation, ChatTurn } from './conversation';
import { SessionCost } from './session-cost';

/** One line of a rollout file. */
interface Rec {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

/** Per-model sticker pricing, USD per 1M tokens, for the models Codex actually runs. Cached input is
 *  billed at 0.1× input (OpenAI's cached-input discount). Unknown ids fall back to the GPT-5 tier
 *  rather than 0, so an unrecognised model under-reports nothing. */
const RATES: Array<[RegExp, { input: number; output: number }]> = [
  [/gpt-5.*codex/i, { input: 1.25, output: 10 }],
  [/gpt-5/i, { input: 1.25, output: 10 }],
  [/o[34]/i, { input: 2, output: 8 }],
];
const FALLBACK = { input: 1.25, output: 10 };
const rateFor = (model: string) => RATES.find(([re]) => re.test(model))?.[1] ?? FALLBACK;

/** A gap longer than this between records is a human who walked away (or a run parked on an approval),
 *  not work — excluded from engaged time. Mirrors the Claude reader's IDLE_GAP_MS. */
const IDLE_GAP_MS = 5 * 60_000;

/**
 * The rollout file for a session, given the per-session `$CODEX_HOME` Agent OS created for it
 * (`<connectors>/session-<id>.codex`). That dir holds exactly one session, so we take the newest
 * rollout under it rather than matching the id — which also works for a resumed run, where Codex
 * appends to the SAME file. Returns undefined before the run has written one.
 */
export function findCodexRollout(codexHome: string): string | undefined {
  const root = path.join(codexHome, 'sessions');
  const out: { file: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try { out.push({ file: full, mtime: fs.statSync(full).mtimeMs }); } catch { /* vanished */ }
      }
    }
  };
  walk(root, 0);
  if (!out.length) return undefined;
  out.sort((a, b) => b.mtime - a.mtime);
  return out[0].file;
}

/** Parse a rollout into records, skipping anything malformed (a half-written last line is normal on a
 *  live run). */
function readRecords(file: string): Rec[] {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: Rec[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Rec); } catch { /* skip */ }
  }
  return out;
}

const ts = (r: Rec): number => {
  const t = Date.parse(r.timestamp ?? '');
  return Number.isFinite(t) ? t : 0;
};
const sub = (r: Rec): string => String((r.payload as { type?: unknown } | undefined)?.type ?? '');

/**
 * Cost + shape for a Codex run. Same contract as `readSessionCost`, so callers can swap on runtime and
 * everything downstream (the console, insights, episode salience) is unchanged.
 */
export function readCodexCost(file: string): SessionCost | null {
  const recs = readRecords(file);
  if (!recs.length) return null;

  // Model: recorded on turn_context (and repeated per turn). Last one wins — a run can be resumed
  // under a different model.
  let model = '';
  for (const r of recs) if (r.type === 'turn_context' && typeof r.payload?.model === 'string') model = r.payload.model as string;

  // Usage: CUMULATIVE, so take the last token_count rather than summing (see the header note).
  let input = 0, cached = 0, cacheWrite = 0, output = 0;
  for (const r of recs) {
    if (r.type !== 'event_msg' || sub(r) !== 'token_count') continue;
    const total = (r.payload as { info?: { total_token_usage?: Record<string, number> } }).info?.total_token_usage;
    if (!total) continue;
    input = total.input_tokens ?? 0;
    cached = total.cached_input_tokens ?? 0;
    cacheWrite = total.cache_write_input_tokens ?? 0;
    output = total.output_tokens ?? 0;
  }
  // `input_tokens` includes the cached portion; the input rate applies only to the uncached remainder.
  const uncached = Math.max(0, input - cached);

  const rate = rateFor(model);
  const costUsd = (uncached * rate.input + output * rate.output + cached * rate.input * 0.1) / 1_000_000;

  // Engaged time: sum the gaps between consecutive records, ignoring idle ones.
  const stamps = recs.map(ts).filter((t) => t > 0).sort((a, b) => a - b);
  let activeMs = 0;
  for (let i = 1; i < stamps.length; i++) {
    const gap = stamps[i] - stamps[i - 1];
    if (gap > 0 && gap < IDLE_GAP_MS) activeMs += gap;
  }

  // Turns = real user prompts. Tool calls = the model's function/custom tool invocations.
  const turns = recs.filter((r) => r.type === 'event_msg' && sub(r) === 'user_message').length;
  const toolCalls = recs.filter((r) => r.type === 'response_item'
    && ['custom_tool_call', 'function_call', 'local_shell_call'].includes(sub(r))).length;

  return {
    costUsd, inputTokens: uncached, outputTokens: output,
    cacheReadTokens: cached, cacheWriteTokens: cacheWrite,
    activeMs, turns, toolCalls,
  };
}

/** Friendly label + detail for a Codex tool call, mirroring the Claude reader's activity cards. */
function activityFor(name: string, input: string): { label: string; detail?: string } {
  const first = (input || '').trim().split('\n')[0].slice(0, 120);
  if (name === 'exec' || name === 'shell' || name === 'local_shell') return { label: 'Ran a command', detail: first };
  if (name === 'apply_patch') {
    const m = /\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)/.exec(input || '');
    return { label: 'Edited a file', detail: m ? m[1].trim() : undefined };
  }
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return { label: `Used ${parts[1] ?? 'a connector'}`, detail: parts[2] };
  }
  return { label: name.replace(/_/g, ' '), detail: first || undefined };
}

/**
 * A NON-TECHNICAL timeline for a Codex run — the same `ChatTurn[]` the Claude reader produces, so the
 * console's chat view renders both identically.
 *
 * Deliberately built from `event_msg` (`user_message` / `agent_message`) rather than `response_item`:
 * the response items also carry the developer/system preamble Codex injects (permissions instructions,
 * plugin lists), which is machinery, not conversation, and would swamp the view.
 */
export function readCodexConversation(file: string): Conversation {
  const recs = readRecords(file);
  if (!recs.length) return { turns: [], found: false };

  const turns: ChatTurn[] = [];
  // call_id → index of the activity turn, so its output can flip status to ok/error.
  const pending = new Map<string, number>();

  for (const r of recs) {
    const at = ts(r);
    if (r.type === 'event_msg') {
      const p = r.payload as { type?: string; message?: string };
      if (p.type === 'user_message' && p.message) turns.push({ kind: 'user', text: p.message, ts: at });
      // `phase: "commentary"` is Codex thinking aloud mid-turn; keep it, it reads as progress.
      else if (p.type === 'agent_message' && p.message) turns.push({ kind: 'assistant', text: p.message, ts: at });
      continue;
    }
    if (r.type !== 'response_item') continue;
    const p = r.payload as { type?: string; name?: string; input?: string; call_id?: string; output?: unknown };
    if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
      const { label, detail } = activityFor(String(p.name ?? ''), String(p.input ?? ''));
      if (p.call_id) pending.set(p.call_id, turns.length);
      turns.push({ kind: 'activity', tool: String(p.name ?? 'tool'), label, detail, status: 'running', ts: at });
    } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const idx = p.call_id ? pending.get(p.call_id) : undefined;
      if (idx === undefined) continue;
      const t = turns[idx];
      if (t?.kind !== 'activity') continue;
      const text = JSON.stringify(p.output ?? '');
      t.status = /"?(error|failed|exception|traceback)"?/i.test(text) ? 'error' : 'ok';
      pending.delete(p.call_id!);
    }
  }
  return { turns, found: true };
}
