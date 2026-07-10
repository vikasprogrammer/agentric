# Agent OS

A generic operating system for running autonomous agents **safely, unattended, across multiple brands**.

Open-core: the **mechanisms** — kernel, governance, observability — are generic and shippable. Your
**agents, policies, connectors, and data** are brand-private plugins.

> Full design rationale: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## The one idea

> **Every side effect an agent has on the outside world passes through one mediated boundary — the
> gateway — that the OS controls.** Policy is checked there. Budget is debited there. Identity is
> asserted there. Idempotency is enforced there. Audit is written there.

Without that single chokepoint, Policy / Budgets / Approvals / Audit / Evaluation are unenforceable —
documentation, not controls. With it, you can leave an agent running and trust it. The rest of the
repo is built around making that boundary real.

```
Agent wants to act ──► [ GATEWAY ] ──► external system
                        1. Policy.classify  → green | yellow | red | deny
                        2. Approvals         → suspend run for yellow/red until a human decides
                        3. Budget            → hard-stop if over cap
                        4. Identity          → act as the run's principal
                        5. Idempotency       → dedupe retried effects (exactly-once)
                        6. Execute           → call the capability
                        7. Audit             → record action + reasoning + result
```

---

## Quickstart

```bash
npm install
npm run build
npm run serve      # web console + API → http://localhost:3010
npm run demo       # or: scripted 4-run governance demo in the terminal (no API keys)
npm run typecheck  # tsc --noEmit
```

### Web console

`npm run serve` (or `agent-os serve`) starts a zero-dependency web console — built on Node's
built-in `http`, no framework — where you can launch agents, **approve / reject** risky actions in a
human queue, and watch each run's live audit trail. Configure the port with `PORT` (default `3010`).
Deploy it behind a reverse proxy (nginx/Tailscale) for HTTPS; the app's own invite/cookie login gates
everything, so no extra basic-auth is needed. See `docs/process-per-tenant.md` (Mac/Tailscale) or the
Linux/systemd runbook in `CLAUDE.md`.

### Running on macOS vs Linux

The same single Node process fronts the app, the JSON API, **and the browser terminal** on both
platforms — the only native deps are `tmux` and `ttyd` (`brew install tmux ttyd` / your distro's
packages). Agent sessions run inside a **`tmux` server** that daemonises out of the Node process, so
they're designed to **outlive a server restart**: on boot the app re-adopts whatever tmux sessions are
still alive via the persistent socket at `<home>/tmux.sock` (it never re-spawns them). The difference
between the platforms is entirely in how the process supervisor treats that surviving tmux server.

- **macOS (dev / self-hosted).** Just `npm run serve`; nothing sits in front of the Node server — it
  reverse-proxies `/terminal/` (HTTP + the ttyd WebSocket) to a local `ttyd` itself, login-gated with
  the same per-session authz nginx enforces in prod. Under launchd there are no cgroups, so a restart
  signals only the main process and the daemonised tmux server (and every agent session) survives
  untouched. No extra configuration needed.

- **Linux + systemd (production).** systemd supervises the service as a **cgroup**, and two unit
  settings are **required** or a `systemctl restart` will silently kill every running agent session
  (they resurface as `crashed`) — a footgun macOS never exposes. The bundled
  [`agent-os.service`](agent-os.service) has both set correctly; if you write your own unit, mirror
  them:

  | Setting | Value | Why |
  |---|---|---|
  | `KillMode` | `process` | Default (`control-group`/`mixed`) SIGKILLs the **whole cgroup** on stop. A tmux daemon double-forks out of the process tree but **not** the cgroup, so it dies with the restart. `process` signals only the main PID and leaves the tmux server (and its sessions) running for the fresh process to re-adopt. |
  | `PrivateTmp` | `false` | `true` gives each service *invocation* a throwaway `/tmp`; a session surviving a restart would be pinned to the old, torn-down `/tmp` namespace and the `claude` CLI's `mkdir /tmp/claude-<uid>` fails with `ENOENT`. `false` shares the host's stable `/tmp`. |

  Front `/terminal/` with nginx `auth_request` → `/api/auth/me` (ttyd doesn't pass through the app in
  prod, so the app's shared-terminal proxy is inert there — don't leave the writable terminals
  ungated). Full runbook — nginx `X-Forwarded-*` handling, deploy steps, per-user uid isolation — is in
  `CLAUDE.md`; multi-tenant fan-out is in `docs/process-per-tenant.md`.

  > **Operational note:** because sessions now outlive the app, never run `tmux` against
  > `<home>/tmux.sock` as root (e.g. `sudo tmux`) — it leaves the socket root-owned and the
  > service (running as its own user) can no longer spawn sessions on it. If spawns start failing with
  > `Permission denied`, check `ls -la <home>/tmux.sock` — the owner must be the service user; if a
  > stale root-owned socket with no live server is there, remove it and the next spawn recreates it.

