# DataForSEO

SEO data (SERPs, keyword volumes, Labs, backlinks, on-page) for agents, via DataForSEO's **official MCP
server run locally over stdio**, authenticated with the API login and password from the vault.

## Why not the hosted URL

DataForSEO also hosts the server at `https://mcp.dataforseo.com/mcp` (v2) and `…/v3/mcp`. Added as a
`custom-remote` connector with no headers, that endpoint authorizes with **OAuth**, and the grant lives in
Claude Code's own per-config-dir store. That is what made DataForSEO "keep disconnecting":

- the grant expires, and refreshing it needs a browser;
- it lives in ONE config dir, so a run on a pooled runtime account (or under
  `AOS_CLAUDE_CONFIG_ISOLATION`) has no grant at all;
- when it is missing, Claude Code doesn't fail the server. It replaces every DataForSEO tool with
  `authenticate` / `complete_authentication` stubs, and an unattended run can't finish them. One tenant's
  transcripts held 20 such stub calls.

On stdio there is no OAuth: each tool call is a plain Basic-auth REST call, with nothing to expire and no
remote session to drop.

## Setup

1. **Settings → Secrets**: store `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` tenant-wide. These are the
   **API** credentials from <https://app.dataforseo.com/api-access>, not the dashboard login.
2. **Connectors → Add**, pick one of:
   - **DataForSEO**: `dataforseo-mcp-server@3.1.3`. Four tools: `api_request` (`{method, path, data}`)
     plus `docs_index` / `docs_list_sections` / `docs_search`.
   - **DataForSEO (v2 tools)**: `dataforseo-mcp-server@2.9.13`. 89 per-endpoint tools
     (`serp_organic_live_advanced`, `kw_data_google_ads_search_volume`, …). Use it when agent prompts or
     skills already name those tools.
3. Fill both fields with `secret:DATAFORSEO_LOGIN` / `secret:DATAFORSEO_PASSWORD`. They are resolved from
   the vault at launch, and an unresolvable reference is blanked and audited as
   `connector.secret.unresolved`.

**Keep the connector's NAME when replacing an old one.** The MCP server key is the connector id (a slug of
its label), and tool names are `mcp__<id>__<tool>`. Replacing a `DataforSEO` connector with one labelled
`DataForSEO` keeps `mcp__dataforseo__*`; a doosra-style `DFS` keeps `mcp__dfs__*`.

## Versions are pinned on purpose

v2 → v3 renamed the entire tool surface, so an unpinned `@latest` would silently break every prompt that
names a tool. Move to a new version deliberately: re-add the connector, then update the prompts.

## Cold start

`npx` installs the package on first use: 21s (v2) to 35s (v3) measured on the Mac Mini, against ~0.6s
warm. That is close enough to Claude Code's MCP startup timeout to drop the server from a session. So the
server pre-fetches every enabled `npx` connector's package at boot and when one is added or re-enabled
(`src/connectors/npx-warm.ts`, audited `connector.warmed` `{spec, ok}`).

## When a remote connector loses auth anyway

This applies to any remote MCP connector, Composio's Tool Router included. A call to an
`mcp__<server>__authenticate` / `__complete_authentication` stub reaches the gate, which:

- audits `connector.auth.lost` `{connector, step, unattended, url?}`;
- posts ONE admin card per connector per 6h (`system:connector-auth:<server>`), naming the connector and
  the fix (for the hosted DataForSEO URL: switch to the catalog entry);
- on an **unattended** run (headless, not taken over), refuses the call and tells the agent to carry on
  without the connector or report it as blocked. An attended session goes through the normal policy, since
  its human can finish the login.

`src/connectors/mcp-auth-stub.ts`; pinned by `scripts/connector-auth-stub-test.cjs`.
