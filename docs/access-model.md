# Agent OS — The Access Model (how agents reach the outside world)

> **Status (2026-07-09): design north star + as-built map.** The three-layer model and vocabulary
> below are the target. The "as-built" tables state what actually ships on `main` today; the
> **Proposed** section is not built yet. Governance *internals* (how the decision is made) are being
> actively reworked in a parallel effort — this doc defers all of that to
> [`governance-model.md`](./governance-model.md) and only describes how access is **delivered and
> configured**, which is orthogonal.

This is the companion to two existing docs. Keep the three straight:

- **This doc — Access.** *How do I give an agent the ability to reach X at all?* The taxonomy of
  delivery mechanisms (connectors, integrations, MCPs, shell secrets, bash/ssh) and how to collapse
  them into one model.
- [`governance-model.md`](./governance-model.md) — **Decision.** *Given an attempted action, should it
  be allowed, paused for a human, or refused?* The four-input `decide(action, actor, context, target)`
  function and the gateway.
- [`connectors-and-triggers.md`](./connectors-and-triggers.md) — **Identity & direction.** *Whose name
  is on the action, and is this ingress or egress?* The service/personal/shared identity split.

Access is upstream of both: you must *grant* reach before there's an action to govern or an identity to
act as.

---

## The problem: five words for overlapping things

A user who wants "let this agent talk to our internal Postgres / SSH into the deploy box / call the
GitHub API" is confronted with five mechanisms that overlap on some axes and diverge on others:

| Mechanism | What it really is | Scope | Credential source | Routes through the gateway? |
|---|---|---|---|---|
| **Integrations** (Settings) | Workspace *credentials* for Slack/Discord/Composio — the **keys**, not the doors | workspace | `settings` table | n/a — consumed by OS daemons + Composio mint, not by agents directly |
| **Connectors** | MCP server specs (`stdio`/`http`) + creds, materialised into `.mcp.json` at launch | org **or** personal (shareable) | connector row `env`/`headers`, resolved from vault via `secret:KEY` refs | **Yes** — `mcp__*` calls hit `gate-hook.sh` → `/api/gate` |
| **Built-in MCP** (`agentos`) | The OS's *own* tools (memory/kb/tasks/ask/secret…) over loopback | every session | session bearer | **No** by design (hook exits 0) — the OS itself, scoped + audited server-side |
| **Agent-specific MCPs** | *Not a real manifest field today.* A per-agent tool = a **personal connector** | member | vault | (would be, via connectors) |
| **Bespoke** (`shellSecrets` + vault + raw bash/ssh/curl) | Vault key → shell env var so a CLI (`gh`, `ssh`) authenticates — configured per agent via manifest `shellSecrets` **or** per-secret **agent assignment** (Settings → Secrets, `secret_assignments`) | agent (widening to `*`) | vault | **Partially** — the *injection* is ungated; the *bash command* is gated only as `shell.exec` text |

Three structural observations fall out of that table:

1. **"Integrations" and "Connectors" are not peers — they're different layers.** Integrations is the
   *credential store*; Connectors is *delivery*. Composio makes it explicit: the Composio **key** is an
   Integration; the Composio **connector** is delivery that mints a per-user session *from* that key.
   The UI presents them as two sibling pages, which is the single biggest source of confusion.
2. **"Agents can have their own MCPs" is aspirational.** There is no MCP field on the agent manifest
   (`AgentManifest`, `src/types.ts`). Today a per-agent tool is a *personal connector* — which isn't
   obviously "per-agent" in the UI.
3. **The real hole is bespoke shell / SSH / network.** The one invariant — *every side effect passes
   through the gateway* — is only mostly true here. SSH and arbitrary `curl` are just bash text the
   enricher regex-scans for `prod`/`kubectl`/etc. (`src/governance/enricher.ts`). There is no
   first-class notion of "this agent may reach *these hosts*." That's exactly the mechanism users reach
   for when the other four don't fit — and it's the least governed.

