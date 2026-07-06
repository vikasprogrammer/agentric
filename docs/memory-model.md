# How Agent OS remembers — the four-verb model

> This is the one-page mental model for the whole memory + self-learning system. Read this first;
> every other memory doc (`memory-layer-plan.md`, `memory-encoding-and-consolidation.md`,
> `self-learning-plan.md`) is detail underneath it. If those ever disagree with this page, this page is
> the intent.

The entire system is **one loop with four verbs**:

```
   ┌─────────────────────────────────────────────────────────┐
   │                                                         │
   ▼                                                         │
CAPTURE ─────▶ RECALL ─────▶ DISTIL ─────▶ APPLY ────────────┘
what happened   read it       turn the pile   steer the
gets written    back before   of recaps into  next run with
down            working       a few durable   what we learned
                              shared lessons
```

**Agents remember what they do. Before working they recall it. Periodically the OS reads those memories,
writes the durable lessons into shared knowledge, and nudges the fleet to follow them.** That's the whole
thing. Everything below is just *how well* each verb works — not new concepts to learn.

---

## 1. Capture — writing things down

Two ways in, one store (the `memories` table + full-text index):

- **Automatic** — at the end of every session the OS writes a short **recap** of what the agent did and
  how it turned out. The agent does nothing; this is free.
- **Deliberate** — an agent chooses to keep something worth reusing: a fact (`remember`) or a lesson it
  learned while finishing (`report` with a lesson). It's prompted to do this when it was surprised, hit a
  gotcha, or made a decision a teammate would want to know.

A memory can be **private to the agent** or **shared across the whole workspace** (its *scope*). Each
memory also gets an **importance** score so the noise doesn't drown the signal — automatic for recaps,
honest self-rating for deliberate ones. *(You don't set these; the system does.)*

## 2. Recall — reading it back

Before non-trivial work an agent **searches its memory** (`recall`) and the shared **knowledge base**.
Results are ranked by relevance, importance, recency, and **how often the memory has proven useful
before** — a memory that keeps getting recalled floats up; one nobody ever touches sinks and is
eventually pruned. Recall is how yesterday's work reaches today's.

## 3. Distil — turning the pile into a few durable lessons

Raw recaps are cheap and plentiful; on their own they'd just accumulate. So the OS periodically
**reflects on recent activity** and produces two kinds of durable output:

- **Shared knowledge** — the recurring, reusable patterns become shared memories and Knowledge Base
  pages every agent can recall. (The recaps were episodic — *"what happened this once"*; these are
  semantic — *"the reusable lesson."*)
- **Guidance & suggestions** — a short list of *"here's what's been going wrong / working, do this"* for
  the fleet, plus config tuning suggestions for a human to accept or dismiss.

Under the hood this runs at two depths — a cheap always-on statistical pass and a deeper LLM "gardener"
that writes the prose — but **you treat it as one thing: the OS reflecting and getting smarter.** One
concept, one control.

## 4. Apply — steering the next run

The distilled **guidance rides in every agent's prompt**, so the fleet starts each run already knowing
what's been learned. Config **suggestions** wait for a human to Apply or Dismiss. And the new shared
memories/KB pages are there to be recalled — which loops straight back to **Capture/Recall**. The loop
closes; the fleet compounds.

---

## What you actually operate

The four verbs run themselves. A human touches only a handful of controls:

- **Self-learning: on/off** — whether the OS reflects at all.
- **Reflect now** — run a reflection pass on demand instead of waiting for the schedule.
- **Review suggestions** — Apply or Dismiss the config tuning the reflection proposed.
- **Memory: advanced** — backend/ranking knobs, hidden by default. Sensible defaults ship; most
  workspaces never open this.

## Names you'll see (all just the four verbs)

We used to expose a lot of internal vocabulary. It all collapses onto the loop:

| You might see | It's just | Verb |
|---|---|---|
| episode, recap | an auto-written session summary | Capture |
| memory, lesson, insight | something an agent kept | Capture |
| importance / salience | how much a memory matters | Capture (a *quality*, not a thing) |
| reinforcement, ranking, hybrid/embeddings | how recall picks what's relevant | Recall (a *quality*) |
| Dreaming, consolidation, the "gardener" | the OS reflecting | Distil |
| guidance, recommendations | the reflection's output | Apply |
| the "5 levers" | how *we* built Capture/Recall/Distil — engineering-internal | — (not a user concept) |

**Retired from the product surface:** "Lever 1–5" and the split between "Dreaming" and "Consolidation."
They live only in engineering plan docs now. In the console and user docs there is one loop, four verbs,
and one **Self-learning** control.
