// What a claude-code session cost, derived from its transcript.
//
// Claude Code writes per-message token `usage` (but no dollar figure) into the session JSONL that
// `conversation.ts` already locates by the pinned `claude_session_id`. This module reads that same
// file, sums the usage across every assistant turn, and multiplies by per-model sticker rates to get
// a USD cost. It is READ-ONLY and best-effort — a missing/unreadable transcript yields `null`, so a
// caller treats cost as simply "not known yet".

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
}

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

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
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

  return { costUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}
