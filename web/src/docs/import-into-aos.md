# Import into AOS

Bringing an agent over from another system (a raw Claude Code project, a CrewAI/LangGraph agent, a folder of prompts, a custom harness)? This page gives you a **master prompt** to paste into that agent. It briefs the agent on what Agent OS is and has it emit a **bundle** — a small, standard folder — that drops straight into AOS.

The trick: the bundle mirrors how AOS actually stores things. On the **Agents** page, **Import bundle** takes the whole `.zip` and reconstructs the agent in one shot — files land on disk, and the parts that *aren't* files (memory, knowledge) are replayed through the same stores an agent writes to. Or, if you prefer, drop the files in by hand — see **Finishing the import** below.

## How an AOS agent is stored (why the bundle looks the way it does)

| Entity | Where it lives in AOS | Drops in as a file? |
| --- | --- | --- |
| **Agent manifest** (`agent.json`) | `data/agents/<id>/agent.json` | ✅ yes |
| **Instructions** (`CLAUDE.md`) | `data/agents/<id>/CLAUDE.md` | ✅ yes |
| **Skills** | `data/skills/<name>/SKILL.md` (global, shared by all agents) | ✅ yes |
| **Memory** | SQLite (`memories` table) | ❌ needs replay/import |
| **Knowledge** | SQLite + `data/kb/…` | ❌ needs replay/import |

So an agent's *brain* (manifest + instructions + skills) is pure files — the importer drops them in (or you can copy them in and hit **Rescan**). Its *memory* and *knowledge* aren't files, so the bundle carries them as `memory.jsonl` + `knowledge/` and the importer **replays** them through AOS's own `remember`/`kb_write` paths — the same thing a human would do by hand, done losslessly in one step.

**Never put in a bundle:** secrets/API keys/tokens, absolute filesystem paths, or the auto-generated `.claude/aos-settings.json` and materialized `.claude/skills/` — AOS regenerates those at launch for its own environment.

## The bundle format

```
<agent-id>/
├── bundle.json          # metadata: schema version, source system, what's inside
├── agent.json           # AOS manifest (identity, model, budget)
├── CLAUDE.md            # the agent's system prompt / operating instructions
├── memory.jsonl         # one JSON memory per line (durable facts the agent learned)
├── skills/              # optional — reusable procedures this agent relies on
│   └── <skill-name>/
│       ├── SKILL.md
│       └── references/…
└── knowledge/           # optional — shared reference docs to seed the KB
    └── <section>/<slug>.md
```

## The master prompt

Paste everything between the lines into the agent you're migrating **on its current system**. It will produce the bundle.

~~~text
You are being migrated into Agent OS (AOS), a governed runtime for autonomous
agents. Your job right now is to package YOURSELF into an "AOS bundle" — a folder
another operator will import so that a faithful copy of you runs inside AOS.

────────────────────────────────────────────────────────────────────────
WHAT AGENT OS IS (context, so you package the right things)
────────────────────────────────────────────────────────────────────────
AOS runs agents under guardrails. Every real-world side effect an agent
attempts (sending mail, pushing code, spending money) passes through one
mediated gateway that classifies it green/yellow/red and pauses for a human
when needed. You do NOT need to build any of that — AOS provides it. You only
need to hand over your identity, instructions, skills, and memory.

The AOS entities you map onto:
• AGENT   — a WHO: an identity with instructions, a model, and a budget. That's you.
• SKILL   — a HOW: a reusable procedure/knowledge doc (e.g. "how to file a refund").
            Stateless, shareable. Anything you "know how to do" that is a
            self-contained playbook is a skill, not part of your core instructions.
• MEMORY  — durable facts YOU learned across runs (preferences, outcomes, gotchas).
            One self-contained fact per entry.
• KNOWLEDGE — shared reference material a whole team would consult (optional).

────────────────────────────────────────────────────────────────────────
WHAT TO PRODUCE
────────────────────────────────────────────────────────────────────────
Create a folder named after your agent id (lowercase, hyphens, e.g.
"support-triage") containing these files. Write real files if you can; if you
cannot write files, print each file's full contents under a clear "=== path ==="
header so it can be reconstructed.

