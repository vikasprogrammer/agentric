# Host / Network Connections — Phase 2 of the access model (scoping plan)

> **Status: scoping (2026-07-09).** This is a design plan, not shipped work. It builds on the north-star
> [`access-model.md`](./access-model.md) and depends on the governance decision layer described in
> [`governance-model.md`](./governance-model.md). Several load-bearing choices are still open — see
> **§7 Open decisions**; they change the shape of the build and are the user's to make before code.

## 1. Goal

Make **reaching a host — SSH, an internal HTTP service, a database — a first-class, governed
Connection** instead of what it is today: opaque `Bash` text that the enricher regex-scans for the
words `prod`/`kubectl`/etc. This is Phase 2 of the access-model reframe and it delivers the **Host**
shape that Phase 1 deliberately deferred (the Connections page today only has Tool-shaped rows).

Concretely, when an agent runs `ssh deploy@prod-box`, `curl http://10.0.0.5/admin`, or
`psql -h db.internal …`, we want the gate to see a **`net.connect` / `ssh.exec`** capability with a
real **target** (host, port, protocol) — so Policy / Approvals / Budget / Audit apply the same way
they do to `email.send` today, and so the accountable human can say *"this agent may reach staging but
not prod."*

## 2. The honest constraint (read this first — it bounds everything below)

**The gate hook governs a tool CALL, not a network packet.** It runs as a `PreToolUse` hook on the
`Bash` tool, receives the command *string*, and returns allow/deny (`terminal/gate-hook.sh:46,57`).
The shell it guards is **not sandboxed** on macOS local mode. So there are two very different ceilings,
and we must be explicit about which one we're buying:

- **Level 1 — Policy governance (best-effort, defeatable).** Parse the command, extract the target
  host, classify `net.connect`/`ssh.exec`, check it against a list, and allow/ask/deny. This is
  *exactly the same posture as the rest of the OS* — `destructive`, `amountUsd`, `emailExternal` are
  all best-effort facts parsed from arguments; a determined agent can obfuscate any of them
  (`H=prod-box; ssh deploy@$H`, IP instead of DNS, a wrapper script, a raw socket). It is a
  **governance and audit** layer, not a firewall. Honest framing: it stops *casual/accidental* and
  *policy-visible* access, and it records intent; it does not *contain* a hostile agent.
- **Level 2 — Kernel containment (un-bypassable, Linux-only).** Real enforcement means an egress
  allow-list at the OS: per-session `nftables`/network-namespace rules under the existing
  `AOS_UID_ISOLATION` path (`src/edge/launcher.ts`, systemd DynamicUser). Only here can "may not reach
  prod" be a guarantee rather than a policy. No macOS equivalent.

**Decision (confirmed 2026-07-09):** Phase 2 = **Level 1**, consistent with the OS's stated posture
("the OS is not a sandbox; governance is policy + approval + audit"). Level 2 is a real follow-up
(**Phase 2d**), gated behind uid-isolation, named so we don't over-promise. Everything in §3–§6 is
Level 1.

## 3. The four extension seams

The governance machinery already has clean seams for each piece (verified against current `main`,
v0.71.0). The `email.send` flow is the working precedent: a `shell`-ish attempt gets **reclassified to
a real capability after enrichment**, then hits a dedicated policy rule (`terminal.ts:1169-1180`).

### 3a. Data model — a new `hosts` table (not the connectors table) *(confirmed)*

A Host connection is `{ name, scope, owner, target-matcher, protocol, credential-ref, posture }`. This
does **not** fit the `connectors` table, which is MCP-shaped (transport/command/url/headers/env) and
whose `kind:'mcp'` discriminator is TS-only and hardcoded — nothing branches on it, so overloading it
means retrofitting `kind` guards through every consumer (`mcpConfig`, `dynamic`, `redact`, `boundTo`).
Cleaner: a dedicated `hosts` table that **mirrors the connectors ownership model**
(`scope: org|personal`, `owner_member_id`, `shared`) so org hosts apply fleet-wide and personal hosts
only in their owner's sessions.

Proposed columns:

| column | meaning |
|---|---|
| `id`, `name`, `enabled` | identity |
| `scope` / `owner_member_id` / `shared` | same ownership semantics as connectors |
| `match` | the destination matcher: hostname glob (`*.internal.example.com`), CIDR (`10.0.0.0/8`), or exact `host[:port]` |
| `protocol` | `ssh` \| `http` \| `postgres` \| `any` (informational + narrows matching) |
| `credential` | optional vault key ref (SSH private key / password) injected at launch |
| `posture` | `allow` \| `ask` \| `never` — the default tier for reaching this host (overridable by policy) |

