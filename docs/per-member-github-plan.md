# Per-member GitHub (git run-as) — plan + spec

**Goal:** a member links their **own** GitHub account once in the browser, and thereafter any session
that runs **as that member** (run-as) gets *their* GitHub credential injected as `GH_TOKEN` — so
`git push` / `gh pr create` are authored as the **actual human**, not a shared `agent-os[bot]`. This is
the one-for-one mirror of Slack/Discord run-as, on the git egress lane.

This is **Phase 2** of `docs/github-integration-plan.md`. Phase 1 (the App installation-token minter,
`src/connectors/github.ts`) covered the *company-bot* path. Phase 2 adds the *per-member* path and the
launch wiring that makes run-as choose the right credential.

## Setup: one-click App-manifest flow (v0.129.0)

The admin doesn't hand-create the App or copy any credentials. **Connections → Creds → GitHub** shows a
**Create GitHub App** button that uses GitHub's [App-manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):

1. `GET /api/github/manifest` returns a pre-filled manifest (name, our callback + manifest-redirect URLs,
   least-privilege permissions — Contents + Pull requests write, Metadata read — webhook off, private) plus
   GitHub's form-POST target (`/settings/apps/new`, or `/organizations/<org>/settings/apps/new` when an org
   is given). The browser submits it as a form POST.
2. GitHub shows a "Create this App?" confirmation; on confirm it redirects to
   `GET /api/github/manifest-callback?code&state`, which exchanges the code
   (`POST /app-manifests/:code/conversions`) for the App's **client id + secret + slug** and persists them
   automatically (client id → setting, secret → vault, slug → the install link). Audited `github.app.created`.
3. The card then surfaces **Install the App** (`https://github.com/apps/<slug>/installations/new`) — a
   GitHub App can only touch repos it's installed on.

A **manual** fallback (collapsible) still accepts a hand-entered client id + secret — for an OAuth App, or an
existing App. Either way, the callback URL is `https://<host>/api/github/callback`.

## The shape: user-to-server OAuth

GitHub's "act as this human" credential is a **user access token**, obtained via the browser OAuth
web flow against the company's GitHub App (or a classic OAuth App — the flow is identical):

1. The App's **client id** (setting) + **client secret** (vault) are set — via the one-click flow above
   or the manual fallback in **Connections → Creds → GitHub**. The App's **Authorization callback URL** is
   `https://<host>/api/github/callback`.
2. A member clicks **Connect GitHub** (Connections → Connected → *Mine*). We redirect the browser to
   GitHub's authorize URL with a signed, single-use `state`.
