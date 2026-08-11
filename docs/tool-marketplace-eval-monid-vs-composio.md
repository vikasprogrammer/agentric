# Tool-source evaluation: Monid vs Composio (for agent-os)

_Evaluated 2026-07-20. Context: assessing https://monid.ai/ as a tool/capability source for
agent-os, with particular interest in a LinkedIn integration._

## TL;DR

- **Monid and Composio are not really competitors** — they solve different halves. Composio is an
  **integration/identity** layer ("let my agent act *as me* in my real accounts"). Monid is a
  **utility/data** layer ("grab data / run a cheap utility from a shared pool, no accounts").
- **For LinkedIn (the actual ask): Composio, no contest.** It supports full read + write (post as
  user or org page, comment, delete, ACLs, Ads) with OAuth auto-refresh, and **we already support it
  with zero code changes**. Monid does LinkedIn **scraping only** — no authenticated posting.
- **Composio is the strategic fit** — identity-preserving and already flows through our gateway, so it
  reinforces the single-mediated-gateway invariant. **Monid structurally inverts it** ("agent picks
  tools, Monid bills + mediates") — the underlying tool is opaque behind one `execute`, so our
  Policy/Approvals/Budget/Identity/Audit go blind. At most a tactical, read-only add-on later.

## What each is

### Monid (https://monid.ai/)
Runtime **tool marketplace**: one MCP/CLI/chat-skill endpoint gives an agent 1,300+ tools across
~13 providers (web search, scraping, image gen, weather, on-chain data) with no per-service keys.
"Tell your agent what to do. It picks the tools itself." Ranks candidates by fit & price.

- **Billing:** per-call (~$0.0013/call), single unified balance, no subscriptions, $1 starting
  credit, no charge on failed provider calls.
- **Auth:** Monid's own keys — calls egress **as Monid**, not as your user.
- **Social/LinkedIn:** scraping only (LinkedIn, X, TikTok, Instagram, Facebook, YouTube, Reddit,
  WeChat, RedNote). No authenticated posting/engagement.

### Composio (already wired: `src/connectors/composio.ts`)
Auth/tool platform that connects **your** accounts via OAuth and exposes their real APIs to agents.
We use its **Tool Router**: a per-user, pre-signed MCP endpoint minted on demand at each agent-session
launch (user gives us only their Composio API key; we exchange it scoped to the launching identity).
Whatever toolkits that user has connected show up automatically — **no code change per app**.

- **LinkedIn** ([toolkit](https://composio.dev/toolkits/linkedin) ·
  [docs](https://docs.composio.dev/tools/linkedin)): create posts (user *or* managed org page),
  article/URL shares, comment on shares/UGC posts, delete posts, retrieve org ACLs (which company
  pages the user can post to), image metadata. Separate **LinkedIn Ads** toolkit (targeting facets,
  audience sizing). **OAuth with automatic token refresh/rotation** built in.

## Head-to-head

| Dimension | Composio | Monid |
|---|---|---|
| What it is | Auth/tool platform — connects *your* accounts, exposes their APIs | Runtime tool marketplace — one balance, agent picks from a shared catalog |
| Catalog | ~250–300 toolkits (SaaS apps: Gmail, Slack, LinkedIn, GitHub, Notion…) | 1,300+ tools across ~13 providers (search, scrape, image gen, on-chain, weather) |
| Read vs write | **Full read + write** on your connected accounts | Mostly read/scrape + generate; no authenticated posting to your accounts |
| LinkedIn | **Full**: post (user + org), comment, delete, ACLs, Ads; OAuth auto-refresh | **Scraping only** |
| Auth model | Per-user OAuth; calls run **as the actual user/account** | Monid's own keys; calls egress **as Monid** |
| Billing | Bring your own accounts (their tiered platform pricing) | Per-call (~$0.0013), unified balance, no per-service signup, no charge on failure |
| Integration | MCP (Tool Router — per-user minted endpoint) | MCP / CLI / chat skill |
| Setup friction | Higher — OAuth-connect each account | Near-zero — no signups, tools work immediately |
| Governance fit with us | **Native** — already wired; each action hits our gateway, runs under run-as identity, lands in audit | **Adverse** — underlying tool opaque behind one `execute`; Policy/Budget/Identity/Audit go blind |

## Why Monid fights our core thesis

Our one invariant: *every side effect passes through a single mediated gateway* (Policy classifies →
Approvals suspends → Budget debits → Identity asserts → Idempotency dedupes → Audit records). Monid is
architected the opposite way — frictionless autonomous tool selection, with Monid doing the mediation
and billing. Concretely:

1. **Opaque side effects.** A Monid call reaches our gate hook as one invocation; which of 1,300 tools
   ran and what it touched is hidden behind `execute`. Policy can't classify a capability it can't see
   — the exact "opaque proxy" failure mode our design exists to prevent.
2. **Double-metering / lost budget control.** Monid bills its own balance; our Budget plane can't set
   per-agent / per-capability / approval-gated limits on spend inside Monid.
3. **Broken identity + audit chain.** We invest in per-member run-as (GitHub OAuth injection,
   `run_as` vs provenance). Monid egresses under its own identity; the provider and our audit see
   "called Monid," not "did X on behalf of Y."
4. **Data-egress / trust posture.** We run on Tailscale-private / on-prem boxes so data stays inside
   the perimeter. Routing tool calls through a third-party marketplace expands the trust boundary.

## Recommendation for agent-os

- **Keep Composio as the integration backbone.** LinkedIn included — getting our agents posting to
  LinkedIn is a **connect-the-account task, not a build task**: the user OAuth-connects LinkedIn in
  Composio, and the next session's minted Tool Router endpoint already carries the actions.
- **Consider Monid only later, and only scoped:** a read-only utility/scraping source, wrapped so each
  underlying call still hits our gateway/audit/budget. Never route write-side or sensitive work
  through it.
- **Strategic signal:** the market wants "agent, just pick your tools." Our differentiated answer is to
  offer that breadth *with* per-capability policy, budget, identity, and audit intact — not to hide the
  tools behind a proxy. Their catalog + unified-billing UX is worth studying for our connector/budget
  surfaces.

## Open follow-up (not done)

Verify the live Composio setup — whether LinkedIn is connectable/connected on the Composio account the
northwind tenant uses, and confirm the actions appear in a minted Tool Router endpoint — so agents can
post today.
