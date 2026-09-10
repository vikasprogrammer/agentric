# Multi-org GitHub — plan

**Goal:** one tenant, one GitHub App, **many orgs**. Today the company bot silently collapses to a
single org; this makes the installation set first-class so an unattended run can push to
`northwind/api` and `globex/site` in the same session.

## The defect this fixes

`GithubIdentity.ensureBotToken` (`src/edge/github-identity.ts:162`) stores ONE
`github_installation_id` and, when it's unset, resolves it as **`installations[0]`** — whichever
install `GET /app/installations` happens to return first. It then caches one token blob in the vault
under the single key `github_bot_token`. So with the App installed on two orgs:

- the bot acts on exactly one of them, chosen arbitrarily and then frozen by the cached setting;
- the other org 404s on every `git push` / `gh pr`, with **no error at launch** — the token is valid,
  it just doesn't cover that repo, so it reads to the human as "the agent can't see our repo";
- the retry path on a stale id (`:178`) re-resolves `installations[0]` again, so a reinstall can flip
  which org works without anyone touching a setting.

The per-member OAuth lane is **not** affected — a user-to-server token spans every org that member can
reach — so this is strictly about the unattended/bot lane.

## Shape

Three layers, each independently useful; ship in order.

### 1. An installation registry, not a single id

`listInstallations` already returns every install with its `account` login. Persist the set.

- New setting **`github_installations`** — JSON `[{ id, account, repositorySelection }]`, refreshed
  from `listInstallations` on save of the App credentials, on the install callback, and lazily
  whenever a lookup misses.
- **`github_installation_id` keeps its exact meaning** — the *primary* installation, the one whose
  token is injected as `GH_TOKEN` at launch. So a single-org tenant behaves bit-for-bit as today and
  a rollback is safe: both are plain `settings` rows, no DB migration.
- Accessors on `SettingsStore`: `githubInstallations()` / `setGithubInstallations()`, and on
  `GithubIdentity`: `installations()`, `installationFor(org)`, `primaryInstallation()`.
