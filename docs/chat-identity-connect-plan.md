# Per-member Slack / Discord connect — plan

**Goal:** let a member link their Slack and Discord accounts with **one click** ("Sign in with Slack" /
"Connect Discord"), the same way they now Connect GitHub — instead of hunting for and hand-typing their
Slack member ID / Discord user ID into the **Chat IDs** editor. The OAuth round-trip verifies who they are
and auto-populates their `member_identities` row, which is what drives **per-member chat run-as** (a
Slack/Discord message from them runs the agent AS them).

## Scope decision — identity linking only, NOT posting-as-human

This is deliberately **half** of what GitHub connect does. GitHub connect gave us two things: an identity
mapping **and** a usable credential (the user token an agent `git push`es with). Slack/Discord only need
the first:

| | Identity link (this plan) | Per-member posting token (rejected) |
|---|---|---|
| Purpose | record the member's Slack/Discord **user id** for run-as | let an agent post **as the human** |
| Credential stored | **none** — just the id, one-shot | a per-member `xoxp-` / user token |
| Egress model | company **bot** keeps posting (unchanged) | agent impersonates the human |
| Discord | fine (`identify` scope) | **banned** — self/user-bots violate Discord ToS |
| Slack | fine (OIDC) | non-standard + impersonation risk |

So egress stays the **company bot** (Socket Mode / Gateway), which is the correct, supported model. We only
use OAuth to answer "who is this member on Slack/Discord?" and write it to the identity map. That makes this
**simpler** than GitHub: no token to persist, no launch-time injection, no refresh — one exchange, one
`setIdentity`, done.

## What links today (the thing we're improving)

`member_identities (provider, external_id, member_id)` maps a member to their Slack/Discord/email/GitHub
accounts. It's the join key chat triggers use for run-as:
- **Slack** (`src/edge/slack-socket.ts`): identity-map `slack` handle first, then Slack profile email →
  `getMemberByEmail`.
- **Discord** (`src/edge/discord-socket.ts`): identity-map `discord` user id (no email fallback — Discord
  exposes no email to the bot).

Today those handles are entered **manually** in the **Chat IDs** editor (`IdentityEditor`, on the Profile
page's *My chat identities* section + the Team page). Finding the values is the friction:
- Slack member id (`U0123ABCD`): Profile → ⋯ → *Copy member ID* (obscure).
- Discord user id (`123456789012345678`): requires enabling *Developer Mode* → right-click → *Copy ID*.

OAuth removes that entirely and guarantees the value is correct + really theirs.

## The OAuth flows

Both are standard OAuth2 authorization-code flows against the **existing company apps** (the Slack app that
already has app/bot tokens; the Discord bot application) — we just add their **client id + secret** and a
redirect URL. Reuse everything from the GitHub connect: the in-process CSRF `state` map bound to
`{tenant, memberId}`, the `return`-path (open-redirect-guarded) so a connect from the Profile page lands
back on the Profile, and the `?<provider>=connected|error` flag the card reads on return.

### Slack — "Sign in with Slack" (OpenID Connect)
- **Authorize:** `https://slack.com/openid/connect/authorize?response_type=code&client_id=…&scope=openid%20email%20profile&redirect_uri=<host>/api/slack/callback&state=…`
- **Token exchange:** `POST https://slack.com/api/openid.connect.token` (client_id + client_secret + code + redirect_uri) → an `id_token` (JWT).
- **Extract:** the Slack user id from the id_token claims (`https://slack.com/user_id`, or decode `sub`),
  plus `email`/`name` for display. → `setIdentity(me.id, 'slack', userId)`.
- **App setup:** add the OIDC redirect URL to the Slack app's **OAuth & Permissions**; scopes `openid email profile`.

### Discord — OAuth2 `identify`
- **Authorize:** `https://discord.com/oauth2/authorize?response_type=code&client_id=…&scope=identify%20email&redirect_uri=<host>/api/discord/callback&state=…`
- **Token exchange:** `POST https://discord.com/api/oauth2/token` (form-encoded) → an access token.
- **Extract:** `GET https://discord.com/api/users/@me` → `id` (+ `username`/`global_name`/`email` for display).
  → `setIdentity(me.id, 'discord', id)`. The access token is used once here then **discarded** (not stored).
- **App setup:** add the redirect URL to the Discord application's **OAuth2 → Redirects**.

## Configuration

New keys (mirroring `github_client_id` + vault `github_client_secret`), set in **Connections → Creds**:
- Slack: `slack_oauth_client_id` (setting) + `slack_oauth_client_secret` (vault, `*`).
- Discord: `discord_oauth_client_id` (setting) + `discord_oauth_client_secret` (vault, `*`).

These are the **same apps** already configured for Socket Mode / Gateway — the client id/secret live in the
app's Basic Information and are distinct from the bot/app-level tokens already stored. A provider's connect
button is only shown when its client id/secret are present.

## Endpoints (reuse the GitHub connect shape)

Generalise rather than copy-paste. Two options — pick one at implementation:
- **Per-provider:** `GET /api/slack/connect` + `/callback`, `GET /api/discord/connect` + `/callback`.
- **Generic (preferred):** `GET /api/identity/connect?provider=slack|discord[&return=…]` → `{ redirectUrl }`,
  and `GET /api/identity/callback/:provider?code&state` → validate state, exchange, `setIdentity`, redirect
  to `githubReturnRedirect`-style `<return>?<provider>=connected`.

Refactor the GitHub `newGithubState`/`takeGithubState`/`githubReturnRedirect` into a small provider-neutral
`oauthState` helper so all three (github, slack, discord) share one CSRF + return-path implementation.

## UI

In the **My chat identities** section (Profile) and the Team-page Chat IDs editor, put a **Connect Slack** /
**Connect Discord** button next to each provider's manual field — connecting fills the field (as GitHub
connect fills the github handle). Show a connected state ("Linked as @handle · Disconnect"). Keep the manual
text input as a fallback for anyone who prefers to paste an id or when OAuth isn't configured. A small
`ConnectIdentityButton({ provider })` component, analogous to `GithubMineCard` but lighter (no install/token
status — just linked / not-linked).