`npm run demo` exercises the whole trust layer against mock capabilities and prints the exact
append-only audit trail the gateway wrote for each run:

| Scenario | What it proves |
|---|---|
| **1. Green + retry** | Allowed actions run; an idempotent retry is **deduped** (effect fires once). |
| **2. Approvals** | `$49` refund → **yellow → head approves**; `$5000` refund → **red → owner declines** → blocked. |
| **3. Budget** | `$0.02` cap, `$0.01`/action → **hard-stop on the 3rd**. |
| **4. Policy deny** | `prod.*` is **denied outright**; the capability never executes. |

Durable audit is written to `data/audit/<tenant>/<run_id>.jsonl` — one append-only file per run.

### Login & team

The console is invite-gated. On first boot the **owner** is seeded automatically (set
`AGENT_OS_OWNER_EMAIL`, default `owner@localhost`) and a one-time magic-link login URL is printed to
the server console and `data/server.log`. Everyone else signs in via an invite link the owner/admins
generate. Three roles: **owner** (runs everything, approves red/`owner` requests, manages the team),
**admin** (approves yellow/`head` requests, manages team & assignments, runs any agent), and
**member** (runs only assigned agents, never approves). Manage it on the **Team** page, or from the box:

```bash
agent-os invite teammate@company.com member   # mint a magic link to copy/send
agent-os login-link you@company.com            # fresh link for an existing member (recovery)
agent-os members                               # list members + roles
```

State lives in a **per-workspace SQLite DB** (`<home>/agent-os.db`, via Node's built-in `node:sqlite` —
no new deps): members & sessions, agent assignments, connectors, terminal sessions, the inbox feed,
approvals, and an audit mirror. One DB per data home keeps instances isolated.

---

## Where agents live — software vs. data

`agent-os` (this repo) is the **software**. Your agents and their runtime state are **your data**,
and they live in a separate, configurable **data home** — so you can keep them in their own private
git repo and contribute to the open-source software without ever committing your agents.

```
agent-os/                      # the SOFTWARE (this repo; you contribute here)
  src/  web/  terminal/        #   the mechanism
  config/agents/example-*/     #   bundled example agents (read-only seeds/fixtures)
  config/policy/               #   bundled default policy

$AGENT_OS_HOME  (default ./data, gitignored — can be its OWN private repo)
  agents/<id>/                 #   YOUR agent = one folder
    agent.json   CLAUDE.md     #     definition (tracked)
    .claude/  memory/          #     runtime state Claude writes (gitignored)
  policy/default.policy.json   #   your policy override (optional; else the bundled one)
  audit/  *.log  tmux.sock     #   per-instance runtime
```

Resolution order for the home: **`$AGENT_OS_HOME`** → `home` in `agent-os.config.json` → `./data`.
On load, bundled example agents and your home's agents are both registered; **your agents win** on id.

```bash
agent-os init ./my-brand          # scaffold a data home (its own .gitignore + git repo + a starter agent)
AGENT_OS_HOME=./my-brand agent-os serve --port=3010
```

**Run several instances on one machine** — give each a distinct home + `PORT` (the tmux socket and
logs live *inside* the home, and `TTYD_PORT` defaults to `PORT+1`, so instances never collide):

```bash
AGENT_OS_HOME=./brand-a PORT=3010 agent-os serve
AGENT_OS_HOME=./brand-b PORT=3020 agent-os serve
```

### Multi-tenant — two models

A **tenant** is one workspace (its own DB, members, agents, connectors, audit). There are two ways to
run more than one; the **DB file is always the isolation boundary**.

- **Process-per-tenant (recommended).** Each tenant is its own self-contained `agent-os serve` process
  — the model above, with `AGENT_OS_TENANT` naming each one. Simplest and fully isolated. On a single
  host (e.g. a Mac Mini over Tailscale) front them with `scripts/run-tenant.sh` + `scripts/tailscale-serve.sh`;
  the full runbook is [`docs/process-per-tenant.md`](docs/process-per-tenant.md).

  ```bash
  scripts/run-tenant.sh acme   ~/aos/acme   3010  you@acme.com
  scripts/run-tenant.sh globex ~/aos/globex 3020  you@globex.com
  scripts/tailscale-serve.sh 3010 3020      # → separate https origins, clean cookie isolation
  ```