- `ensureBotToken` stops picking `[0]` blind: with no primary set and **exactly one** install it
  adopts it (today's behaviour); with several it adopts the first *and* records the full set, so the
  console can show "3 orgs installed — minting as `northwind`" instead of hiding the choice.

### 2. A token cache per installation

The vault key becomes **`github_bot_token:<installationId>`** (the legacy unsuffixed key is read once
and migrated to the primary's suffixed key on first use, then left alone).

- `loadBotToken(org?)` / `ensureBotToken(org?)` / `botNeedsRefresh` take an optional org login,
  defaulting to the primary — every existing call site keeps compiling unchanged.
- `injectGithubBaseline` is untouched in behaviour: it still injects the **primary** org's token as
  `GH_TOKEN`/`GITHUB_TOKEN`, with the same expired-token-is-worse-than-none rule.
- It additionally exports **`AOS_GH_ORGS`** (comma-separated account logins) and names them in the
  agent's git-identity prompt block (`terminal.ts:4622`), so the agent knows which orgs it can reach
  and which one its ambient token covers.

### 3. Per-repo git credentials (the transparent half)

`configureGitCredentials` (`src/terminal.ts:~8670`) installs a github.com-scoped helper that hands git
`$GH_TOKEN`. Extend it so the helper resolves the token **from the repo path** instead:

- set `credential.https://github.com.useHttpPath=true`, which makes git pass `path=<org>/<repo>.git`
  into the helper's stdin protocol;
- the helper parses the org out of `path=` and curls a new loopback route with the session's existing
  `AOS_SECRET` / `AOS_URL` / `SESSION` env (the same channel the gate hook and MCP tools use);
- **any failure falls back to `$GH_TOKEN`**, so a server restart mid-run degrades to today's
  behaviour rather than breaking git.

New route **`POST /api/agent/github/credential`** (loopback, before the member-auth gate, session-secret
gated — modelled exactly on `/api/agent/github/refresh`, `src/server.ts:1079`):

```
{ session, org }  →  { status: 'ok', token, org, expiresAt }
                  |  { status: 'not_installed', org }        // the App isn't on that org
                  |  { status: 'not_configured' }            // no App id / private key
                  |  { status: 'member_identity' }           // see the guard below
```

**Guard — the member lane wins, absolutely.** If the run's `run_as` member has a linked GitHub token,
the route returns `member_identity` and the helper falls back to `$GH_TOKEN`. Otherwise a per-repo bot
token would silently re-author a human's PR as `agent-os[bot]` the moment they touched a second org —
the exact authorship confusion `docs/per-member-github-plan.md` exists to prevent. Cross-org unattended
work is the bot lane's job; a linked human keeps their own identity everywhere.

**Exposure.** The route hands back a credential of the same class the session already holds — an
org-scoped installation token — for an org the tenant's own App is installed on. No new class of
secret, and it cannot reach an org the App was never installed on. Audit `github.bot_token.minted`
carries the org; the helper's *hits* are deliberately not audited (git calls it on every fetch/push —
the in-memory cache in `src/connectors/github.ts:388` means a hit is usually not a mint).

## `gh` is not covered by a git credential helper

`gh pr create` reads `GH_TOKEN` and ignores git's helper, so §3 fixes `git` for both orgs but leaves
`gh` on the primary. Two answers, cheapest first:

- **Now — an MCP tool.** `github_token({ org })`, sibling of `github_refresh`
  (`src/memory/memory-mcp.ts:1683`), returning the export line for a named org. Same "hand the token
  back for the agent to re-export" pattern, including the "do not store or echo this" warning.
- **Later — a `gh` shim.** The ssh/scp shim (`terminal.ts`, `resolveBin`) is the precedent: a wrapper
  on PATH that reads the repo's `origin` remote, resolves the org, sets `GH_TOKEN` for that one
  invocation and execs the real binary. Fully transparent, but it has to guess the org for
  org-less commands (`gh api`, `gh auth status`), so it wants its own PR.

## Console (Settings → Integrations)

The GitHub card (`web/src/App.tsx:~19367`) grows an installations list once more than one is present:
each org, its repo selection (`all` / `selected`), and a radio for **primary** (the org `GH_TOKEN`
covers at launch). One org ⇒ the list stays hidden and the card looks exactly as it does today.
`GET /api/state`'s `github` block (`src/server.ts:7849`) gains `installations: [{id, account,
repositorySelection}]` and `primary`.

## Least privilege (optional, later)

`mintInstallationToken` already accepts a `repositories` / `permissions` narrowing. Once the per-repo
helper exists, the natural next step is minting a token scoped to *that one repo* rather than the
installation's full grant — a real blast-radius reduction, and only possible because §3 made
resolution per-repo. Out of scope here.

## Phases (each its own PR)

1. **Registry + per-installation cache** (§1 + §2) — `SettingsStore` accessors, `GithubIdentity`
   org-aware, `AOS_GH_ORGS` + the prompt block. No behaviour change for a one-org tenant.
2. **Per-repo git credentials** (§3) — the helper, the loopback route, the member-lane guard.
3. **`github_token({ org })`** — the `gh` answer.
4. **Console list + primary picker.**

## Tests

Extend `scripts/github-per-member-test.cjs` (stub `globalThis.fetch`, as it already does) and add
`scripts/github-multi-org-test.cjs` to `npm run test:governance`, pinning:

- two installations ⇒ both ids cached under distinct vault keys; the primary is the one injected;
- a legacy `github_bot_token` + `github_installation_id` pair migrates to the suffixed key and the
  same org stays primary (the rollback-safety claim);
- the helper's org parse: `path=globex/site.git` ⇒ the `globex` token, `path=` absent ⇒ `$GH_TOKEN`;
- **the guard**: a run with a linked member token gets `member_identity`, never a bot token;
- an org the App isn't installed on ⇒ `not_installed`, and `$GH_TOKEN` is left alone.
