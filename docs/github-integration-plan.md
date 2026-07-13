# Native GitHub integration — plan

**Goal:** a first-party GitHub integration in **Settings → Integrations** (like Slack/Discord) so a
user connects GitHub once, in the browser, and every agent can act on the org's repos — via **both**
the shell (`gh`/`git`) and **governed API tools** — without anyone pasting a static PAT.

## Why not a Slack/Discord-style socket

Slack/Discord native = an **outbound WebSocket ingress** (Socket Mode / Gateway): no public URL,
receive @mentions, run-as the sender. GitHub has **no socket equivalent** — its ingress is webhooks (a
public URL), already covered by the Composio/`/hooks` lane. So the Slack template is the wrong shape.
The right shape for GitHub is an **egress credential**: the agent *acts on* GitHub. The "native,
auth-via-web" version of that is a **GitHub App** whose install flow lives in the console and which
**mints short-lived tokens** injected at launch.

## The credential: a GitHub App (installation token)

The owner registers **one** GitHub App (per tenant/org) and installs it on the repos it may touch.
Agent OS holds the App id + RSA private key (vault) + the installation id. At each session launch we:

1. Sign a short-lived **App JWT** (RS256, ≤10 min, `iss = appId`).
2. Exchange it for a **1 h installation access token** — org-scoped, with the App's fine-grained
   per-repo permissions.

Nothing long-lived is handed to the agent; the token expires hourly and is minted on demand (cached
in-memory until ~5 min before expiry). An installation token is simultaneously:

- a valid **`GH_TOKEN`** for `gh` and `git` (the shell path — builds on the per-agent shell-secrets
  work, `injectShellSecrets`), and
- a valid **bearer** for GitHub's hosted MCP (`https://api.githubcopilot.com/mcp/`) or a local GitHub
  MCP server (the governed API-tools path — a per-session connector with the token as an
  `Authorization: Bearer` header, resolved like any `secret:` ref).

One credential drives both halves.

## Identity

- **v1 — company identity.** The App (bot, `agent-os[bot]`) acts on repos; PRs authored by the bot.
  Simplest, org-scoped, matches company-scope agents.
- **Phase 2 — per-member.** ✅ **Shipped** (v0.126.0) — see `docs/per-member-github-plan.md`. A member
  links their own GitHub account (user-to-server OAuth "Connect GitHub"); the user token is vault-stored
  per member and injected as `GH_TOKEN` for run-as sessions, so the agent authors PRs as the actual human,
  overriding the company bot. `github` was already a provider in `member_identities`, so the login is
  recorded there too.

## Phases (each its own PR)

1. **Core minter** (`src/connectors/github.ts`) — `appJwt`, `mintInstallationToken`,
   `listInstallations`, `appMetadata`, plus an in-memory token cache. Pure/offline-testable (generate a
   keypair, sign, verify). *No UI, no wiring — foundational.*  ← **this PR**
2. **Launch wiring** (`terminal.ts`) — when GitHub is configured, mint at launch, set `env.GH_TOKEN`
   (via the shell-secrets plane) and add the GitHub MCP connector to the session `.mcp.json`. Audited
   `github.token.minted` / `github.token.failed`. A per-agent opt-out/opt-in flag on the manifest.
3. **Settings → Integrations UI + install flow** — a GitHub card (App id + private key + client
   id/secret), an **Install on GitHub** button → the App install/callback route
   (`GET /api/github/installed`) that records the installation id, and a "connected as …" status.

## Settings keys (Settings store / vault)

- `github_app_id`, `github_client_id` — settings.
- `github_private_key`, `github_client_secret`, `github_webhook_secret` — vault (encrypted).
- `github_installation_id` — settings (recorded from the install callback, or picked from
  `listInstallations`).

## Governance

- Shell `GH_TOKEN` is gated coarsely by the PreToolUse Bash gate-hook (as today for any command).
- The GitHub **MCP connector** routes each API action (open PR, comment) through the connector/gateway
  path — per-operation policy + audit, the well-governed lane.
- Token mint is audited; the App's fine-grained permissions are the real blast-radius control (grant
  only the repos + scopes the fleet needs).
