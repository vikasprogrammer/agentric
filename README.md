<div align="center">

# Agentric

### Run AI agents unattended, without handing them the keys to everything.

Agentric is a self-hosted control plane for AI agents. Give an agent a job and walk away. Everything it
does in the real world goes through one gate you control: risky moves pause for your approval, budgets
are enforced, and every effect lands in an append-only audit log.

[agentric.io](https://agentric.io)

[Quickstart](#quickstart) · [How it works](#the-one-rule) · [Features](#features) · [Docs](#documentation)

![status](https://img.shields.io/badge/status-pre--beta-orange)
![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![deps](https://img.shields.io/badge/runtime%20deps-zero-success)

<br>

<img src="docs/assets/console-overview.jpg" alt="Agentric console: live agent sessions, what is blocked on a human, and who is online" width="900">

<sub>The Overview: every running agent, what finished, and what is waiting on you.</sub>

</div>

---

## Why it exists

Letting an agent run on its own is easy. Letting it run on its own *safely* is the hard part — which
usually means babysitting a terminal and hoping it doesn't `rm -rf`, refund the wrong customer, or burn
the budget at 3am.

Agentric puts a governed boundary between your agents and the outside world, and a console around it
you can run a team from. You leave agents running; risky calls suspend until a human answers in the
Inbox or by Slack/Discord DM, then the run resumes. One policy decides what is auto-allowed, what needs
sign-off, and what is refused outright. Everything is logged. Agents share a task queue, a knowledge
base and a memory with the people they work with.

Runs on a laptop with `npm run serve`; scales to a multi-tenant box behind Tailscale or nginx.

---

## Quickstart

```bash
git clone https://github.com/vikasprogrammer/agentric
cd agentric
npm install && npm run build
npm run serve          # console at http://localhost:3010
```

First boot prints an owner login link to the console and `data/server.log`; click it and a setup wizard
walks the rest — runtime credential, company context, chat channel, GitHub, memory, team, first agents.
`npm run demo` shows the governance layer before you wire up any keys.

Real agents need [Claude Code](https://claude.com/claude-code), Codex or opencode (Settings → Runtime
installs them for you), plus `tmux` and `ttyd` for the browser terminal.

*On the name:* the product is Agentric, the plumbing is still `agent-os` — the npm package and CLI
(`agent-os serve`), `AGENT_OS_*` env vars, service units and data home. Live deployments have those
baked in, so they keep them.

---

## The one rule

> Every side effect an agent has on the outside world passes through one mediated gateway.

That gateway is the whole trust story. Remove it and policy, budgets and audit are just documentation.

```
  Agent wants to act  --->  +--------- THE GATEWAY ----------+  --->  the real world
                            |                                |
                            |  1. Classify   green / yellow / red / deny
                            |  2. Approve    pause for a human on risky calls
                            |  3. Budget     hard-stop if over the cap
                            |  4. Identity   act as the run's principal
                            |  5. Dedupe     retried effects fire exactly once
                            |  6. Execute    actually call the capability
                            |  7. Audit      record action, reasoning and result
                            +--------------------------------+
```

Hit something risky — `rm`, a deploy, a Stripe refund, anything touching production — and the run
suspends with an approval card in your Inbox and a DM to whoever can clear it. Answer, and it picks up
where it left off.

Real CLI agents go through the same gate: a session runs in the agent's own folder with a `PreToolUse`
hook wired in, so every shell command and MCP tool call is classified by the same policy engine as a
native capability.

<div align="center">

<img src="docs/assets/console-session.jpg" alt="Agentric console: a live agent session in the browser terminal, with other running sessions in tabs alongside it" width="900">

<sub>A live session in the browser terminal — a real CLI agent in a tmux pane you can watch, take over,
and hand back.</sub>

</div>

---

## Features

### Governance and trust

| | |
|---|---|
| **Mediated gateway** | One boundary for every effect — native capabilities and CLI tool calls alike. |
| **Policy engine** | JSON rules by capability glob plus argument conditions (`amountUsd > 1000`), first match wins, risk classes green/yellow/red/deny. Edited in the console, hot-reloaded into live sessions. |
| **Approvals** | A risky call blocks until a person answers in the Inbox or by Slack/Discord DM. "Always approve" registers that one action *shape*, not the capability, and is revocable. |
| **History and proposals** | Every policy edit is a revertable revision. Agents may propose tightening-only changes; loosening and new allows are refused by construction, and an owner still approves. |
| **Budgets** | Per-run dollar and token caps that stop an agent before it overspends. |
| **Audit trail** | Append-only JSONL per run, mirrored into SQLite, browsable by session, type and principal. |
| **File-write guard** | Engine-level, not just policy: crown jewels always denied, writes outside the working directory routed to approval. |
| **Secrets vault** | AES-256-GCM at rest, resolved into connectors and agent shells at launch. An agent can request a credential, or a rotation, without a value touching the transcript. |
| **Identity and run-as** | Each session records who triggered it and who it acts as; a linked GitHub account authors commits and PRs as the real human. |
| **Teams and roles** | Magic-link login, owner/admin/member, per-agent assignment, approval levels mapped to real people. |

### Running agents

| | |
|---|---|
| **Agents are folders** | An `agent.json` manifest plus a `CLAUDE.md` prompt, managed from the console or the CLI. |
| **Three runtimes** | Claude Code, Codex and opencode under the same gate; call sites probe declared runtime capabilities, so a runtime lacking attach or resident chat degrades cleanly. |
| **Runtime management** | Install a missing CLI from Settings, pick the runtime per agent, and hear when the runtime — or Agentric — has fallen behind, with a one-tap owner update. |
| **Browser terminal** | Sessions are tmux panes in the console behind the same login: watch a run, take it over losslessly, hand it back, or reopen a finished one and resume. |
| **Two lanes** | Unattended runs are attachable TUIs closed at turn end unless a human took over, a person is blocking, or background work is live; interactive runs stay until closed, with age ceilings and idle reaping. |
| **Per-agent tuning** | Model, effort, permission mode and output style resolve manifest → workspace default → CLI default. Skills and OS tools take allowlists that shape context, never the gate. |
| **Session lifecycle** | Status comes from runtime hooks, not guesswork — running, blocked, rate-limited, crashed — and dead panes get reaped. |
| **Hand-off chains** | Runs fold into conversations and nest under the caller that delegated them; a chain rail shows the tree and answers a delegate's question in place. |
| **Self-improving agents** | An agent edits its own prompt and reverts a bad self-edit. Cross-agent edits route by the proposer's maturity — refused, human-approved, or auto-applied at the top tier, always revertable. |

### Work

| | |
|---|---|
| **Goals** | The strategic layer above tasks; progress is derived from the tasks linked to them. |
| **Task queue** | A Kanban backlog humans and agents drain together — priority, labels, assignee, owner, due dates, dependencies, and an activity log naming every agent that worked it. |
| **Delegation** | An agent-assigned task auto-dispatches a governed session. `task_wait` makes the hand-off synchronous, poke-back resumes the caller when the delegate finishes. |
| **Task discussion** | A thread on the task where `@mentions` DM a person or resume an agent, and a human's reply is typed into the live run. |
| **Automations** | Cron, webhook, Slack, Discord, Telegram and ClickUp triggers spawn sessions unattended, as the person who triggered them, with a pile-up guard. Agents can schedule a future run of themselves. |
| **Inbox** | One feed for approvals, questions, progress and proposals — per-member read state, addressed cards also DM'd. `ask_human` blocks a run until someone answers. |
| **Library** | Deliverables (Markdown, PDF, images, video) published into a governed gallery, snapshotted and scoped by provenance. |
| **Apps** | Small server-side apps built by humans or agents, supervised behind the login-gated proxy, with default-deny capabilities, secrets, scale-to-zero and custom domains. |

### Knowledge and learning

| | |
|---|---|
| **Memory** | Per-agent and shared `remember`/`recall`, with `revise`/`forget`, over three live-switchable backends (SQLite, libSQL vectors, automem). |
| **Recall quality** | FTS5 keyword search, optional hybrid semantic recall (OpenAI-compatible or Ollama embeddings), recency/importance re-ranking, retrieval reinforcement, scheduled prune and dedupe, and a launch preamble ranked against the task. |
| **Episodic self-query** | An agent lists its own past runs and reopens one as a timeline or recap. |
| **Knowledge base** | A tenant-wide wiki agents and humans co-author, markdown on disk with an FTS mirror; every write is a revertable revision. |
| **Skills** | A `.claude/skills` library synced into agents at launch and scoped per agent, imported from a catalog, a GitHub repo, skills.sh or a zip. Agents find and request skills, and draft their own playbooks; only a human publishes one. |
| **Insights** | A reflect pass compounds episodes, outcomes and friction into cumulative state, writes a living KB page, injects distilled guidance into prompts, and proposes config changes. Interventions get before/after measurement with a sample size — correlational, and it says so. |
| **Company context** | One markdown document appended to every agent's prompt. |

### Integrations and operations

| | |
|---|---|
| **Slack, Discord, Telegram** | Native, each over an outbound socket, so a private box with no public URL works. Mentions and DMs fire automations as the sender and threads keep context; Slack automations filter on content and can watch a channel nobody @mentions. |
| **Chat router** | A message matching no automation still reaches the fleet — address any agent by name (`/pod-troubleshooter why is pod X down`). Agents can also post or DM proactively, audited rather than gated. |
| **MCP connectors** | stdio and remote MCP servers materialised per session, every call classified by the gate. Composio fronts 850+ apps behind a per-launch URL scoped to the acting member. |
| **GitHub per member** | A member's own token overrides the bot's for their runs; a stale one is recovered mid-run. |
| **Media** | Image generation and editing, text-to-video, image-to-video and video understanding — outputs land in the Library, cost-metered and audited. |
| **Zero runtime dependencies** | A plain Node HTTP server and built-in `node:sqlite`; one SQLite file per data home, no database service. |
| **Software and data are separate** | This repo is the software; your agents, policy, audit and state live in a data home that can be its own private repo. |
| **Multi-tenancy** | One process per tenant, or many in one process routed by subdomain — the DB file is the boundary either way. |
| **Self-hosted anywhere** | macOS or Linux: a laptop, a Mac Mini behind Tailscale, or a hardened systemd box behind nginx, with optional per-user OS isolation on Linux. |
| **Console** | Overview, Inbox, Agents, Sessions, Cockpit, Chat, Goals, Tasks, Library, Automations, Knowledge, Memory, Insights, Skills, Apps, Connections, Team, Files, Audit, Settings — plus an in-app manual. |

Pillar-by-pillar status, gaps included, is in [`docs/PILLARS.md`](docs/PILLARS.md); every tool agents can
call is in [`docs/agent-mcp-tools.md`](docs/agent-mcp-tools.md).

---

## How it works

Each agent is a directory. Point it at a runtime and Agentric opens a real CLI session inside that
folder with the gate hook wired in. The software is this repo; your agents and state live elsewhere, so
you can contribute here without ever committing your fleet.

```
agent-os/                        # the software (this repo, where you contribute)
  src/  web/  terminal/          #   kernel, gateway, console, session runners
  config/agents/example-*/       #   bundled example agents

$AGENT_OS_HOME  (default ./data, can be its own private repo)
  agents/<id>/                   #   your agent is one folder
    agent.json  CLAUDE.md        #     definition
    .claude/  memory/            #     runtime state the agent writes
  policy/default.policy.json     #   your policy (optional override)
  audit/  agent-os.db  tmux.sock #   audit log, SQLite state, live sessions
```

```bash
agent-os init ./my-brand
AGENT_OS_HOME=./my-brand agent-os serve --port=3010
```

One home plus one port is one isolated instance. Run several side by side, or fan out to many tenants —
see [`docs/scoping-model.md`](docs/scoping-model.md).

---

## Extending it

Implement `Capability` and register it; the gateway governs it automatically and policy decides its
risk.

```ts
const sendInvoice: Capability = {
  id: 'billing.sendInvoice',
  description: 'Email an invoice to a customer',
  defaultRisk: 'yellow',
  estimateCost: () => ({ usd: 0.002, tokens: 0 }),
  async invoke(args, ctx) {
    const key = await ctx.secrets.get(ctx.run.tenant, ctx.run.principal, 'BILLING_API_KEY');
    return { ok: true, data: { invoiceId: 'inv_123' } };
  },
};
os.registerCapabilities([sendInvoice]);
```

Policy needs no code — first match wins, so the specific rule goes first:

```jsonc
{ "match": { "capability": "billing.sendInvoice", "when": { "arg": "amountUsd", "op": "gt", "value": 500 } }, "risk": "red" },
{ "match": { "capability": "billing.sendInvoice" }, "risk": "yellow" }
```

---

## Deployment

- **Local or self-hosted:** `npm run serve` is one Node process fronting the app, the API and the
  browser terminal. Put Tailscale or nginx in front for HTTPS — the cookie login gates everything, so
  no extra basic auth.
- **Linux with systemd:** the bundled [`agent-os.service`](agent-os.service) keeps sessions alive across
  a restart. The nginx and systemd traps that bite anyone hand-rolling a unit are documented with fixes
  in [`CLAUDE.md`](CLAUDE.md).
- **Multi-tenant:** a process per tenant ([`docs/process-per-tenant.md`](docs/process-per-tenant.md)) or
  many in one process routed by subdomain ([`docs/scoping-model.md`](docs/scoping-model.md)).

---

## The status line, on any machine

Every governed TUI carries a status line: branch or agent id, folder, model and effort, context meter,
weekly usage, cost, diff churn — plus the two things only Agentric knows, the human the run acts as and
how many approvals it's blocked on. The same renderer works in a plain `claude` session Agentric never
launched — no checkout, no install:

```bash
curl -fsSL https://raw.githubusercontent.com/vikasprogrammer/agentric/main/scripts/install-statusline.sh | bash
# undo, restoring whatever status line you had:  … | bash -s -- --uninstall
```

It points your `settings.json` → `statusLine` at the copied renderer, leaves other keys alone, and backs
the file up first. Outside Agentric the governance half stays silent and the bar leads with git.

---

## Documentation

| Doc | What is in it |
|---|---|
| [`web/src/docs/use-cases.md`](web/src/docs/use-cases.md) | What to automate first — proven agent shapes, triggers and safety postures (also in the console under **Docs → Use cases**, with a one-click "create this agent") |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The design rationale and the gateway spine |
| [`docs/PILLARS.md`](docs/PILLARS.md) | Every product pillar and its real implementation status |
| [`docs/governance-model.md`](docs/governance-model.md) | Policy, approvals, budgets, identity |
| [`docs/agent-mcp-tools.md`](docs/agent-mcp-tools.md) | Every tool agents can call, with its route and governance notes |
| [`docs/memory-model.md`](docs/memory-model.md) | How agents capture, recall, distil and apply what they learn |
| [`docs/tasks-plan.md`](docs/tasks-plan.md) | The task queue, dispatch and delegation model |
| [`docs/connectors/`](docs/connectors/) | Per-connector reference for every native integration |
| [`docs/codex-runtime.md`](docs/codex-runtime.md) · [`docs/opencode-runtime.md`](docs/opencode-runtime.md) | Running the other two runtimes under the same invariant |
| [`docs/process-per-tenant.md`](docs/process-per-tenant.md) | Running multiple isolated tenants |
| [`CLAUDE.md`](CLAUDE.md) | Build and run notes plus the production deployment runbook |

---

## License

[MIT](LICENSE). The mechanisms — kernel, gateway, governance, console — are open and yours to build on.