### 3b. Host extraction — in the enricher (`src/governance/enricher.ts`)

A new dedicated block in the `isShell` branch (`enricher.ts:124-136`), beside the `destructive`/`risky`
computation. It recognises the **egress verbs** — `ssh`, `scp`, `sftp`, `rsync`, `curl`, `wget`,
`psql`, `mysql`, `nc`/`ncat`, `telnet`, `mongo`, `redis-cli` — and extracts `{ host, port, protocol }`
from the command. It emits facts:

- `netEgress: true` — the command looks like an outbound connection.
- `host`, `hostPort`, `netProtocol` — the parsed target (when extractable).
- `hostUnknown: true` — looks like egress but the host couldn't be parsed (variable, subshell, pipe).
- `hostAllowed: boolean` — did `host` match any granted host matcher? Computed **here** because policy
  `when` predicates only do scalar compares, not set-membership (`policy.ts:166-184`).

The agent's granted host matchers are passed **into** `enrichArgs` like `orgDomains`/`enrichPatterns`
already are (the enricher is pure/no-I/O); `gate()` fetches them and threads them through
(`terminal.ts:1166`). The matcher itself is a small hostname-glob + CIDR routine.

> **This block is the whole risk surface.** Bash is adversarial to parse. The design principle:
> **parse conservatively, fail loud.** We do not try to be a shell interpreter — we detect the common
> forms and, when we *can't* be sure (`hostUnknown`), we escalate rather than wave through (see §3d).

### 3c. Capability reclassification — in `gate()` (`src/terminal.ts`)

Mirroring the `email.send` rewrite at `terminal.ts:1169`: after enrichment, if `netEgress`, rewrite
`capability` from `shell.exec` to:

- **`ssh.exec`** for `ssh`/`scp`/`sftp`/`rsync`-over-ssh — highest risk (remote code execution on
  another box).
- **`net.connect`** for everything else (http/db/socket).

Then the existing enricher guards that key on `capability === 'shell.exec'` / `.startsWith('connector')`
(`enricher.ts:118-135,182,216`) get a small update so the new caps carry the shell fact-set. No
capability registry exists to touch — the strings are free-form literals (§6 of the map).

### 3d. Policy rules — `config/policy/default.policy.json`

New default rules. The **fail-closed** handling of `hostUnknown` is the important one:

```jsonc
// reaching a host we can't identify, but that looks like egress → pause (don't silently allow)
{ "match": { "capability": "net.connect|ssh.exec", "when": { "arg": "hostUnknown", "op": "eq", "value": true } }, "action": "ask", "approver": "admin" }
// reaching a KNOWN host that isn't on the agent's granted list → pause (or never, per posture)
{ "match": { "capability": "ssh.exec",   "when": { "arg": "hostAllowed", "op": "eq", "value": false } }, "action": "ask", "approver": "owner" }
{ "match": { "capability": "net.connect", "when": { "arg": "hostAllowed", "op": "eq", "value": false } }, "action": "ask", "approver": "admin" }
// granted hosts fall through to allow (still audited)
```

