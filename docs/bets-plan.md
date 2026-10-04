# Bets — the unit between a goal and the work

A goal says where to get to. A task says what to do. Neither answers the question an autonomous loop
has to answer every week: **did that change anything?** A **bet** is one falsifiable attempt at a
goal's number — a hypothesis, the things it put into the world, a window, a prediction, and at the end
of that window a verdict computed from what it actually shipped.

Shipped in v0.453.0: the two tables, the agent tools, the judging sweep. The board UI is still to come
(see §6).

## 1. Why assets and not the goal's metric

Whole-metric attribution cannot separate two bets running at once, and on a real goal several always
are. On the instapods growth trial three bets started inside four days while the site's own clicks
drifted **down** for unrelated reasons (a broad seasonal dip, positions unchanged). Judged on the goal,
all three read as failures; judged on their own pages, they are separable and two were working.

So lift is measured on the bet's own **assets**:

```
lift = Σ(asset.value) − bet.baseline
```

and the goal's metric stays what it is — the outcome nobody owns alone. `value` is in the goal metric's
own unit, so no mapping is needed: a bet on a clicks/day goal predicts clicks/day.

## 2. Why a bet is not a task

Folding bets into `tasks` breaks three things, and each was a real consideration rather than a
hypothetical:

| | Task | Bet |
|---|---|---|
| finished when | the work is done | the number has been judged, usually weeks later |
| status machine | `todo → doing → blocked → done` | `proposed → waiting → running → judging → kept/expanded/killed` |
| dispatcher | an agent-assigned `auto_dispatch` task **spawns a session** | must never spawn anything; only its tasks do |
| fields | — | hypothesis, window, baseline, expected lift, verdict, lesson |

A task therefore **points** at a bet (`tasks.bet_id`, nullable and inert) instead of being one.

## 3. The split that makes a verdict worth something

> The server owns the number. The agent owns the words.

- `BetStore.judge()` computes `observedLift` and a verdict of `met | short | no_signal` from the
  assets. Those three columns are absent from every write path an agent has — `bet_update` cannot set
  them, and the test pins that.
- The agent (or a human) owns the `lesson` and the final state. A terminal state **requires** a lesson:
  the next bet is chosen from these, and "killed" with no reason teaches nothing.
- **Disagreement is allowed and recorded.** An agent may kill a `met` bet or keep a `short` one; the
  `bet.updated` audit row carries both the decision and the arithmetic it went against.

This is the Insights lesson applied: a self-graded outcome drove ~zero action, so the half an agent
cannot write is the half worth having.

## 4. `no_signal` is not failure

Before any comparison with the prediction, the judge asks whether the bet was *tested at all*:

- no assets recorded → `no_signal` ("the bet shipped nothing");
- assets but no measurements → `no_signal` ("the window closed untested");
- every asset `indexed: false` → `no_signal` ("never put in front of anyone").

On the live trial this was the distinction that mattered: "11 of 15 posts never indexed" is a
publishing problem, not evidence against the hypothesis. Only then does `met` apply at
`MET_FRACTION` (50%) of the predicted lift, else `short`.

## 5. Bounds

| Thing | Limit | Why |
|---|---|---|
| live bets per goal | 4 (`MAX_LIVE_BETS`) | past this a loop runs more experiments than it can attribute — the trial's operator hit exactly this ceiling |
| window | 7–60 days, clamped | shorter cannot show a content/search effect; longer is not a bet |
| assets per bet | 60 | enough for a page family, few enough that "measure them all" stays cheap |
| re-lengthening a window | judge date re-stamped off the **original** start | otherwise a bet postpones its own judgement forever |

## 6. Still to come

1. **The board UI** — `GET /api/bets?goal=` already returns bets with their assets and per-state
   counts; the Goals page needs the Proposed / Running / Kept / Killed columns and the chart markers
   (the cockpit mockup).
2. **A strategy object** — bets currently hang straight off the goal. Versioned strategy ("what we are
   betting on this month, and why we changed") is the next layer up.
3. **Measurement that does not depend on the agent remembering.** Today the agent calls
   `asset_measure`; a connector-driven pull (Search Console → assets by URL) would remove the step an
   agent can forget.
4. **A policy brake on dispatch** — a bet whose tasks spend beyond a cap should need a human, the same
   way `secret.put` does.