- **Many tenants in one process (`src/tenant-registry.ts`).** A registry builds one isolated runtime
  per tenant (own DB/tmux/ttyd/cron/Slack), routed by **subdomain** (`<slug>.<baseDomain>`) or the
  loopback `x-aos-tenant` header, listed in a control plane (`src/state/control.ts`). Provisioning is
  superadmin-only (`agent-os tenant create <slug> --owner <email>` / `POST /api/admin/tenants`, gated
  by `AOS_SUPERADMIN_TOKEN`). Needs wildcard DNS + a `baseDomain`; pick this when you outgrow a handful
  of tenants. The seed tenant (config `tenant`) keeps the legacy un-nested home, so existing installs
  need no migration. See [`docs/scoping-model.md`](docs/scoping-model.md).

### Opening Claude directly in an agent's folder

An agent's `runtime` (in `agent.json`) selects how a terminal session is driven:

- **`runtime: "mock"`** → the scripted `terminal/agent-runner.sh` demo (no API keys; shows the gate).
- **`runtime: "claude-code"`** → a **real `claude` session opened in the agent's own folder**
  (`$AGENT_OS_HOME/agents/<id>/`). `terminal/claude-launch.sh` `cd`s into the folder, writes a
  project-local `.claude/settings.json` wiring a **`PreToolUse` gate hook** (`terminal/gate-hook.sh`),
  and execs `claude` seeded with the task. Every `Bash` call the agent makes is classified by the same
  gateway — risky ones (`rm`, `deploy`, `prod`, `stripe`…) pause and surface as an inbox approval.

The bundled `sandbox` agent (created in `./data/agents/sandbox/` — i.e. your data, not committed)
demonstrates the `claude-code` path end to end.

#### Per-agent runtime tuning (model / effort / permission)

Each `claude-code` agent can pin its own **`model`**, **`effort`** (`low`…`max`), and **`permissionMode`**
(`default`/`acceptEdits`/`plan`/`auto`/`dontAsk`/`bypassPermissions`) in `agent.json` — editable from the
agent's console page (`GET/PUT /api/agents/:id/config`). Any field left blank inherits a **workspace
default** set once in **Settings → Runtime defaults** (`GET/PUT /api/settings/runtime-defaults`); a field
blank there too falls through to the `claude` CLI's own default. At launch the server resolves
agent → workspace → CLI default and `claude-launch.sh` maps the result onto `--model` / `--effort` /
`--permission-mode`. `permissionMode` only changes the **agent's own** prompt posture — the `PreToolUse`
gate hook still blocks risky effects for inbox approval underneath it, even under `bypassPermissions`
(which is why the headless automation lane can safely run `--dangerously-skip-permissions`).

> Swapping the foreign CLI (Codex/Gemini/etc.) is **not** wired up: the launcher seam is generic enough,
> but those CLIs have no `PreToolUse`-hook equivalent, so the gateway invariant would need an
> MCP-fronted-only or sandbox enforcement model first. See `docs/PILLARS.md` (Pillar 1).

---

## Repository layout