---

## The reframe: three layers, one noun (`capability`)

The way out is not a new abstraction — it is promoting the one the policy engine **already runs on**.
Internally, everything is a `capability` (`shell.exec`, `connector.call`, `file.write`, `secret.get`,
`email.send`, …). Policy rules, approvals, budget, and audit are all written against capabilities (see
`config/policy/default.policy.json`). Make that the user-facing spine, in three layers:

```
  Creds  →  Connections  →  Capabilities (governance)
 (the keys)  (the doors)     (who may open which door, when)
```

### Layer 1 — Creds (the vault)

*One* place secrets live. Everything else holds a **reference** (`secret:KEY` / `secret:PRINCIPAL/KEY`),
never a literal. Connector `env`/`headers` already resolve from the vault at launch inside the mediated
boundary (`resolveVaultRefs`, `src/terminal.ts`); `shellSecrets` already pulls from the same vault
(`injectShellSecrets`). "Integrations" (Slack/Composio/Discord tokens in `settings`) are simply
**well-known credentials the OS itself consumes** — the same keyring, viewed from a different page.

- **Invariant to make universal and visible:** *no plaintext secret lives anywhere but the vault;
  every mechanism references it.* Plaintext exists only in memory during resolution and in the target
  subprocess's env for the session's lifetime.
- **Reposition, don't rebuild:** rename **Integrations → Creds**. It is the keyring, not a *kind* of
  access. The Slack/Discord daemons and the Composio mint are just the OS's own consumers of that
  keyring.

### Layer 2 — Connections (delivery)

*One* list of "what this agent can reach outside itself," with three **shapes** instead of three pages:

| Shape | What it is | Delivered as | Today |
|---|---|---|---|
| **Tool** | a structured MCP server | `.mcp.json` at launch → `mcp__*` tool calls | Connectors + Composio + the OS built-ins |
| **Shell** | a CLI affordance backed by an injected env var | `shellSecrets` → env var the shell reads | `shellSecrets` |
| **Host / Network** | a *named* reachable destination (SSH target, HTTP base) | **nothing first-class yet** | raw bash `ssh`/`curl` |

Every Connection is the **same record**: `name · shape · credential ref · scope (org/member/agent) ·
the capability glob it grants`. That one record subsumes connectors, integrations-as-consumed,
shellSecrets, and "bespoke API scripts."

### Layer 3 — Governance (the gateway)

Every Connection **declares the capability its calls classify as**, so Policy / Approvals / Budget /
Audit apply uniformly and *by construction* rather than by whichever mechanism happened to wire itself
through the gate. The decision itself is out of scope here — see
[`governance-model.md`](./governance-model.md). Access's only job is to guarantee that **every external
Connection names a capability**, so nothing reaches the world off-ledger.

- The OS built-in MCP (`agentos`) is the **one deliberate exemption**: it *is* the OS, touches nothing
  external, and is scoped + audited server-side. Everything else external must name a capability.

The user-facing story becomes a single sentence:

> *To give an agent access, you grant it a **Connection** — a Tool, a Shell CLI, or a Host — backed by
> a **credential** from the vault, scoped to org/member/agent, and governed by the **capability** it
> maps to.*

Connectors, Integrations, `shellSecrets`, and "bespoke API scripts" all become instances of that one
thing.

---

## Where each of today's mechanisms lands in the model

| Today | Layer | Shape | Change needed |
|---|---|---|---|
| Integrations (Slack/Composio/Discord tokens) | Creds | — | Relabel as *Creds*; show as the keyring Connections draw from |
| Connectors (org / personal) | Connections | **Tool** | Fold under a unified *Connections* surface with a shape facet |
| Composio | Connections (minted from a Credential) | **Tool** | Same; make the "minted from the Composio key" relationship visible |
| Built-in `agentos` MCP | — (the OS itself) | (Tool-shaped) | Label clearly as *OS tools*, not a configurable Connection |
| `shellSecrets` | Connections | **Shell** | Surface as a Shell connection, not a raw manifest array |
| Raw bash `ssh`/`curl` to internal hosts | Connections | **Host / Network** | **Build this** — first-class, see Proposed |