3. GitHub redirects back to `/api/github/callback?code&state`. We validate `state`, exchange the code
   for a **user access token** (+ a refresh token, if the App has expiring user tokens enabled), fetch
   the member's GitHub `login`, and store:
   - the token blob (`{ token, refreshToken?, expiresAt?, login }`) in the **secrets vault** under
     `principal = <member id>`, key `github_user` — encrypted at rest, isolated per member, and
     **not** in the tenant-wide `*` scope (so no agent can read another member's token via `secret_get`),
   - the member's `login` in `member_identities` (provider `github`) — the non-secret, queryable handle
     that also powers attribution + the Team page's Chat-IDs row.

## Launch wiring — run-as picks the credential

In `TerminalManager.launchClaudeCode`, right after the agent-scoped `injectShellSecrets` (which sets the
company-bot `GH_TOKEN` when an agent opts in via `shellSecrets`), we call **`injectMemberGithub`**:

- If the session's **run-as member** has a connected GitHub token, export it as `GH_TOKEN` **and**
  `GITHUB_TOKEN` — **overriding** any bot token. So per-member identity wins; the company bot is the
  fallback when the human hasn't connected.
- If the stored token is within the refresh skew of expiry and a refresh token exists, kick a
  fire-and-forget refresh that rewrites the vault blob for the *next* launch (the current run still gets
  the valid-for-now token). Non-expiring tokens (OAuth App, or a GitHub App without expiring user tokens)
  never enter this path.
- Audited `github.token.injected` (member + login), `github.token.stale` when a refresh was kicked.

Precedence is deliberate and documented inline: **member token > agent bot token**. Both remain governed
by the PreToolUse Bash gate-hook exactly as before — this only changes *which identity* the shell holds.

**Both `git` and `gh` (v0.130.0).** `gh` reads `GH_TOKEN`/`GITHUB_TOKEN` natively, but plain `git push`
over HTTPS does not — so `configureGitCredentials` also installs a **github.com-scoped git credential
helper** via `GIT_CONFIG_*` env vars (git ≥2.31; no file writes; reads `$GH_TOKEN` at call time). It
resets any inherited helper first and returns the `x-access-token` username GitHub expects. Runs whenever
a token was injected (member or bot), so the whole toolchain authenticates; no-op otherwise and for
non-github.com/SSH remotes.

## Token lifecycle

- **Store:** vault, `principal = member id`, key `github_user`, JSON blob (encrypted).
- **Refresh:** `GithubIdentity.ensureFresh(memberId)` (async) refreshes when `expiresAt - skew < now` and a
  refresh token + App creds exist, persisting the new blob. Called from `GET /api/github/me` (opening the
  panel refreshes) and fire-and-forget at launch. A member in active use stays fresh; an idle member's
  token is refreshed on their next launch/panel view. (A periodic sweep is a possible follow-up.)
- **Disconnect:** `POST /api/github/disconnect` clears the vault blob + the `github` identity.

## Endpoints (all under the member-auth gate)

- `GET  /api/github/connect`     → `{ redirectUrl }` to GitHub's authorize URL (400 if the App isn't configured).
- `GET  /api/github/callback`    → exchange code, store, then 302 back to `/#/connectors?github=connected|error`.
- `POST /api/github/disconnect`  → clear this member's token + identity.
- `GET  /api/github/me`          → `{ configured, connected, login?, expiresAt? }` (refreshes first; no secret returned).
- `GET/PUT /api/settings/integrations` → gains a `github` block (`clientId` / `clientSecret` set-flags) and
  accepts `githubClientId` (setting) + `githubClientSecret` (vault) on PUT. Owner/admin only.

`state` is a random token held in a short-lived in-process map keyed to `{ tenant, memberId, exp }`;
the callback additionally requires `state.memberId === me.id` (defence-in-depth against a leaked state).

## Nudging an unconnected member (v0.130.0)

The feature is otherwise passive — an unconnected member's session just falls back to the bot token. To
close that discovery gap, `buildCompanyMd` adds a **git-identity steer** to the launch context when the
run-as member hasn't linked GitHub: if the App is configured it points the agent to have them **Connect
GitHub** in one click; if the App isn't set up it asks an owner/admin to create it first. The agent
raises it via `ask` only when the task actually touches git, so it's contextual rather than a blanket
ping. No steer when the member is connected (token injected, just works) or when there's no run-as person
(a pure automation). Covered by `scripts/github-per-member-test.cjs` §6.

## Identity note

v1 records the GitHub `login` as the member's `github` external-id. Logins can change; a stable numeric
id is a possible refinement, but the login is what a human recognizes and what attribution reads today.

## Files

- `src/connectors/github.ts` — + `authorizeUrl`, `exchangeUserCode`, `refreshUserToken`, `githubUser`.
- `src/edge/github-identity.ts` — `GithubIdentity` (vault blob store + config + `ensureFresh`).
- `src/governance/settings.ts` — `github_client_id` setting (getter/setter/meta).
- `src/server.ts` — the routes above + `integrationsView` github block.
- `src/terminal.ts` — `injectMemberGithub`, called after `injectShellSecrets`.
- `web/src/lib/api.ts`, `web/src/App.tsx` (Creds → GitHub card), `web/src/connectors.tsx` (Mine →
  Connect GitHub card).
</content>
</invoke>