This composes with `governance-model.md`'s four-input decision: `target` = the host, blast-radius =
prod vs staging (a host's `posture: never` becomes a hard deny regardless of grant).

**Per-agent `netMode` (confirmed posture model).** A new `AgentManifest` field
`netMode: 'open' | 'allowlist'`, default **`open`**, drives how strict the rules above are for that
agent — resolved at gate time and threaded into enrichment like the host grants:

- **`open` (default) — guard-sensitive.** Unlisted, public-internet egress (`curl api.stripe.com`)
  stays plain `shell.exec`, ungoverned, exactly as today. Only **listed hosts** and
  **internal-looking targets** (RFC-1918 IPs, `.internal`/`.local`) reclassify to
  `net.connect`/`ssh.exec` and hit the rules above. Low friction globally; governs what matters.
- **`allowlist` (opt-in lockdown) — deny-by-default.** *Any* detected egress whose host isn't in the
  agent's granted set → `net.connect`/`ssh.exec` with `hostAllowed:false` → ask/deny. For a locked-down
  agent (e.g. one that touches prod), the enricher marks `netEgress` targets and the `hostAllowed:false`
  rules apply even to public hosts.

The enricher decides *whether a target is governable at all* from `netMode` + the internal-looking
heuristic; the `hostAllowed`/`hostUnknown` facts and the §3d rules are shared by both modes.

### 3e. Credential injection — reuse the `injectShellSecrets` path

A Host connection's `credential` (SSH key / password) reaches the shell via the **existing vault→env
launch pattern** (`injectShellSecrets`, `terminal.ts:1850`, audited `shell.secret.injected`). For SSH
specifically, at launch we materialise the key to a session-scoped `0600` file and write a small
`~/.ssh/config` stanza (`Host <match> → IdentityFile …`) so `ssh` authenticates without the agent ever
seeing the key bytes. Same audit event, same opt-in-per-agent posture. This also folds today's raw
`shellSecrets` SSH-key hack into a first-class, host-scoped grant.

## 4. UX — the Host shape lands on the Connections page

Phase 1 shipped the **Connections** page with a deferred Tool/Shell/Host shape facet. Phase 2 fills it:

- A **Host** section/filter on the Connections page listing granted hosts (org + personal), with an
  add/edit form: name, match pattern, protocol, credential (a `secret:KEY` ref, like connectors), and
  posture. Admin-managed for org; self-serve for personal.
- Rows show the same governance affordance as connectors ("every call still passes the gate").

## 5. Phased build (once decisions in §7 land)

- **2a — Data + UX (no gate change):** `hosts` table + store + `/api/hosts` CRUD + the Host section on
  the Connections page. Ships value alone (a registry of internal destinations + their creds).
- **2b — Enrichment + reclassification + policy:** the §3b–§3d work. This is where governance actually
  starts applying. Behind a settings flag (`hostGovernanceEnabled`) so it can bake before it's on.
- **2c — Credential injection:** the §3e SSH-key/`ssh config` launch path.
- **2d — (optional, later) Level-2 containment:** nftables egress under uid-isolation. Separate plan.

## 6. Non-goals / risks

- **Not a firewall.** (See §2.) We will say so in the UI, not imply containment.
- **Parsing brittleness.** Obfuscated/variable/piped targets → `hostUnknown` → escalate. We accept
  false-escalations over false-allows, and we **`log` what we couldn't parse** (no silent pass).
- **Friction blast-radius.** Depends entirely on §7-D1 (deny-by-default vs guard-sensitive). Getting
  this wrong makes agents unusable (every `curl` prompts) or makes the feature toothless.
- **DNS/IP aliasing.** `curl http://1.2.3.4` vs `curl http://name` may both reach a governed host; the
  matcher covers CIDR + hostname but cannot resolve DNS at gate time. Documented limit.

## 7. Decisions

**Resolved (2026-07-09):**

- **D1 — Posture model → guard-sensitive + opt-in lockdown.** Per-agent `netMode: 'open' | 'allowlist'`,
  default `open`. Under `open`, unlisted public egress stays `shell.exec`; listed + internal-looking
  targets are governed. `allowlist` locks an agent to its granted hosts. (See §3d.)
- **D2 — Scope of `net.connect` → internal/sensitive only (under `open`).** Public-internet HTTP stays
  ungoverned by default; only listed hosts + RFC-1918/`.internal`/`.local` targets reclassify. Folds
  into D1.
- **D3 — Enforcement level → Level 1 now, Level 2 (kernel egress) as Phase 2d** behind uid-isolation. (§2.)
- **D4 — Data model → new `hosts` table** mirroring the connectors ownership model. (§3a.)

**Still open (implementation-time, not blocking):**

- **D5 — Grant granularity.** v1: workspace-org + personal host grants (mirrors connectors); an
  `allowlist`-mode agent's allowed set = org hosts + its run-as owner's personal hosts. Per-agent host
  grants (narrowing a locked-down agent to a *subset* of org hosts) can follow if the coarse set proves
  too broad.
- **D6 — Egress verb coverage.** The initial parse set (`ssh`/`scp`/`sftp`/`rsync`/`curl`/`wget`/`psql`/
  `mysql`/`nc`/`telnet`/`mongo`/`redis-cli`) vs. a wider list; and how aggressively to treat wrapper
  scripts as `hostUnknown`. Tune against real audit logs once 2b is behind its flag.

## See also

- [`access-model.md`](./access-model.md) — the north-star this implements (Creds → Connections → Capabilities).
- [`governance-model.md`](./governance-model.md) — the decision layer (`decide(action, actor, context, target)`).
- [`per-user-isolation-plan.md`](./per-user-isolation-plan.md) — the uid-isolation path that a Level-2 egress firewall would extend.
