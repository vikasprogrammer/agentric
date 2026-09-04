// Out-of-band session summary.
//
// "Ask about the session without polluting it": we summarize a run by reading its ALREADY-WRITTEN
// claude transcript (via `readConversation`) and handing that text to a FRESH, throwaway `claude -p`
// process. Nothing is typed into the target session — its own claude never sees this request, so its
// context/transcript is untouched. The summary is shown to the human in a modal; it is not persisted.
//
// If the `claude` CLI can't be run (not on PATH, times out, errors), we degrade to a deterministic
// summary computed straight from the transcript — the feature still returns something useful offline.
//
// ⚠ That degradation used to be SILENT and it hid a three-week outage. This call ran on `{...process.env}`,
// i.e. always the box default account, while every governed session goes through the runtime-account pool
// and rotates off an exhausted one. On live instawp, `runtime.usage_limited` ran 2026-07-30 → 08-15 and
// across that band 43 of 97 summaries came back `via:'fallback'` — the reason discarded by a bare
// `catch {}`, so nothing anywhere said why. Two consequences, both fixed here: the caller now passes
// POOL credentials (`TerminalManager.outOfBandCredentialEnv`), and a failure reports `reason` instead of
// being swallowed. Keep both: a summarizer that can't authenticate must be loud, not merely worse.

import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { Conversation, ChatTurn } from './conversation';

type Activity = Extract<ChatTurn, { kind: 'activity' }>;

/** How many chars of transcript we feed the summarizer (keep the tail — the recent work matters most). */
const TRANSCRIPT_CAP = 16000;

export interface SessionSummary {
  summary: string;
  /** 'ai' = summarized by a throwaway claude; 'fallback' = deterministic (claude unavailable/failed). */
  via: 'ai' | 'fallback';
  /** false when the run hasn't written a transcript yet (nothing to summarize). */
  found: boolean;
  /** Why the AI path was not used, when it wasn't. Classified from the failure so the audit trail says
   *  `usage_limit` / `not_installed` / `timeout` rather than leaving a fallback rate to be guessed at.
   *  Absent on the happy path. */
  reason?: SummaryFailure;
  /** The pool account the call authenticated as, when one was supplied (else the box default). */
  account?: string;
}

/** Why a summary fell back. `usage_limit` is the one that matters — it means the credential this call
 *  ran under is exhausted, which is a rotation problem, not a summarizer problem. */
export type SummaryFailure = 'usage_limit' | 'auth' | 'not_installed' | 'timeout' | 'empty_output' | 'error';

/** Classify an execFile rejection into something an operator can act on. The CLI reports a quota refusal
 *  on stdout/stderr with a zero-ish exit, so the text scan is the only signal available. Exported for the
 *  regression test: `usage_limit` is the classification the alert acts on, and getting it wrong is what
 *  turns a rotation problem back into a silent one. */
export function classify(err: unknown): SummaryFailure {
  const e = err as { code?: string | number; killed?: boolean; signal?: string; message?: string; stderr?: string; stdout?: string };
  if (e?.code === 'ENOENT') return 'not_installed';
  if (e?.killed || e?.signal === 'SIGTERM') return 'timeout';
  const text = `${e?.stderr ?? ''}\n${e?.stdout ?? ''}\n${e?.message ?? ''}`;
  if (/\b(weekly limit|usage limit|rate limit|limit reached|out of (?:usage|credits))\b/i.test(text)) return 'usage_limit';
  if (/\b(unauthorized|invalid api key|authentication|oauth .{0,20}expired|please run .{0,10}login)\b/i.test(text)) return 'auth';
  return 'error';
}

/** Flatten the friendly timeline into a compact plain-text script for the summarizer. */
function renderTranscript(convo: Conversation): string {
  const lines: string[] = [];
  for (const t of convo.turns) {
    if (t.kind === 'user') lines.push(`HUMAN: ${t.text}`);
    else if (t.kind === 'assistant') lines.push(`AGENT: ${t.text}`);
    else lines.push(`· ${t.label}${t.detail ? ` — ${t.detail}` : ''}${t.status === 'error' ? ' [failed]' : ''}`);
  }
  let text = lines.join('\n');
  if (text.length > TRANSCRIPT_CAP) text = '…(earlier activity truncated)\n' + text.slice(text.length - TRANSCRIPT_CAP);
  return text;
}

