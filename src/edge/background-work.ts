// "The turn ended, but the run hasn't" — the unattended lane's blind spot, and the two halves of the fix.
//
// An unattended run is torn down by the SERVER at turn-end (Stop hook → `markTurnIdle` →
// `teardownUnattended`), which is the parity replacement for the old `claude -p` process exit. That is
// right for the normal case and wrong for one specific, expensive one: an agent that launches
// BACKGROUND work — a subagent (`Agent`, run in the background) or a `Bash` with
// `run_in_background: true` — and then ends its turn intending to be woken when that work completes.
// Claude Code does exactly that (a `<task-notification>` is injected and a new turn starts), but by
// then the pane is gone: the run is killed mid-work, its children are killed with it, and it never
// reaches `report`. The session lands as `outcome: unknown` with an empty summary — "no report" in the
// chain — and the caller waits for a hand-off that will never close.
//
// Observed on instapods 2026-08-11 (`ses_11dd20920d30aae4`, agent `engineer`, $12.34): it pushed
// PR #502, spawned a `/code-review` subagent, invented two `until … sleep` background loops as a way
// to "wait", said "I'll fold in whatever it finds before closing the task out", and ended its turn.
// The Stop beacon landed 300ms later; the reap killed the review subagent ("stopped by user"). The
// task sat `doing` for ten minutes until the stranded sweep poked the caller, which cost another
// $18.99 to work out what had happened. Fleet-wide over the preceding 14 days: 49 unattended runs
// reaped at turn-end with no report.
//
// Two halves, because either alone is insufficient:
//
//  1. {@link pendingBackgroundWork} — the SERVER stops tearing down a run whose background children are
//     still outstanding. Read off the transcript, since that is the only place the harness records it.
//  2. {@link UNATTENDED_TURN_BRIEF} — the AGENT is told that on this lane a turn boundary is a run
//     boundary, so "yield and wait" is not a strategy it has. The engineer reinvented sleep-loops
//     precisely because nothing said so; a grace window alone would have let it idle, not finish.
//
// The guard is deliberately narrow. It only defers a run that has NOT yet reported (a `report` flips
// the row to `done` — the agent saying it is finished, whatever stray `tail -f` it left running), and
// only up to {@link BACKGROUND_GRACE_MS}, measured from the first defer of that run. Past the cap the
// teardown proceeds and is audited as such, so "we waited and it still didn't finish" is a visible,
// queryable event rather than a run that quietly lives forever.

import fs from 'node:fs';

/**
 * How long an unattended run may keep its pane past turn-end while background children are still
 * running. Measured from its FIRST defer, so the extra life is bounded per RUN, not per turn — an
 * agent that leaves a never-ending `sleep` loop behind (the engineer did) cannot renew the grace by
 * ending more turns.
 *
 * 15 minutes: long enough for the work that actually motivates this (a code-review subagent, a test
 * suite, a build), and comfortably inside the 30-minute idle-straggler backstop in `reapIdleSessions`
 * — which remains the outer bound whatever happens here.
 */
export const BACKGROUND_GRACE_MS = 15 * 60_000;

/** Launch acks, as Claude Code writes them into the tool_result. These strings ARE the contract with
 *  the harness; if a release changes them the guard fails OPEN (no pending work detected → today's
 *  teardown behaviour), which is why the falsifier asserts on fixture transcripts.
 *
 *  Three shapes, because there are three ways to start background work and they read nothing alike —
 *  the third (a Skill invoked as a forked run, e.g. `/code-review`) is what the incident actually used,
 *  and a detector written from the first two would have missed the very run it was built for. */
const ACK_SHELL = 'Command running in background with ID:';
const ACK_SUBAGENT = 'Async agent launched successfully';
const ACK_SKILL = 'forked execution, running in the background';

/** Completion arrives as a `<task-notification>` user message carrying the launching tool-use id —
 *  the same id for both kinds, and for every terminal status (completed, failed, killed). */
const NOTIFICATION_ID = /<tool-use-id>([^<]+)<\/tool-use-id>/g;

export interface PendingBackground {
  /** Background `Bash` commands launched and not yet notified. */
  shell: number;
  /** Background subagents launched and not yet notified. */
  subagents: number;
  /** Skills launched as a forked background run (`/code-review …`) and not yet notified. */
  skills: number;
  /** shell + subagents + skills — always ≥ 1 (a zero total is reported as `null` instead). */
  count: number;
}

/** Text of a tool_result, whether the harness wrote it as a bare string or as content blocks. */
function resultText(block: { content?: unknown }): string {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n');
  return '';
}

type Child = 'shell' | 'subagent' | 'skill';

function harvestNotifications(text: string, pending: Map<string, Child>): void {
  if (!text.includes('<tool-use-id>')) return;
  for (const m of text.matchAll(NOTIFICATION_ID)) pending.delete(m[1]);
}

