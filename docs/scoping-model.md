# Scoping model — what's in the OS, and who can see/touch it

The canonical reference for **tenancy and scoping** in Agent OS: every resource the system holds,
how it's scoped today, and the target scope we've decided on. Pair this with
`docs/per-user-isolation-plan.md` (the OS mechanism that *enforces* the per-member boundary) — this
doc says *what* the boundaries are; that one says *how* they're built.

> **Connectors update (2026-06-17):** the connector model below (Decision #2) has been reframed and
> extended in `docs/connectors-and-triggers.md`. That doc splits the old "org vs personal" idea into
> two planes — **triggers (ingress)** vs **connectors (egress)** — adds the **service / personal /
> personal-shared** identity classes and the **run-as** bridge, and specs five concrete use cases
> (Slack notify, Slack→agent, Slack DM chat, email trigger, member-identity email). Read it for the
> current connector design; the tables here still hold for everything else.

## The tenancy decision

One Agent OS instance = **one company team**. Within it:

- **Members are trusting colleagues, but personal privacy matters.** They may see each other's
  tasks and audit, but **not** each other's personal account data, tokens, or `~/.claude`
  transcripts.
- **Agents are shared, curated org assets.** Members run them; they don't author their own.
- **Connectors come in two classes** (see below): company-wide and personal.
- **Cross-team isolation is a hard boundary**; **intra-team is governance** (roles + the gate).

> **Multi-tenant update (2026-06-25):** that hard boundary no longer requires a separate *process*
> per team. `src/tenant-registry.ts` runs **many tenants in one process** — each gets a fully
> isolated runtime (its own `AgentOS` + DB + tmux socket + ttyd + cron + Slack), built from a control
> plane (`src/state/control.ts`). Requests route to a tenant by **subdomain** (`<slug>.<baseDomain>`,
> `src/home.ts` nests each under `<home>/tenants/<slug>/`); in-session loopback agent calls route by
> the `x-aos-tenant` header. The DB file is still the tenant boundary — no table grew a `tenant`
> column. The DEFAULT tenant (config `tenant`) keeps the legacy un-nested home, so existing installs
> need no migration. Provisioning is superadmin-only: `agent-os tenant create` / `POST /api/admin/tenants`
> (gated by `AOS_SUPERADMIN_TOKEN`). An email is a distinct Member per tenant (separate `members`
> tables), so a person can belong to several tenants.

Consequence that shapes everything: because agents run **real autonomous shells**, app-level
filtering is *necessary but not sufficient* for personal privacy. Genuine member-vs-member privacy
requires **per-member Unix uids** (Tier A of the isolation plan). The cheap "single shared runner
uid" is ruled out — it doesn't separate members from each other.

## Scope vocabulary

- **Tenant** — the whole workspace (one `tenant`). Shared by every member. One process now hosts
  **many** tenants (the registry), each with its own DB/socket/ttyd; "instance" = one tenant's runtime.
- **Per-agent** — keyed by agent id. Shared by members who can run that agent.
- **Per-session** — belongs to one run.
- **Per-member** — belongs to one human.
- **Per-automation** — belongs to one trigger.

## Roles & levels (the access primitives)

- **Member roles — 3:** `owner` (runs the show; approves anything; manages team/roles/policy),
  `admin` (approves `head` only; manages team & assignments), `member` (runs only assigned agents;
  never approves). `src/types.ts:27`, enforced by `canApprove()` (`types.ts:46`) + `TeamStore.canRun()`.
- **Approval levels — 2:** `head` (admin or owner) · `owner` (owner only). `types.ts:17`.
- **Risk classes — 4:** `green` (auto-allow) · `yellow` (→ head) · `red` (→ owner) · `deny`
  (blocked). `types.ts:14`.
- Chain: **policy classifies an action → risk class → approval level → `canApprove` picks the role.**

## Table 1 — current state

| # | Thing | Backed by | Current scope | Read / Write | Sensitive |
|---|---|---|---|---|---|
| 1 | Tenant | `cfg.tenant` | Instance (1/process) | — | — |
| 2 | Members / Team | `members` | Instance | read: any · write: owner/admin (role → owner) | low |
| 3 | Invites / Auth sessions | `invites`, `auth_sessions` | Per-member | self · owner/admin | tokens |
| 4 | Agents | FS `config/agents` + `<home>/agents` | Instance (shared catalog) | run: `canRun` · edit: owner/admin | prompts |
| 5 | Assignments | `assignments` | Per-agent | read: any · write: owner/admin | low |
| 6 | Connectors | `connectors` | **Instance — no owner column** | read: any (redacted) · write: owner/admin | secrets |
| 7 | Memory | `memories (tenant, agent_id)` | Per-agent (shared) | read/write: `canRun(agent)` | personal context |
| 8 | Skills | FS `<home>/skills` (+ agent folder) | Instance library / per-agent override | owner/admin | low |
| 9 | Company context | `settings` (`company_md`) | Instance (single doc) | read: any · write: owner/admin | low |
| 10 | Policy | FS `policy.json` | Instance | read: owner/admin · write: **owner** | governs risk |
| 11 | Files | FS data home | Instance (admin browses whole home) | owner/admin only | spans everything |
| 12 | Sessions (terminal) | `term_sessions` (`spawned_by`) | Instance-visible; provenance per-member | list: any · spawn: `canRun` · **attach: login-only** | live shell |
| 13 | Inbox / Messages | `messages` (`session_id`, `source`) | Instance-visible | read: any | effect args |
| 14 | Approvals | `approvals` | Per-session | read: any · resolve: `canApprove` | args |
| 15 | Questions | `questions` | Per-session | read: any · answer: any | possibly |
| 16 | Automations | `automations` (`created_by`) | Instance | read: any · write: owner/admin · fire: cron/webhook key | webhook key |
| 17 | Audit | `audit_events` + JSONL | Instance | read: owner/admin · append-only | records args |
| 18 | Budget | `InMemoryBudgetLedger` | Instance (volatile) | — | — |
| 19 | Identity | `StubIdentity` | Instance (principal = agent) | — | — |
| 20 | Secrets vault | `EnvSecretsVault` (process env) | Instance | — | secrets |
| 21 | OS substrate — `~/.claude`, tmux socket, Unix uid | FS / OS | **Instance — single shared uid** | one identity for all | creds + transcripts |

## Table 2 — target state and the gap

| Thing | Current | Target (decided) | Work |
|---|---|---|---|
| Connectors | Instance, no owner | **Org (shared) + Personal (per-member)** via `scope` + `owner_member_id`; `mcpConfig(memberId)` filters | Phase 0.1 (the feature) |
| Secrets vault | Instance env | Per-member entries for personal connectors | Phase 0c |
| Sessions (execution) | single shared uid | Per-member uid; attach authz per session | Tier A + 0b |
| `~/.claude` + transcripts | single shared | Per-member | Tier A3 |
| Files browser | whole home, admin | Scoped to the member's own area once homes split | per-uid roots |
| Automations | Instance, `created_by` | Run as owner-member's uid + their personal connectors; **service identity** for org-acting ones | Tier A2 |
| Memory | per-agent, shared | **per-agent, shared — UNCHANGED** | none |
| Inbox / Sessions / Approvals / Questions | everyone sees all | **member sees own; owner/admin see all** | ✅ implemented — `TerminalManager.canViewSpawn/canViewSession`; filters `/api/sessions`, `/api/messages`, `/api/approvals`; write-side (stop/delete session, answer question) gated by `canViewSession` |
| Audit | Instance, principal = agent | principal = member; redact personal args | identity + redaction |
| Budget | Instance, volatile | optional per-member spend caps | later |

**Stays Instance-shared, correctly (no change):** Agents, Skills, Company context, Policy, Members,
Assignments, Tenant.

## Decisions log (2026-06-16)

1. **Tenancy:** one shared multi-member instance per company team; trust model = "colleagues, but
   privacy matters."
2. **Connectors → two classes.** *Company-wide* (Slack, ClickUp): one shared bot/connection,
   owner/admin-configured, usable by any agent. *Personal* (each member's Gmail): bound to one
   member, only injected into that member's sessions. A shared agent run by member M gets
   `org ∪ M's personal` connectors. Add `scope` + `owner_member_id` to the `connectors` table;
   `mcpConfig(memberId)` filters. Composio is the easy on-ramp for the personal class.
   - **Security rule (implemented):** a non-admin adding a *personal* connector may only instantiate a
     known catalog template (Slack/Gmail/GitHub/Drive/Composio) with their own credentials — never a
     free-form `custom` command or an override of the template's command/args. Otherwise, while all
     sessions still share one Unix uid (pre-Tier-A), a member could run arbitrary code under the
     service account and read everyone's tokens. Admins keep full flexibility (incl. `custom`). This
     guard can relax once Tier A gives each member their own uid.
3. **Memory → team-shared, unchanged.** Keep `(tenant, agent_id)`. Accepted trade-off: personal
   context an agent learns is visible to teammates. (One fewer migration.)
4. **Inbox → per-member visibility.** A member sees only their own sessions + inbox cards
   (`spawned_by`/`source` = their id); owner/admin see the whole team. Not tied to connector scope —
   a blanket rule. Filter `GET /api/sessions`, the messages feed, approvals, questions; bypass when
   `isAdmin(me)`. Open detail: automation-fired sessions (`spawned_by=automation:<id>`) → show to
   owner/admin **plus** the automation's `created_by`.
5. **Privacy enforcement requires per-member uid (Tier A).** Until it ships, the "members can't see
   each other's Gmail" guarantee is app-level only — do not promise it to members yet. Interim
   softener: make personal connectors Composio-minted (short-lived scoped URL, not a durable token).

## Sequencing

**Phase 0 — ships the feature + cheap hygiene (app-level):**
- 0.1 Connector `scope` + `owner_member_id`; `mcpConfig(memberId)`; two-section "Company / My
  connectors" UI.
- Inbox per-member read filter (decision 4).
- ✅ 0a `0600` session files + `0700` connectors dir (`TerminalManager.writeSecret`/`ensureSecureDir`,
  headless transcript in `claude-launch.sh`). ✅ 0b attach authz `GET /api/terminal/authz`
  (`canViewSession`) — **code done; needs nginx `auth_request` wiring** (snippet in the isolation plan).
  ✅ 0d per-session gate bearer — a secret minted per session, exported as `AOS_SECRET`, required as
  the `X-AOS-Secret` header on the 8 loopback agent routes (`/api/gate`, `/api/ask`, `/api/report`,
  `/api/memory/recall|remember`, `/api/agent/policy|policy/check`, `/api/ended`) via
  `TerminalManager.verifySessionSecret` (fails open only for pre-0d sessions).

**Phase A — makes the privacy real (OS substrate):**
- A1 privileged launcher → A2 per-member uid → A3 per-uid `~/.claude` → A4 per-uid tmux/ttyd/routing
  → A5 slices/cleanup. See `docs/per-user-isolation-plan.md`.

⚠️ Phase 0 makes the two-class connectors usable and demo-able; Phase A is what turns the privacy
intent into an OS-enforced guarantee.
