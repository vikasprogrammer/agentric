/**
 * A remote MCP connector that lost its authorization, detected from the one signal that is certain.
 *
 * When a remote (http/sse) MCP server answers 401 at session start, Claude Code does not fail the
 * server. It starts the OAuth discovery flow and replaces the server's tools with two stubs,
 * `mcp__<server>__authenticate` and `mcp__<server>__complete_authentication`. The agent sees a tool
 * list with nothing it asked for. The stubs return a browser URL, and an unattended run has nobody to
 * open it.
 *
 * Seen live twice with two different causes:
 *   - DataForSEO's hosted URL (`mcp.dataforseo.com`) with no headers, so authorized by an OAuth grant
 *     in Claude Code's own store. The grant expires and is absent on a pooled runtime account.
 *     20 stub calls in one tenant's transcripts.
 *   - initech's `composio-company` Tool Router came up unauthenticated from 2026-09-08 and took GSC,
 *     GA4, DataForSEO, Stripe and Sheets dark with it. Agents filed tasks about it; nothing told an
 *     admin it was down.
 *
 * Calling a stub IS the detection: it is a connector tool call, so it reaches the gate. The gate turns
 * it into a refusal the agent can act on and one admin card per connector.
 */

export interface AuthStub {
  /** The MCP server name: the connector id, or `composio` / `composio-company`. */
  server: string;
  step: 'authenticate' | 'complete_authentication';
}

const STUB = /^mcp__(.+)__(authenticate|complete_authentication)$/;

/** Parse a tool name. Only Claude Code's `mcp__<server>__<stub>` spelling: the stubs are its own, and
 *  codex/opencode don't run an OAuth flow for a 401. */
export function parseAuthStub(tool: unknown): AuthStub | null {
  if (typeof tool !== 'string') return null;
  const m = STUB.exec(tool);
  if (!m || m[1] === 'agentos') return null;
  return { server: m[1], step: m[2] as AuthStub['step'] };
}

export interface StubConnectorInfo {
  /** Display label, when the server maps to a connector row. */
  label?: string;
  /** Its URL, when it is a remote connector row. */
  url?: string;
  /** Composio's minted servers, which have no connector row. */
  composio?: boolean;
}

/** DataForSEO's hosted endpoint. On that URL the fix is the stdio catalog entry, not a re-login. */
export function isHostedDataForSeo(url: string | undefined): boolean {
  return !!url && /(^|\/\/)mcp\.dataforseo\.com(\/|$)/i.test(url);
}

/** The fix to suggest, phrased for an admin. */
export function authStubRemedy(info: StubConnectorInfo): string {
  if (isHostedDataForSeo(info.url)) {
    return 'This connector points at DataForSEO\'s hosted MCP URL, which authorizes with an OAuth login that expires. '
      + 'Replace it with the "DataForSEO" (or "DataForSEO (v2 tools)") connector from the catalog: it runs locally with your API login from the vault and has nothing to expire. '
      + 'Keep the same connector name so agents\' tool names don\'t change.';
  }
  if (info.composio) {
    return 'This is a Composio Tool Router session. Check the Composio API key in Settings → Integrations, and that the app\'s connection is still active in Composio.';
  }
  return 'Check the credentials in the connector\'s auth headers. A remote connector with no auth header falls back to an OAuth login that expires and cannot be completed by an unattended run; give it a header (or an API-key based connector) instead.';
}

/** What the agent is told, in place of the stub. */
export function authStubDenial(stub: AuthStub, unattended: boolean): string {
  const lead = `Agentric: the "${stub.server}" connector has lost its authorization. Its real tools are unavailable in this session, and Claude Code put this ${stub.step} stub in their place.`;
  if (unattended) {
    return `${lead} This run is unattended, so there is nobody to complete a browser login, and the admins have been notified. Do not retry it or look for another way to log in. Carry on without "${stub.server}" if the task allows, otherwise say in your report that it was blocked on this connector.`;
  }
  return `${lead} The admins have been notified.`;
}