/**
 * Does this run still have background children outstanding?
 *
 * Walks the transcript pairing LAUNCH acks against COMPLETION notifications by tool-use id. A launch
 * with no matching notification is still running — that is the whole rule, and it is the harness's own
 * bookkeeping rather than a guess about what the agent meant.
 *
 * Fails OPEN in every failure mode (no transcript, unreadable file, unparseable lines, an oversized
 * transcript): returns `null`, and the caller tears down exactly as it does today. A guard that fails
 * CLOSED here would keep panes alive on every parse error, which is a worse bug than the one it fixes.
 */
export function pendingBackgroundWork(transcript: string | undefined): PendingBackground | null {
  if (!transcript) return null;
  let raw: string;
  try {
    // A transcript is normally a few hundred KB. The cap is a runaway guard only — this runs on the
    // Stop-hook hot path, synchronously, once per turn.
    const { size } = fs.statSync(transcript);
    if (size > 32 * 1024 * 1024) return null;
    raw = fs.readFileSync(transcript, 'utf8');
  } catch {
    return null;
  }
  const pending = new Map<string, Child>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row: { message?: { content?: unknown } };
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a partially-flushed final line must not lose the rest of the file
    }
    const content = row?.message?.content;
    if (typeof content === 'string') {
      harvestNotifications(content, pending);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; text?: string; tool_use_id?: string; content?: unknown };
      if (b.type === 'tool_result' && b.tool_use_id) {
        const text = resultText(b);
        if (text.includes(ACK_SHELL)) pending.set(b.tool_use_id, 'shell');
        else if (text.includes(ACK_SUBAGENT)) pending.set(b.tool_use_id, 'subagent');
        else if (text.includes(ACK_SKILL)) pending.set(b.tool_use_id, 'skill');
        else harvestNotifications(text, pending); // a notification can arrive as a tool_result too
      } else if (b.type === 'text' && typeof b.text === 'string') {
        harvestNotifications(b.text, pending);
      }
    }
  }
  if (!pending.size) return null;
  let shell = 0;
  let subagents = 0;
  let skills = 0;
  for (const kind of pending.values()) {
    if (kind === 'shell') shell++;
    else if (kind === 'subagent') subagents++;
    else skills++;
  }
  return { shell, subagents, skills, count: pending.size };
}

/**
 * Appended to the system prompt (via `buildCompanyMd`) for UNATTENDED runs only.
 *
 * A member's own interactive session owns its lifecycle — the turn boundary means nothing there, and
 * telling a human's agent it is about to be killed would be false. So this rides the headless lane
 * alone, and it names the alternatives the OS actually provides rather than just prohibiting the
 * pattern: an agent told "don't wait" with no way to wait will invent one.
 */
/**
 * Appended to the system prompt (via `buildCompanyMd`) for EVERY run, both lanes.
 *
 * {@link UNATTENDED_TURN_BRIEF} already says "do not idle with sleep" — but it says it about the TURN
 * BOUNDARY ("you cannot yield and wait"), it rides the unattended lane alone, and its remedy is "stay
 * in the turn and read its result". An agent that reads it and then blocks for ten minutes inside one
 * `Bash` call has followed it to the letter. This brief covers the case that one does not: waiting is
 * legitimate and unavoidable (a CDN rule propagating, a 300-domain sweep, a build) — the question is
 * how, not whether.
 *
 * The limits here are enforced by the harness, not by taste, which is why they are stated as rules:
 *
 *   - A foreground `sleep` is REFUSED by the Bash tool ("Blocked: sleep N followed by …"), whose own
 *     message adds "Do not chain shorter sleeps to work around this block" and points at
 *     `run_in_background` / `Monitor`. Fleet transcripts show agents hitting that block repeatedly
 *     while this brief was still telling them to poll with `sleep 5`.
 *   - A foreground `Bash` call ends at ~2 minutes — killed on older builds, auto-backgrounded on newer
 *     ones. Both shapes appear in live transcripts.
 *
 * HISTORY, so the old argument is not reinstated from memory: until v0.447.3 this brief's central claim
 * was a ~5-minute prompt-cache TTL, with a measurement behind it (one 600 s wait cut tool calls 40 -> 29
 * yet RAISED cost $8.37 -> $11.83, cache_write 0.27M -> 0.73M). That premise no longer holds for these
 * runs: cache writes are now essentially all 1-hour entries — instapods 8,793 `ephemeral_1h` vs 0
 * `ephemeral_5m` over ~8.8k responses, expresstech ~20k vs 12, instawp all 1h — so a wait of a few
 * minutes no longer re-writes the context at full price, and an argument built on the 5-minute cliff was
 * telling agents something false. The reason not to idle is now the harness limits above plus the plain
 * opportunity cost of a turn spent sleeping. If a future release changes the TTL again, re-measure from
 * `ephemeral_*_input_tokens` in the transcripts rather than restating either number.
 */
