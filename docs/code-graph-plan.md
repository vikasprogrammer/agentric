# Code-graph for coding agents — research + parked experiment

**Status: PARKED (2026-10-13).** Nothing built. This records the evidence and the experiment to
run when we pick it up. The decision is **don't build one; A/B an off-the-shelf MCP first.**

## Why this came up

We compared TencentDB-Agent-Memory (a team memory hub with chat memory, LLM-Wiki, versioned skills
and a **Code-Graph**) and `auto-memory`-style local session stores against what Agentric already ships.
Everything except the code-graph already has an equivalent here:

| Tencent asset | Ours |
|---|---|
| L0 raw transcripts | `session_history` / `session_open` (FTS over every run's transcript) |
| L1 atoms (facts, preferences) | memory plane — `remember`/`recall`, bm25 + optional vector, RRF |
| L2/L3 scenario + persona distillation | Dreaming + the consolidation gardener |
| LLM-Wiki | KB plane (revisions + revert) |
| Versioned skills | skills library + gated `skill_propose` |
| ACL / team binding | memory `scope` (agent \| tenant), skill audiences, run-as visibility — coarser |
| **Code-Graph** | **none** |

Tencent's integration model (point the agent's base URL at a memory proxy) is a non-starter: it puts an
ungoverned layer between agent and model and breaks session cost accounting. auto-memory's file
tracking + checkpoints duplicate the gate-hook audit trail and transcripts. So the only idea worth
carrying forward is the code-graph.

## Our own data (30 days to 2026-10-13)

Measured with `scripts/code-exploration-share.mjs` over the Claude transcripts on the `northwind` box
(three tenants) plus `globex` and `initech`; `umbrella` had no coding runs in the window. A **coding run** =
one that ran `git commit`/`git push`/`gh pr create`. **Exploration** = `Read`/`Grep`/`Glob`/`LS`, or a
Bash call starting with `grep`/`sed -n`/`cat`/`ls`/`find`/`head`/`tail`/`awk`/`git log|show|grep`.
Subagent transcripts are attributed to the parent run.

| | All coding runs | The 3 `engineer` agents |
|---|---|---|
| Coding runs | 524 (98.6k tool calls) | 348 (64.5k calls) |
| Exploration share of **calls** | 30% | 28% |
| Exploration share of **tool-result text** | 49% | 45% |
| Calls before the first edit (median) | — | 25–37 of ~76–141 |
| Reads of a file the same agent read in an EARLIER run | 15% | 20% |

Per-agent highlights: `globex/engineer` 245 coding runs, 29% calls / 44% context; `globex/infra-ops`
44% / 69% — but that's mostly logs and server state, not code, so a code-graph wouldn't help it.

Notes on the measurement:
- Exploration is overwhelmingly **Bash**, not the tools: `grep` 9.4k, `sed -n` 9.0k, `cat` 3.6k,
  `git` 2.1k, `ls` 1.7k — against only a few hundred `Read` calls. Agents page through files.
- The within-run "duplicate read" figure (56–60%) is mostly `sed -n` reading different line ranges of
  the same file — paging, not waste. Not counted as savings.
- Files are keyed by their last 3 path segments (worktree paths differ per run), so the cross-run 20%
  may be slightly high where repos share names like `src/index.ts`.

## What's out there

| Tool | What it is | Notes |
|---|---|---|
| [codebase-memory-mcp](https://arxiv.org/abs/2603.27277) | tree-sitter graph in SQLite, over MCP | The only one with a paper |
| [CodeGraph](https://codegraph.codes/) | local symbol + call graph, SQLite + FTS, re-indexes changed files | Single repo only; claims 58–94% fewer tool calls (unverified) |
| [code-graph-mcp](https://github.com/sdsrss/code-graph-mcp), [CodeGraphContext](https://heyclau.de/entry/mcp/codegraphcontext-mcp-server) | tree-sitter call graph, impact analysis | CodeGraphContext's listing warns comments can carry prompt injection into the graph |
| [Serena](https://mcpservers.org/servers/serena-mcp-server) | IDE-style tools backed by language servers | ~24k tokens of tool schema by [one count](https://lobehub.com/mcp/mcpslim-serena-slim) — on top of our own ~19k MCP schema |
| Sourcegraph | SCIP index run as a service | Heavy; the only one that follows calls across repos |
| Claude Context, CocoIndex | embedding search ("find code like this") | Not a graph — a different question ([comparison](https://baeseokjae.github.io/posts/ai-coding-agent-code-index-mcp-comparison-2026/)) |

## What the evidence says

- **[Codebase-Memory paper](https://arxiv.org/html/2603.27277v1)** — the best evidence there is. On code
  Q&A across 31 repos: ~10× fewer tokens, 2.1× fewer tool calls, but answer quality **83% vs 92%** for a
  file-exploring agent. Q&A, not editing.
- Every other number is vendor or blog material; no independent end-to-end SWE-bench result shows
  resolve rate holding.
- **Claude Code's own team** tried local vector DBs and recursive indexing; plain grep/glob won. Cited
  costs: the indexing step and a stale index ([summary](https://smartscope.blog/en/ai-development/practices/rag-debate-agentic-search-code-exploration/),
  [why agents still use grep](https://yage.ai/share/why-coding-agents-still-use-grep-en-20260327.html)).
- **[Token reduction ≠ cost reduction](https://arxiv.org/html/2607.12161v5)** — the most rigorous study
  (2,908 runs). Prompt-cache traffic was ~80% of the bill; tool output ~3%. Cutting tool output 38%
  *raised* cost 7% because the agent needed extra turns.

## What it means for us

- **Count turns, not tokens.** Every turn re-sends the cached prefix, so the 49% context share matters
  less than the 30% call share. (Also: the fleet runs fixed-price Claude Max — frame it as quota/turns,
  not dollars.)
- **Realistic ceiling ≈ 15% fewer turns** in coding runs, if a graph halves exploration (the paper's 2.1×).
- **Quality may drop** — the paper saw −9 points on Q&A.
- **Our setup adds costs:** agents work in fresh worktrees/clones, so the index is stale or rebuilt per
  run; another tool schema to load; another prompt-injection surface (code comments); another index to
  keep current.

## The experiment (when we pick this up)

1. Plug **codebase-memory-mcp** or **CodeGraph** into `globex/engineer` only, via that agent's MCP
   config. The other engineers are the control. It's a read-only local MCP with no world side effects,
   so it doesn't need the gate.
2. Run 2 weeks. Before/after with `scripts/code-exploration-share.mjs` — turns per coding run, calls
   before first edit, exploration share — plus completion/outcome from the session reports.
3. Keep it only if turns drop **and** completion doesn't.

Cheaper first variant worth trying alongside (or instead): a per-repo **map** KB page (layout, entry
points, conventions) each engineer reads at the start of a run and updates at the end — targets the 20%
cross-run re-reading with no new infrastructure.

Open questions before starting:
- License of each candidate tool (not verified).
- Whether `globex/engineer` regularly needs cross-repo call tracing — if so, only Sourcegraph covers it.

## Re-running the measurement

```bash
node scripts/code-exploration-share.mjs 30 ~/.claude/projects <home>/runtime-accounts/claude-code/*/projects
```

Pass every `projects/` dir that holds agent transcripts — pooled runtime accounts keep their own. Output
is per-agent aggregates only (no transcript content). On a remote box, scp it over and run it with that
box's node ≥22.