```
agent-os/
├── config/                     # BUNDLED examples that ship with the software
│   ├── agent-os.config.json    #   tenant, home, dirs, defaults
│   ├── policy/default.policy.json   # green/yellow/red/deny rules (policy is DATA)
│   └── agents/<id>/            #   example agent.json manifest + CLAUDE.md (seeds/fixtures)
│
├── terminal/                   # how a terminal session is driven + governed
│   ├── agent-runner.sh         #   runtime:mock  → scripted demo
│   ├── claude-launch.sh        #   runtime:claude-code → real claude, opened in the agent's folder
│   └── gate-hook.sh            #   PreToolUse gate the launched claude is wired to
│
├── src/home.ts                 # resolves the data home ($AGENT_OS_HOME → config → ./data)
│
├── src/
│   ├── types.ts                # the only contracts the core depends on
│   ├── kernel.ts               # composition root — wires everything (AgentOS, loadAgentOS)
│   ├── index.ts                # boot entrypoint
│   ├── demo.ts                 # the runnable demo above
│   │
│   ├── core/                   # ── Orchestrator: the Run lifecycle (the kernel)
│   │   ├── run.ts
│   │   └── orchestrator.ts
│   ├── gateway/                # ── THE mediated effect boundary
│   │   ├── gateway.ts          #    the 7-step pipeline
│   │   └── idempotency.ts
│   ├── governance/             # ── Trust plane
│   │   ├── policy.ts           #    rule engine (data-driven)
│   │   ├── approvals.ts        #    HITL queue + decision capture
│   │   ├── budget.ts           #    $/token caps + hard-stop
│   │   ├── identity.ts         #    act-as principal (≠ secrets)
│   │   └── audit.ts            #    append-only event store (system of record)
│   ├── observability/          # ── Did it stay alive? Did it work?
│   │   ├── monitor.ts          #    heartbeats / stale-run detection
│   │   └── evaluation.ts       #    outcome signal (feeds learning)
│   ├── capabilities/           # ── Plugin table: governable side effects
│   │   ├── registry.ts
│   │   └── examples.ts         #    echo / slack / stripe.refund / prod.restart (mocks)
│   ├── edge/                   # ── World ↔ system
│   │   ├── triggers.ts         #    WHEN a run starts (cron/webhook/manual)
│   │   └── secrets.ts          #    vault, namespaced per tenant+principal
│   ├── runtime/                # ── How an agent is driven
│   │   ├── mock-adapter.ts     #    deterministic, used by the demo
│   │   └── claude-code-adapter.ts  # reference sketch: claude --print + PreToolUse hook
│   └── state/
│       └── stores.ts           #    Tasks (state) · Memory (episodic) · Knowledge (semantic)
│
└── docs/ARCHITECTURE.md        # the full design
```

The split is deliberate and is also the **open-source seam**: `config/` + plugin implementations are
brand-private; everything in `src/` (minus the example plugins) is the generic core.

---

## Extending it

**Add a capability (a governable side effect).** Implement `Capability` and register it. The gateway
governs it automatically; the policy file decides its risk.

```ts
const sendInvoice: Capability = {
  id: 'billing.sendInvoice',
  description: 'Email an invoice to a customer',
  defaultRisk: 'yellow',
  estimateCost: () => ({ usd: 0.002, tokens: 0 }),
  async invoke(args, ctx) {
    const key = await ctx.secrets.get(ctx.run.tenant, ctx.run.principal, 'BILLING_API_KEY');
    // ... perform the effect using `key` ...
    return { ok: true, data: { invoiceId: 'inv_123' } };
  },
};
os.registerCapabilities([sendInvoice]);
```

**Change policy without touching code** — edit `config/policy/default.policy.json`:

```jsonc
{ "match": { "capability": "billing.sendInvoice", "when": { "arg": "amountUsd", "op": "gt", "value": 500 } }, "risk": "red" },
{ "match": { "capability": "billing.sendInvoice" }, "risk": "yellow" }
```

First match wins, so put the more specific (conditional) rule first.

**Add an agent** — drop `config/agents/<id>/agent.json` (+ `CLAUDE.md`) and register its behavior
(mock) or point it at the `claude-code` runtime.

**Wire a real agent** — implement the `claude-code` adapter (see `src/runtime/claude-code-adapter.ts`):
spawn `claude --print` *without* `bypassPermissions`, front dangerous tools via an OS-owned MCP server,
and gate the rest with a `PreToolUse` hook that calls `gateway.invoke`.

---

## Status — what's real vs. stubbed

This is a **starter**: the spine is real and runnable; the leaves are swappable stubs.

| Real & working | Reference stub (swap for prod) |
|---|---|
| Gateway 7-step pipeline | In-memory budget / approvals / idempotency (→ Postgres/Redis) |
| Policy engine (data-driven, glob + conditions) | `StubIdentity` (→ STS / scoped OAuth) |
| Append-only JSONL audit (per tenant/run) | `EnvSecretsVault` (→ Vault / SSM) |
| Run lifecycle + `waiting_approval` suspend/resume | In-memory Tasks/Memory/Knowledge (→ DB / vector store) |
| Budget hard-stop, idempotency dedupe | `ClaudeCodeAdapter` (reference sketch only) |
| Evaluation signal off the audit stream | Console is a snapshot (→ web cockpit) |
| Multi-tenant fields throughout | Triggers: manual only (→ cron/webhook/event bus) |

Deferred by design (build last, after Evaluation has data): **Dreaming / self-learning**.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §6–§7 for the maturity phases and the full gap map.

---

## License

MIT.