## Governance & security

- **CSRF:** single-use `state` bound to `{tenant, memberId}`, re-checked at callback == the logged-in member
  (same as GitHub). Prevents a leaked state linking someone else's account to you.
- **Open-redirect guard:** the `return` path is validated to a safe in-app hash route (reuse
  `githubReturnRedirect`).
- **No token at rest:** we store only the provider **user id** (already non-secret; it lives in
  `member_identities` today). Nothing new to encrypt or rotate.
- **Audit:** `slack.identity.linked` / `discord.identity.linked` (+ `…unlinked`), mirroring
  `github.user.connected`.
- **Uniqueness:** `member_identities` PK is `(provider, external_id)` — if two members link the same account,
  the last write wins (same as today's manual entry); consider surfacing a "this account is already linked
  to X" check at callback.

## Phases

1. **Shared OAuth helper** — extract the GitHub state/return-path machinery into a provider-neutral module;
   no behaviour change. Foundational.
2. **Slack connect** — config keys + `initiateSlackOAuth`/`exchangeSlackOIDC` (a thin client, zero-dep
   `fetch` like the others) + routes + Profile button.
3. **Discord connect** — the one-for-one mirror.
4. (Optional) **Team-page connect** for admins linking on someone's behalf — probably not; self-service on
   the Profile is the right model.

## Non-goals / open questions

- **No per-member posting** (see the scope decision). Egress remains the company bot.
- **Email scope:** requesting `email` lets us also fall back to email→member matching and show a friendlier
  "linked as", but it widens the consent screen. Slack's email-based run-as already works, so `email` is
  optional for Slack; for Discord it's the only extra signal (still no email at bot-event time, so it only
  helps display). Decide per provider.
- **Do we even need Discord's token step?** `identify` requires the code→token→`/users/@me` round-trip
  (Discord has no id_token). Slack's OIDC returns the id in the token directly (no second call). Minor
  asymmetry, already reflected above.

## Why this is worth doing

Per-member chat run-as is the mechanism that makes "a Slack message from Neha runs the agent *as Neha*"
work — but it only kicks in if Neha's Slack id is in the identity map, and today that requires her to go
find an obscure id and paste it. One-click connect is the difference between "a feature that works if you
configure it" and "a feature people actually turn on." It's cheap (no credential lifecycle, reuses the GitHub
connect plumbing) and it directly raises adoption of the run-as identity model.