/** A no-LLM summary from the transcript's shape — the reliable floor when claude can't be reached. */
function fallbackSummary(convo: Conversation): string {
  const humans = convo.turns.filter((t) => t.kind === 'user').length;
  const replies = convo.turns.filter((t) => t.kind === 'assistant');
  const acts = convo.turns.filter((t): t is Activity => t.kind === 'activity');
  const errors = acts.filter((a) => a.status === 'error').length;
  const byLabel = new Map<string, number>();
  for (const a of acts) byLabel.set(a.label, (byLabel.get(a.label) ?? 0) + 1);
  const top = [...byLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const last = replies.length ? replies[replies.length - 1].text : '';
  const parts: string[] = [];
  parts.push(`${humans} message${humans === 1 ? '' : 's'} from the human, ${replies.length} agent repl${replies.length === 1 ? 'y' : 'ies'}, ${acts.length} action${acts.length === 1 ? '' : 's'}${errors ? ` (${errors} failed)` : ''}.`);
  if (top.length) parts.push('Most-used actions: ' + top.map(([l, n]) => `${l} ×${n}`).join(', ') + '.');
  if (last) parts.push('Latest agent message:\n' + (last.length > 600 ? last.slice(0, 600) + '…' : last));
  return parts.join('\n\n');
}

const INSTRUCTION = [
  "You are summarizing an autonomous agent's work session for a teammate who wasn't watching it.",
  'The session transcript is piped in below — the human\'s messages, the agent\'s replies, and a "·" activity log of the tools it used.',
  'Write a tight summary the teammate can read in ~20 seconds:',
  '- First line: the current status — what this session is doing and whether it is done, still working, waiting on something, or stuck.',
  '- Then 3–6 short bullets: the key actions taken, decisions made, and any concrete results.',
  '- Finally, call out anything that needs a human: questions asked, approvals, errors, or blockers. Omit this line if there are none.',
  'Only use facts present in the transcript — do not invent details. Output plain text, no preamble, no markdown headers.',
].join('\n');

/** Run a fresh, throwaway `claude -p`, piping the transcript on stdin. Resolves its stdout. */
function runClaude(instruction: string, transcript: string, credentials?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const home = os.homedir();
    // Mirror claude-launch.sh: the CLI is often under ~/.local/bin and a hardened service ships a
    // minimal PATH, so prepend it. Run in a neutral cwd (no agent .claude/settings.json or MCP config
    // to pick up) — this is a pure text-in/text-out call with no tools.
    // Pool credentials LAST so they override whatever the service environment carries — that precedence
    // is the fix: the box default is what was exhausted.
    const env = { ...process.env, PATH: `${path.join(home, '.local', 'bin')}:${process.env.PATH ?? ''}`, ...(credentials ?? {}) };
    const args = ['-p', instruction];
    const model = process.env.AOS_SUMMARY_MODEL;
    if (model) args.push('--model', model);
    const child = execFile(
      'claude',
      args,
      { env, cwd: os.tmpdir(), timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(String(stdout || ''));
      },
    );
    child.stdin?.on('error', () => {}); // a claude that exits early would EPIPE the write — ignore
    child.stdin?.end(`TRANSCRIPT:\n${transcript}\n`);
  });
}

/**
 * Summarize a session's conversation out-of-band. Never touches the target session. Returns a
 * deterministic fallback (never throws) if the transcript is empty or the summarizer can't run.
 */
export async function summarizeConversation(convo: Conversation, opts: { credentials?: Record<string, string>; account?: string } = {}): Promise<SessionSummary> {
  if (!convo.found || convo.turns.length === 0) {
    return { summary: 'This session has not produced a transcript yet — nothing to summarize.', via: 'fallback', found: false };
  }
  const transcript = renderTranscript(convo);
  let reason: SummaryFailure;
  try {
    const out = (await runClaude(INSTRUCTION, transcript, opts.credentials)).trim();
    if (out) return { summary: out, via: 'ai', found: true, account: opts.account };
    reason = 'empty_output'; // ran clean and said nothing — still a failure, just a quiet one
  } catch (err) {
    reason = classify(err);
  }
  return { summary: fallbackSummary(convo), via: 'fallback', found: true, reason, account: opts.account };
}
