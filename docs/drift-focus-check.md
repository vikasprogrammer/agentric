# Focus check (drift nudge)

Code: `src/edge/drift.ts` · wiring: `TerminalManager.driftObserve` / `runDriftJudge` in `src/terminal.ts` ·
test: `scripts/drift-nudge-test.cjs`.

## Why

The progress verdicts (`src/state/session-progress.ts`) judge a run's shape: `circling` (the same action
repeated) and `stuck` (silence). A rabbit hole has neither: busy, varied, plausible work on the wrong
thing reads as `forward`. Catching it means comparing what the run is doing against what it was asked,
which takes a model.

## How

1. **Trigger (deterministic, free).** Count allowed top-level tool calls per session. First check at 20;
   then every 20 more, at most once per 8 min. One judgement in flight per session; three consecutive
   backend failures stop judging that session.
2. **Judge (Haiku, out of band).** Input: the original request, every later *human* message paired with
   the agent message it replied to (head + tail, since proposals sit at the end), and the transcript tail.
   Harness injections in the user role (`<task-notification>`, skill bodies, command plumbing) are not
   human messages and are filtered (`isHumanText`). The model first states the `current_ask`, then a
   verdict: `on_track` / `supporting` / `drifted`.
3. **Confirmation.** A `drifted` first vote (confidence ≥ 0.8) triggers two more votes in parallel; the run
   counts as drifting only on a majority. The CLI lane has no temperature control and single votes
   flipped on identical input in the replay.
4. **Delivery.**
   - `detected` (first confirmed drift): an advisory note rides out on the agent's NEXT allowed tool call
     via `additionalContext`. The copy is branded, says what it saw, allows "this is needed, carry on",
     and suggests `task_create` for the side-finding.
   - `escalated` (still drifting at the next check): one more note, plus ONE `sessionOwner` Inbox card, only
     for an unattended, unclaimed run.
   - `persisting`: record only. `cleared`: the streak resets.
   - The strip shows `drifting` for 30 min after a drifted judgement unless a newer one clears it.
     Precedence: `blocked` > `circling` > `drifting` > `stuck` > `forward`.

Never blocks, denies or stops anything.

## Controls

| Control | Where |
|---|---|
| Mode `nudge` (default) · `observe` · `off` | Settings → Governance (`settings: drift_nudge_mode`, owner/admin) |
| Per-agent opt-out | `driftCheck: false` in `agent.json` (for exploratory agents) |
| Process kill switch | `AOS_DRIFT=0` |
| Judge model | `AOS_DRIFT_MODEL` (default `claude-haiku-4-5`) |

Backend: the workspace Anthropic key when set (pinned to Haiku whatever the Q&A model is), else an
OpenAI-compatible router LLM, else a pooled `claude -p --model <haiku>`, the summarizer's lane
(`runClaudePrompt`).

## Audit

`drift.judged` {verdict, confidence, tangent, reason, outcome, mode, via, votes, ask} ·
`drift.judge_failed` {via, reason} · `drift.nudged` · `drift.escalated`. All four are NOISE for the
activity trail.

## Calibration (2026-09-17)

Replay over 30 long instapods sessions (≥145 gated actions each), 3 checkpoints per session, using the
production prompt and the CLI lane.

| Iteration | Change | Drifted / 42 (tuning set) |
|---|---|---|
| v1 | first prompt | 8, mostly false positives |
| v2 | filter harness injections; pair human replies with the proposal they answered | 3 |
| v3 | `current_ask` first; the fallout of the agent's own work counts as `supporting` | 2 |
| v4 | keep the tail of the approved proposal | 3 (single votes flicker run to run) |
| v5 | 2-of-3 confirmation, across 90 checkpoints (tuning + held-out) | 3 confirmed: 2 genuine, 1 FP at 0.75 |

The floor was then raised to 0.8, which removes that FP. The two genuine hits:
- An agent asked only questions about tooling shipped an instrumentation PR.
- An agent told "the PR is done, this needs a founder decision, not more engineering" re-implemented the
  feature from scratch. This one came from the held-out set, 3/3 votes.

Cost: 102 model calls for 90 checks. CLI latency p50 ~14 s, which is irrelevant out of band.

Two hits is a small sample. Re-derive the floor from `drift.judged` rows after a tenant runs in `observe`.