1) bundle.json
   {
     "schema": "aos-bundle/v1",
     "agentId": "<lowercase-hyphen-id>",
     "sourceSystem": "<where you run today, e.g. 'Claude Code project'>",
     "contents": ["agent.json","CLAUDE.md","memory.jsonl","skills","knowledge"]
   }

2) agent.json  — your AOS manifest. Fill what you can; the operator completes the rest.
   {
     "id": "<same lowercase-hyphen id>",
     "version": "1.0.0",
     "description": "<one sentence: what you do and when to run you>",
     "category": "<Support|Engineering|Marketing|Sales|Research|Ops|System>",
     "runtime": "claude-code",
     "model": "claude-opus-4-8",
     "examplePrompts": ["<2-4 prompts that show how you're typically invoked>"]
   }
   (Leave out principal/policyContext/budget — AOS assigns safe defaults.)

3) CLAUDE.md  — your operating instructions: role, how you work, hard rules,
   domain facts, API/endpoint notes, common pitfalls. This is your brain.
   RULES:
   • Strip every secret, password, API key, token, and private key. If a
     credential is needed, write a placeholder like <SET_IN_AOS_CONNECTORS>
     and note what it's for.
   • Remove absolute paths tied to your current machine (e.g. /Users/you/…);
     describe the resource instead.
   • Pull anything that is a standalone reusable procedure OUT into skills/ (below).

4) memory.jsonl  — one JSON object per line, each a single durable fact you've
   learned that a fresh copy of you should still know. Format:
   {"content":"<self-contained fact>","tags":["short","labels"],"importance":0.5,"shared":false}
   • content: a complete statement understandable with no other context.
   • importance: 0..1 — ~0.8+ for a key rule/decision, ~0.5 default, ~0.3 minor.
   • shared: true only if the fact is useful to OTHER agents too (team-wide).
   • Be selective. 10 sharp facts beat 200 noisy ones. Skip anything transient,
     secret, or already covered by your CLAUDE.md.

5) skills/<name>/SKILL.md  (optional, repeatable) — each reusable procedure you
   rely on, as its own folder. SKILL.md starts with a one-line purpose, then the
   steps. Put long reference material in skills/<name>/references/*.md.

6) knowledge/<section>/<slug>.md  (optional) — shared reference docs (runbooks,
   product facts) that belong to the whole team, not just you.

────────────────────────────────────────────────────────────────────────
BEFORE YOU FINISH — self-audit
────────────────────────────────────────────────────────────────────────
□ No secrets, keys, tokens, or passwords anywhere in any file.
□ No machine-specific absolute paths.
□ agent.json id is lowercase-hyphen and matches the folder + bundle.json.
□ Every memory line is valid JSON and a self-contained fact.
□ Reusable playbooks are in skills/, not buried in CLAUDE.md.
□ You could hand CLAUDE.md to a stranger and they'd know how to be you.

Produce the bundle now.
~~~

## Finishing the import (operator side)

Zip the bundle folder and, on the **Agents** page, click **Import bundle** (owner/admin) — or `POST /api/agents/import` with the raw `.zip` bytes. In one shot the importer:

- writes `agent.json` + `CLAUDE.md` into `data/agents/<agent-id>/` and registers the agent **live** (no rescan needed);
- installs each `skills/<name>/` into the global library;
- **replays** every `memory.jsonl` line via the same store `remember` uses (a `"shared": true` line publishes tenant-wide);
- **replays** each `knowledge/<section>/<slug>.md` into the KB, authored as the agent.

It reports how many memories / KB pages / skills came in, plus any **warnings** (a malformed memory line, a skill whose name is already taken — skipped, never fatal). Safe defaults are assigned for anything the bundle omits (`principal`, `policyContext`, `budget`).

Afterward, open the agent and set its **budget, model, and assignments**, skim the `CLAUDE.md` for anything that still assumes the old environment, and wire any credentials it needs via **Connectors** — never in the file.

**Doing it by hand instead?** The files are drop-in: copy `agent.json` + `CLAUDE.md` into `data/agents/<agent-id>/` and each `skills/<name>/` into `data/skills/<name>/`, then **Rescan**. For the non-file parts, run the agent once and tell it *"read `memory.jsonl` in your folder and `remember` each line"* / *"`kb_write` each file under `knowledge/`"* — the same replay the importer automates.