---

## The decision tree: "I want an agent to reach X"

```
Is X the OS's own memory/tasks/kb/inbox?        → already there (built-in agentos MCP). Do nothing.
Is X a structured API with an MCP server?       → Tool connection (a connector; or Composio if it has one).
Is X something a CLI already speaks (gh, aws…)? → Shell connection (a vault key injected as an env var).
Is X a host you SSH/HTTP into (db, deploy box)? → Host connection  [Proposed — today: raw bash, weakly governed].

Then, for every one:
  Whose credential?  org (company account) · member (their own) · agent (a scoped key).
  Which capability?  → that is what Policy/Approvals/Budget/Audit key on (governance-model.md).
```

---

## The governance-coherence gaps (what bypasses the gateway today)

Stated plainly, because "make it uniform" should *mean* something, not just look tidier:

1. **Built-in `agentos` MCP is ungated** — *intentional and fine.* It is the OS; the gate hook exits 0
   for `mcp__agentos__*`. Server-side scoping + audit already bound it.
2. **`shellSecrets` injection is ungated** — the env var is exported at launch with no approval; only
   the *later* bash command that reads it is classified (as generic `shell.exec`). Acceptable for now,
   but the *grant* of a Shell connection should itself be a governed, audited act (it is a standing
   capability grant, not a one-off).
3. **SSH / network is not first-class** — the crux. `ssh -i … deploy@prod` and `curl https://internal…`
   are classified only as `shell.exec` text, matched against regex keywords. There is no host
   allow-list, no `net.connect` capability, no "this agent may reach staging but not prod." This is the
   change that turns uniformity from cosmetic into real.

---

## Proposed direction (phased)

Sequenced cheapest-first; each phase stands alone.

**Phase 0 — Vocabulary (this doc).** Pin the three-layer model and the decision tree. No code. Kills
most of the confusion and gives the UI + capability work a north star.

**Phase 1 — UI reframe (low risk, no schema change).** Merge the *Connectors* and *Integrations* pages
into one **Connections** surface with a `shape` facet; relabel Integrations as *Creds*; make the
Composio "minted-from-key" relationship visible. Presentation over the existing `connectors` +
`settings` tables — no migration.

**Phase 2 — Host / Network as a first-class Connection (the substantive one).** A Host connection =
`{ name, target (ssh user@host / http base), credential ref, scope, allowed? }` that (a) produces the
SSH config / env the shell needs and (b) classifies its use as a real `net.connect` / `ssh.exec`
capability with a host allow-list — so bespoke access stops being ungoverned bash. Design this against
the four-input decision in [`governance-model.md`](./governance-model.md) (target = the host; blast
radius = prod vs staging), not as a new bolt-on.

**Later — Shell connections as governed grants.** Promote `shellSecrets` from a manifest array to a
first-class Shell connection whose *grant* is audited (and optionally approval-gated), closing gap #2.

Naming decisions, so they don't drift:

- **Connection** — the umbrella noun for anything an agent can reach outside itself (Tool / Shell / Host).
- **Creds** — the vault keyring (was "Integrations").
- **Capability** — the governed unit; unchanged, already the policy spine.
- **OS tools** — the built-in `agentos` MCP; explicitly *not* a configurable Connection.

---

## See also

- [`governance-model.md`](./governance-model.md) — the decision function the capabilities feed into.
- [`connectors-and-triggers.md`](./connectors-and-triggers.md) — ingress/egress + service/personal/shared identity.
- [`scoping-model.md`](./scoping-model.md) — what is scoped to whom.
- [`agent-mcp-tools.md`](./agent-mcp-tools.md) — the built-in `agentos` tool ↔ route ↔ store matrix.
- [`PILLARS.md`](./PILLARS.md) — where this sits in the product pillars.
