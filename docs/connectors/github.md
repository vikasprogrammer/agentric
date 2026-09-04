# GitHub connector

**Status:** shipped. **Kind:** credential source (no chat ingress) — the shell's `GH_TOKEN` and a bearer
for GitHub API tools.
**Code:** `src/connectors/github.ts` (App/OAuth client) · `src/edge/github-identity.ts` (vault + refresh) ·
`/api/github/*` (`src/server.ts`) · injection in `src/terminal.ts`.
**See also:** `docs/github-integration-plan.md`, `docs/per-member-github-plan.md`.

GitHub is not a chat channel. One company **GitHub App**, registered once and installed on the org's
repos, is the single credential source for both consumption paths:

- the **shell** — a token is exported as `GH_TOKEN` / `GITHUB_TOKEN` at launch, so plain `git` and `gh`
  authenticate; and
- **governed API tools** — the same token is a valid bearer for a GitHub MCP connector.

**Why an App, not a static PAT:** an installation token is org-scoped, carries only the App's
fine-grained per-repo permissions, and **expires hourly**. It is minted on demand, so nothing long-lived
is ever handed to an agent. The App's private key never leaves the server (encrypted vault), and the
RS256 JWT we sign to obtain a token lives ≤ 9 minutes (GitHub's ceiling is 10; `iat` is back-dated 30 s
for clock skew).

## Two identities, one App

| Path | Whose token | Stored where | Lifetime |
|---|---|---|---|
| **Company bot** | the App **installation** token | vault `*` → `github_bot_token` (cached) | ~1 h, refreshed 25 min early |
| **Per-member** | that member's GitHub **user** token (OAuth) | vault under `principal = <member id>` → `github_user` | ~8 h, refreshed 10 min early |

At launch `injectMemberGithub` runs right after the shell-secret injection: if the run's **run-as member**
has linked their own GitHub account, **their** user token **overrides** the bot's `GH_TOKEN`, so commits
and PRs are authored as the actual human. The bot is the fallback — a run with no linked run-as human
acts as the bot. Audited `github.token.injected`.

Member tokens are **never** stored in the tenant-wide `*` scope, so no agent can read another member's
token via `secret_get`. The App's OAuth client secret and RSA private key sit under `*`; the client id is
a plain setting.

## Setup

Owner/admin, **Settings → Integrations → GitHub**. Either half works on its own and the setup wizard
counts either:

- **OAuth pair** (`github_client_id` + client secret in the vault) → members can link their own accounts
  and commit as themselves.
- **App id + private key** (`github_app_id`, `github_installation_id`, PEM in the vault) → the company-bot
  push token.

The **manifest flow** (`GET /api/github/manifest` → GitHub → `GET /api/github/manifest-callback`) creates
the App and captures the credentials in one round trip (`convertAppManifest`), storing the resulting
`github_app_slug` — which is what builds the "install on repos" link. The installation id is auto-resolved
(`listInstallations`).

Per-member linking: `GET /api/github/connect` → GitHub authorize → `GET /api/github/callback`
(`exchangeUserCode`); `GET /api/github/me` reports link + installation status; `POST /api/github/disconnect`
drops the stored blob.

⚠ **Never rename a live GitHub App slug** — the slug is baked into every per-member install URL.

## Self-recovery: `github_refresh`

An agent whose injected `GH_TOKEN` dies mid-run (`git`/`gh` → `Bad credentials`) can call the
`github_refresh` MCP tool. It **forces** a refresh (`GithubIdentity.forceRefresh` via the stored `ghr_`
refresh token) — unlike launch-time `ensureFresh`, which only acts inside the expiry skew — and hands back
the fresh token so the agent can `export GH_TOKEN=…` itself (a process's env cannot be mutated from
outside; the git credential helper and `gh` re-read `$GH_TOKEN` at call time). It is the agent's own,
already-injected identity, so there is no new exposure. Typed statuses tell it to stop retrying and have
the human re-link when there is no refresh token.

## API surface (`src/connectors/github.ts`)

Zero-dependency: the global `fetch` plus `node:crypto` for RS256. Every call returns `{ error }` rather
than throwing.

`appJwt` · `authorizeUrl` · `exchangeUserCode` · `refreshUserToken` · `convertAppManifest` ·
`githubUser` · `appMetadata` · `userInstallationStatus` · `listInstallations` · `mintInstallationToken` ·
`pullRequest` · `InstallationTokenCache`.

## Gotchas

- **A dead injected token is worse than none** — `gh` prefers `$GH_TOKEN` over the keyring, so an expired
  injected token *shadows* a working login. Stale-at-launch tokens are therefore withheld rather than
  exported (v0.338.1).
- **PR authorship = whoever last set `GH_TOKEN`.** The bot wins on any run with no linked run-as human;
  that is the expected behaviour, not a bug.
- The App slug is load-bearing for install URLs (see above).
