// What a claude-code session cost — and how long it actually worked — derived from its transcript.
//
// Claude Code writes per-message token `usage` (but no dollar figure) into the session JSONL that
// `conversation.ts` already locates by the pinned `claude_session_id`. This module reads that same
// file, sums the usage across every assistant turn, and multiplies by per-model sticker rates to get
// a USD cost. It is READ-ONLY and best-effort — a missing/unreadable transcript yields `null`, so a
// caller treats cost as simply "not known yet".
//
// The same single walk also yields the run's SHAPE — engaged time, turns, tool calls — because the
// transcript is the only place that knows it. Wall-clock (`updated_at - created_at`) is not a usable
// duration: an interactive session idles between turns, so a 6-minute run can span 48 hours. Engaged
// time sums only the gaps a turn was plausibly in flight (see IDLE_GAP_MS).

import * as fs from 'fs';
import { findTranscript } from './conversation';

export interface SessionCost {
  /** Total USD across every request in the transcript. */
  costUsd: number;
  /** Uncached input tokens (billed at the model's input rate). */
  inputTokens: number;
  /** Output tokens. */
  outputTokens: number;
  /** Cache-read input tokens (billed at ~0.1× input). */
  cacheReadTokens: number;
  /** Cache-write input tokens (billed at 1.25× for 5-min, 2× for 1-hour ephemeral writes). */
  cacheWriteTokens: number;
  /** ENGAGED milliseconds: the sum of gaps between consecutive transcript entries, counting only gaps
   *  shorter than {@link IDLE_GAP_MS}. A long gap is a human who walked away (or an unattended run
   *  parked on an approval), not work — so it's excluded rather than inflating the duration. */
  activeMs: number;
  /** Conversation turns — user messages that are real prompts, not the tool_result envelopes claude
   *  code writes back as `user` lines. A one-shot headless run is 1; a long steered session is many. */
  turns: number;
  /** Tool calls the agent made (`tool_use` blocks). The honest "how much did it actually do" volume —
   *  unlike the governed-action count, which only sees capabilities the gate mediates. */
  toolCalls: number;
}

/** A gap longer than this between two transcript entries is idle time, not work. Five minutes is
 *  comfortably longer than a slow turn (including a long tool run) and far shorter than a human
 *  stepping away, so it splits the two without needing per-turn instrumentation. */
const IDLE_GAP_MS = 5 * 60_000;

// Per-model sticker pricing, USD per 1M tokens. Cache rates derive from the input rate — read = 0.1×,
// 5-minute write = 1.25×, 1-hour write = 2× — per Anthropic's prompt-cache pricing. We deliberately do
// NOT model Sonnet 5's introductory discount (it's date-bounded); the sticker rate keeps the recorded
// number stable rather than silently shifting on a calendar boundary. An unknown model falls back to
// Opus-tier so we never undercount a mystery run.
interface Rate { input: number; output: number }
const RATES: Array<[RegExp, Rate]> = [
  [/opus/, { input: 5, output: 25 }],
  [/fable|mythos/, { input: 10, output: 50 }],
  [/sonnet/, { input: 3, output: 15 }],
  [/haiku/, { input: 1, output: 5 }],
];
const FALLBACK: Rate = { input: 5, output: 25 };

function rateFor(model: string): Rate {
  for (const [re, r] of RATES) if (re.test(model)) return r;
  return FALLBACK;
}

/** Sum the transcript's per-request usage into a USD cost + token breakdown. `null` when no transcript
 *  file exists yet (the run hasn't written one) or it can't be read. */
export function readSessionCost(claudeSessionId: string): SessionCost | null {
  const file = findTranscript(claudeSessionId);
  if (!file) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let activeMs = 0;
  let turns = 0;
  let toolCalls = 0;
  let prevTs = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    // ── shape: timing + volume, over BOTH roles (the assistant-only cost pass below is narrower) ──
    if (o.type === 'assistant' || o.type === 'user') {
      const ts = Date.parse(o.timestamp) || 0;
      if (ts) {
        if (prevTs) {
          const gap = ts - prevTs;
          if (gap > 0 && gap < IDLE_GAP_MS) activeMs += gap;
        }
        prevTs = ts;
      }
      const content = o.message?.content;
      const blocks = Array.isArray(content) ? content : [];
      // A `user` line carrying a tool_result is the transcript's plumbing, not a person's prompt.
      const isToolResult = blocks.some((b: any) => b && b.type === 'tool_result');
      if (o.type === 'user' && !isToolResult) turns++;
      if (o.type === 'assistant') toolCalls += blocks.filter((b: any) => b && b.type === 'tool_use').length;
    }

    // Only assistant messages carry request `usage`; each one is a distinct billed request, so summing
    // across all of them is the whole-session total (cached prefixes re-read each turn are real spend).
    if (o.type !== 'assistant') continue;
    const u = o.message?.usage;
    if (!u) continue;

    const rate = rateFor(String(o.message?.model || ''));
    const inp = u.input_tokens || 0;
    const out = u.output_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    // Cache creation splits into 1-hour (2×) and 5-minute (1.25×) ephemeral write tiers. When the split
    // isn't present, treat the flat `cache_creation_input_tokens` as a 5-minute write (the default TTL).
    const cc = u.cache_creation || {};
    const write1h = cc.ephemeral_1h_input_tokens || 0;
    const write5mSplit = cc.ephemeral_5m_input_tokens || 0;
    const split = write1h + write5mSplit;
    const write5m = split ? write5mSplit : (u.cache_creation_input_tokens || 0);

    inputTokens += inp;
    outputTokens += out;
    cacheReadTokens += cacheRead;
    cacheWriteTokens += write1h + write5m;
    costUsd +=
      (inp * rate.input +
        out * rate.output +
        cacheRead * rate.input * 0.1 +
        write5m * rate.input * 1.25 +
        write1h * rate.input * 2.0) /
      1_000_000;
  }

  return { costUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, activeMs, turns, toolCalls };
}