export const WAITING_BRIEF =
  '# Waiting: hand the wait to the harness, never to a sleep\n\n' +
  'Some work genuinely takes minutes and is not yours to speed up — a rule propagating to an edge, a ' +
  'sweep over hundreds of hosts, a build, CI. Waiting for it is fine. Waiting for it by sitting in a ' +
  '`Bash` call is not, and the harness enforces that for you:\n\n' +
  '- **A foreground `sleep` is BLOCKED.** The tool refuses it (`Blocked: sleep …`) and says so in the ' +
  'same words this note does: do not chain shorter sleeps to get around it. A `while`/`until` loop that ' +
  'only sleeps is the same idling with extra steps.\n' +
  '- **A foreground `Bash` call is cut off at about 2 minutes** — killed, or moved to the background ' +
  'mid-way. Either way the wait is not where your work should be.\n\n' +
  '**The two supported ways to wait**, both of which let you keep working (or stop) while it runs:\n\n' +
  '- **One notification, when a condition comes true** — `Bash` with `run_in_background: true` and a ' +
  'command that EXITS once it holds. You are told when it exits, and `TaskOutput` reads what it printed. ' +
  'No trailing `&`.\n' +
  '```bash\n' +
  '# run_in_background: true\n' +
  'until grep -q "Ready in" dev.log; do sleep 0.5; done\n' +
  '```\n' +
  '- **One notification per occurrence** (each new CI check, each ERROR line) — `Monitor`, with a ' +
  'bounded `timeout_ms` and a filter that matches the FAILURE signatures too, not just the happy path: ' +
  'a monitor that greps only for success is silent through a crash, and silence reads as "still ' +
  'running". Re-arm it if it expires while you still care. Both of these run real commands, so they are ' +
  'governed like any other shell call.\n\n' +
  '**Make each wait earn its turn.** A poll that only sleeps converts model time into wall time and ' +
  'saves nothing. While the slow thing runs, read partial results, write the rows that are ready, update ' +
  'the sheet or the ticket, act on the failure already in the log. If a run of yours is mostly waiting, ' +
  'the work was serialised behind something that did not need to block it.\n\n' +
  '**Do not read this as "batch less".** Pushing a loop over 300 items into one script instead of 300 ' +
  'turns is still right, and still the largest win available. The rule is narrower: no SINGLE call sits ' +
  'idle waiting. Batch the work; let the harness watch the wait.';

export const UNATTENDED_TURN_BRIEF =
  '# This run ends when your turn ends\n\n' +
  'You are running **unattended** — nobody is at this terminal. There is no next prompt: when you stop ' +
  'and hand the turn back, this run is over and the session is torn down. Ending your turn is how you ' +
  'finish, not how you pause.\n\n' +
  '**So you cannot yield and wait.** Do not end your turn expecting to be woken — not by a background ' +
  'command, a subagent, a delegated task, a review, a build, or a person. A result that arrives after ' +
  'your run has ended is filed on the task or in the Inbox; it does not bring you back. Waiting INSIDE ' +
  'the turn is fine (short bounded polls, per the waiting note below); a `sleep` or `until [ -f … ]` ' +
  'loop left running while you hand the turn back is not. If you launch background work you intend to ' +
  'use, **stay in the turn and read its result** (`TaskOutput` for a background command or subagent) ' +
  'before you stop. The OS gives an unfinished background child a short grace period, but only until ' +
  'you `report` — so read the result first, then report.\n\n' +
  '**When the thing you need is not coming inside this run, use the OS instead of the turn:**\n' +
  '- `task_wait` (or `task_create({ wait: true })`) — blocks INSIDE your turn until a delegated agent ' +
  'finishes, for up to ~15 minutes per call. If it returns "still running", call it again; if you have ' +
  'to stop first, `report` that the hand-off is in flight.\n' +
  '- `ask_human` — on this lane it waits only about two minutes, because nobody is watching. If no answer ' +
  'comes, do not guess on anything risky: if you are working a task, `task_update` it `blocked` with ' +
  '`blockedOn: "human"` so the question travels with the task and the answer re-opens it, then `report` ' +
  'and stop. Ending the run cancels the Inbox question itself.\n' +
  '- `schedule` — defers a FUTURE run of yourself (minutes to days out) for something that cannot ' +
  'happen inside this run at all: a deploy settling, a reply you expect tomorrow. Report what you did ' +
  'first; the scheduled run picks it up.\n' +
  '- `task_create` — hand the remainder to the agent who should do it (`autoDispatch: true`). A task you ' +
  'file WITHOUT dispatching it is only a proposal a human must accept, so use that for work a person ' +
  'should decide on, not as a way to continue your own.\n\n' +
  '**Always `report` before you stop.** It is the only record of what happened: an unattended run that ' +
  'ends without one shows up as "no report", the caller waiting on you is left stranded, and everything ' +
  'you did is invisible to the humans and agents downstream. If you are stopping early — blocked, out ' +
  'of budget, out of scope — that is still a `report`, with the outcome and what is left. ' +
  'Say what remains, and where you parked it, so the next run starts where you left off.';
