<div align="center">

# 🛡️ Agentric

### Run autonomous AI agents unattended — without handing them the keys to everything.

Agentric is a self-hosted control plane for AI agents. Give an agent a job, walk away, and trust that
**every action it takes in the real world passes through one gate you control** — where risky moves
pause for your approval, budgets are enforced, and everything is written to a tamper-evident audit log.

[agentric.io](https://agentric.io)

[Quickstart](#-quickstart) · [Why Agentric](#-why-agentric) · [How it works](#-how-it-works) · [Features](#-features) · [Docs](#-documentation)

![status](https://img.shields.io/badge/status-pre--beta-orange)
![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![deps](https://img.shields.io/badge/runtime%20deps-zero-success)

</div>

---

## 🤔 Why Agentric

Letting an AI agent run on its own is easy. Letting it run on its own *safely* is the hard part —
today it means babysitting a terminal and hoping it doesn't run `rm -rf`, refund the wrong customer,
or burn your API budget at 3am.

Agentric puts a **governed boundary** between your agents and the outside world, then wraps it in a
web console you can actually run a team from:

- **Leave agents running.** Risky actions suspend and wait for a human — the run resumes the moment you
  approve, from your Inbox, Slack, or Discord.
- **Stay in control.** One policy file (or the in-console editor) decides what's auto-allowed, what needs
  sign-off, and what's forbidden. Budgets hard-stop runaway spend.
- **Know exactly what happened.** Every effect — with the agent's reasoning and result — lands in an
  append-only audit log.
- **Run a whole fleet.** Reach any agent by name from Slack or Discord, hand work to a shared task queue,
  and let agents build shared memory and a living knowledge base as they go.

It runs on your laptop with `npm run serve`, and scales to a multi-tenant server behind Tailscale or nginx.

---

## ⚡ Quickstart

```bash
git clone https://github.com/vikasprogrammer/agentric
cd agentric
npm install && npm run build
npm run serve          # → web console at http://localhost:3010
```

Open **http://localhost:3010**. On first boot an owner login link is printed to the console (and
`data/server.log`) — click it and you're in.

Want to see the governance layer without any API keys first?

```bash
npm run demo           # a scripted run that shows approvals, budgets, dedupe & policy denies
```

> **Running real agents** needs [Claude Code](https://claude.com/claude-code) (or Codex) installed, plus
> `tmux` + `ttyd` for the browser terminal (`brew install tmux ttyd`, or your distro's packages).

> **A note on the name.** The product is **Agentric**; the plumbing is still called `agent-os` — the
> npm package and CLI (`agent-os serve`), the `AGENT_OS_*` env vars, the service units and the data
> home. Those are baked into running deployments, so they keep the old name on purpose.

---

## 💡 The core idea

Everything in Agentric rests on a single rule:

> **Every side effect an agent has on the outside world passes through one mediated gateway.**

That gateway is the whole trust story. Remove it and policies, budgets, and audit logs are just
documentation. Keep it, and you can walk away from a running agent.

```
  Agent wants to act  ──►  ┌─────────── THE GATEWAY ───────────┐  ──►  the real world
                           │                                    │
                           │  1. 🏷️  Classify    green / yellow / red / deny
                           │  2. ✋ Approve     pause for a human on risky calls
                           │  3. 💰 Budget      hard-stop if over the cap
                           │  4. 🪪 Identity    act as the run's principal
                           │  5. 🔁 Dedupe      retried effects fire exactly once
                           │  6. ⚙️  Execute     actually call the capability
                           │  7. 📜 Audit       record action + reasoning + result
                           └────────────────────────────────────┘
```

When an agent tries something risky — `rm`, a deploy, a Stripe refund, anything touching prod — the
gateway **pauses the run** and drops an approval card in your Inbox (and DMs whoever can approve it).
Approve or reject; the run picks up right where it left off.

---

## ✨ Features

| | |
|---|---|
| 🧑‍✈️ **Web console** | Launch agents, watch live sessions in a browser terminal, and approve or reject risky actions from one queue. Zero-dependency Node server — no framework, no database service to run. |
| ✋ **Human-in-the-loop approvals** | Risky calls suspend the run and wait. Approve from the Inbox, Slack, or Discord — and "Always approve" teaches the policy so you're not asked twice. |
| 📜 **Tamper-evident audit** | Every effect is written to an append-only JSONL log plus a queryable console viewer — filter by session, type, or who did it. |
| 🎛️ **Policy engine** | A simple JSON rule engine (glob + conditions) with an in-console editor and live hot-reload. Decides green / needs-approval / denied per capability. |
| 💰 **Budgets** | Per-run dollar/token caps that hard-stop an agent before it overspends. |
| 💬 **Slack & Discord native** | Talk to your fleet by name (`/pod-troubleshooter …`) straight from chat — no public URL, no per-agent setup. Threads keep context across replies. |
| ⏰ **Automations** | Cron, webhook, and chat triggers spawn governed agent sessions unattended — running as the person who triggered them. |
| 🧠 **Memory & Knowledge Base** | Agents remember across runs (`recall`/`remember`) and co-author a living, versioned wiki with your team. |
| ✅ **Shared task queue** | A Kanban backlog humans and agents drain together — assign a task to an agent and it auto-dispatches a governed session to do the work. |
| 🌱 **Self-learning** | A periodic "reflect" pass mines recent runs for lessons, distills guidance back into agent prompts, and proposes config improvements for you to apply. |
| 👥 **Teams & roles** | Magic-link login, owner / admin / member roles, per-agent assignment, and approval levels that map to real people. |
| 🔐 **Secrets vault** | Encrypted-at-rest credentials injected into agent shells and connectors — handed out by key name, never leaked into logs or approval cards. |
| 🎨 **Media & tools** | Image/video generate, edit, and understand; publish finished deliverables to a governed Library; host small agent-built apps. |

Full pillar-by-pillar status lives in [`docs/PILLARS.md`](docs/PILLARS.md).

---

## 🤝 Humans and agents, on the same team

Agentric isn't a fire-and-forget bot runner. Agents and people share the same task queue, the same
knowledge base, and the same approval loop — so work flows back and forth instead of over a wall.

- **A shared task queue.** A Kanban backlog humans and agents drain together. Assign a task to an agent
  and it **auto-dispatches a governed session** to do the work; the agent closes its own ticket when done.
- **A living knowledge base.** A tenant-wide wiki that agents and teammates **co-author** — every edit
  versioned and revertable, so shared context keeps growing instead of going stale.
- **Approvals that loop you in.** When an agent hits something risky it doesn't guess — it pauses and
  asks. You decide from the Inbox, Slack, or Discord, and the run continues on your call.
- **Agents that hand off to each other.** An agent can delegate to a teammate agent (support hands a fix
  to coding) while the **accountable human stays attached** the whole way through, and shared memory
  carries the context across the hop.

Roles keep it orderly: magic-link login, **owner / admin / member**, per-agent assignment, and approval
levels that map to real people on your team.

---

## 🔍 How it works

**Agents are folders.** Each agent is a directory with an `agent.json` manifest and a `CLAUDE.md`
system prompt. Point it at the `claude-code` runtime and Agentric opens a real Claude session *inside
that folder* — with a `PreToolUse` gate hook wired in, so every command the agent runs is classified by
the same gateway.

**Software vs. your data.** This repo is the **software**. Your agents, policies, and their runtime
state are **your data**, living in a separate, configurable **data home** — keep them in their own
private repo and contribute to the open-source software without ever committing your agents.

```
agent-os/                        # the SOFTWARE (this repo — you contribute here)
  src/  web/  terminal/          #   kernel, gateway, console, session runners
  config/agents/example-*/       #   bundled example agents

$AGENT_OS_HOME  (default ./data — can be its OWN private repo)
  agents/<id>/                   #   YOUR agent = one folder
    agent.json  CLAUDE.md        #     definition
    .claude/  memory/            #     runtime state the agent writes
  policy/default.policy.json     #   your policy (optional override)
  audit/  agent-os.db  tmux.sock #   audit log, SQLite state, live sessions
```

Scaffold your own home and run it:

```bash
agent-os init ./my-brand
AGENT_OS_HOME=./my-brand agent-os serve --port=3010
```

Everything the console touches persists in **one SQLite file per data home** (via Node's built-in
`node:sqlite` — no database service to install). One home + one port = one fully isolated instance;
run several side by side, or fan out to many tenants — see [`docs/scoping-model.md`](docs/scoping-model.md).

---

## 🛠️ Extending it

**Add a capability** — implement `Capability` and register it. The gateway governs it automatically;
the policy file decides its risk.

```ts
const sendInvoice: Capability = {
  id: 'billing.sendInvoice',
  description: 'Email an invoice to a customer',
  defaultRisk: 'yellow',
  estimateCost: () => ({ usd: 0.002, tokens: 0 }),
  async invoke(args, ctx) {
    const key = await ctx.secrets.get(ctx.run.tenant, ctx.run.principal, 'BILLING_API_KEY');
    // ... perform the effect ...
    return { ok: true, data: { invoiceId: 'inv_123' } };
  },
};
os.registerCapabilities([sendInvoice]);
```

**Change policy without touching code** — edit the JSON. First match wins, so put the specific rule first:

```jsonc
{ "match": { "capability": "billing.sendInvoice", "when": { "arg": "amountUsd", "op": "gt", "value": 500 } }, "risk": "red" },
{ "match": { "capability": "billing.sendInvoice" }, "risk": "yellow" }
```

---

## 🚀 Deployment

- **Local / self-hosted (macOS or Linux):** `npm run serve` — a single Node process fronts the app, API,
  and browser terminal. Put it behind Tailscale or nginx for HTTPS; the built-in cookie login gates
  everything, so no extra basic-auth is needed.
- **Production (Linux + systemd):** the bundled [`agent-os.service`](agent-os.service) is configured so
  agent sessions survive a restart. A few nginx/systemd gotchas will bite if you hand-roll your own unit
  — they're all documented, with fixes, in [`CLAUDE.md`](CLAUDE.md).
- **Multi-tenant:** run a process per tenant ([`docs/process-per-tenant.md`](docs/process-per-tenant.md))
  or many tenants in one process routed by subdomain ([`docs/scoping-model.md`](docs/scoping-model.md)).

---

## 📚 Documentation

| Doc | What's in it |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The full design rationale and the gateway spine |
| [`docs/PILLARS.md`](docs/PILLARS.md) | Every product pillar and its real implementation status |
| [`docs/governance-model.md`](docs/governance-model.md) | Policy, approvals, budgets, identity — the trust plane |
| [`docs/agent-mcp-tools.md`](docs/agent-mcp-tools.md) | The full set of tools agents can call (memory, tasks, KB, chat…) |
| [`docs/memory-model.md`](docs/memory-model.md) | How agents capture, recall, distill, and apply what they learn |
| [`docs/process-per-tenant.md`](docs/process-per-tenant.md) | Running multiple isolated tenants |
| [`CLAUDE.md`](CLAUDE.md) | Build/run/test notes and the production deployment runbook |

---

## 📄 License

[MIT](LICENSE) — the mechanisms (kernel, gateway, governance, console) are open and yours to build on.
