/**
 * Connectors — how a user plugs their own Slack / Gmail / GitHub (etc.) into Agent OS.
 *
 * The "easy" path reuses Claude Code's native connector mechanism: MCP servers. A connector
 * is just an MCP server config. When a claude-code agent session starts, the OS materialises
 * an `.mcp.json` from every enabled connector and hands it to claude via `--mcp-config`, so
 * the agent gains those tools with zero bespoke integration code — and every tool call still
 * passes the gateway's gate hook (see terminal/gate-hook.sh; the PreToolUse matcher covers
 * `mcp__*` so connector tool calls are classified by Policy just like shell commands).
 *
 * Two transports:
 *   - `stdio` — a local command (e.g. `npx @modelcontextprotocol/server-slack`) reading creds
 *     from its environment. The user supplies the per-app token themselves.
 *   - `http` / `sse` — a REMOTE MCP endpoint identified by a URL + auth headers. This is how
 *     hosted aggregators like Composio plug in: one connector exposes hundreds of apps with
 *     OAuth handled on their side, and we just hold the endpoint URL + API key.
 *
 * Configs (and the secrets they carry — `env` for stdio, `headers` for remote) are persisted in
 * the per-workspace SQLite DB (the `connectors` table), which lives in the gitignored data home.
 * For a local single-user tool that is the pragmatic store; a multi-tenant deployment would move
 * the secret values into the vault.
 */
import { Db } from '../state/db';
import { mintsUrl } from './composio';

export type Transport = 'stdio' | 'http' | 'sse';

/**
 * Who a connector belongs to:
 *   - `org`      — company-wide (e.g. the team Slack/ClickUp bot). Configured by owner/admin, fanned
 *     into EVERY member's sessions. One shared identity.
 *   - `personal` — owned by a single member (e.g. their own Gmail). Only ever injected into that
 *     member's own sessions, never another's. `ownerMemberId` names the owner.
 */
export type ConnectorScope = 'org' | 'personal';

/** A single entry in claude's `.mcp.json` `mcpServers` map — either a local command or a remote URL. */
export type McpServerSpec =
  | { command: string; args: string[]; env: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers: Record<string, string> };

export interface McpConnector {
  id: string;
  kind: 'mcp';
  /** slack | gmail | github | gdrive | composio | custom — drives the icon/label in the UI. */
  type: string;
  label: string;
  description: string;
  /** stdio = local command; http/sse = remote endpoint. */
  transport: Transport;
  /** stdio: launch command for the MCP server, e.g. `npx`. Empty for remote. */
  command: string;
  args: string[];
  /** remote: the MCP endpoint URL. Empty for stdio. */
  url: string;
  /** remote: request headers (auth lives here, e.g. `X-API-Key` / `Authorization`). gitignored data home. */
  headers: Record<string, string>;
  /** stdio: credentials the server reads from its environment. gitignored data home. */
  env: Record<string, string>;
  enabled: boolean;
  /** org = company-wide; personal = one member's own. Defaults to org for legacy rows. */
  scope: ConnectorScope;
  /** The owning member id (personal scope only). undefined for org connectors. */
  ownerMemberId?: string;
  /** Personal-only: the owner shared it team-wide, so it's injected into EVERY member's sessions
   *  (acting as the owner via the stored creds). Ignored for org connectors. */
  shared: boolean;
  createdAt: number;
}

/** A one-field-per-secret form descriptor — the UI renders these so adding a connector is fill-in-the-blanks. */
export interface CatalogField {
  /** The destination key: an env var (stdio), a header name (remote), or the literal `url`. */
  key: string;
  label: string;
  placeholder?: string;
  /** Where to get the value (shown as helper text). */
  help?: string;
  /** Where the value is written. Defaults to `env` (stdio); remote fields set `header` or `url`. */
  target?: 'env' | 'header' | 'url';
}

/** A ready-to-use connector template. Picking one + filling its fields = a working connector. */
export interface CatalogEntry {
  type: string;
  label: string;
  description: string;
  transport: Transport;
  /** stdio templates only. */
  command?: string;
  args?: string[];
  fields: CatalogField[];
}

/**
 * Built-in templates. These are real, publicly available MCP servers — the user only supplies
 * credentials. `custom` is the escape hatch: bring any MCP server by command + args + env.
 */
export const CATALOG: CatalogEntry[] = [
  {
    type: 'resend',
    label: 'Resend (email)',
    description: 'Send transactional & marketing email via the official resend-mcp server. Needs only a Resend API key.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'resend-mcp'],
    fields: [
      {
        key: 'RESEND_API_KEY',
        label: 'API key',
        placeholder: 're_…',
        help: 'Create one at resend.com/api-keys. Tip: enter secret:RESEND_API_KEY to pull it from the encrypted vault instead of storing it here.',
      },
      {
        key: 'SENDER_EMAIL_ADDRESS',
        label: 'Default sender (optional)',
        placeholder: 'you@yourdomain.com',
        help: 'An address on a domain you have verified in Resend, used as the default From when the agent omits one.',
      },
    ],
  },
  {
    type: 'custom',
    label: 'Custom (local)',
    description: 'Bring any stdio MCP server — supply its launch command, args, and environment.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '<package-name>'],
    fields: [],
  },
  {
    type: 'custom-remote',
    label: 'Custom (remote)',
    description: 'Bring any hosted MCP server — supply its HTTP/SSE endpoint URL and auth headers.',
    transport: 'http',
    fields: [],
  },
];

export interface AddConnectorInput {
  type: string;
  label?: string;
  description?: string;
  transport?: Transport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** org (default) or personal. A personal connector requires `ownerMemberId`. */
  scope?: ConnectorScope;
  /** Owning member id — required when scope is personal; ignored for org. */
  ownerMemberId?: string;
}

/** Strip a string down to a filesystem/id-safe slug. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'connector';
}

interface ConnectorRow {
  id: string;
  type: string;
  label: string;
  description: string;
  transport: string;
  command: string;
  args: string;
  url: string;
  headers: string;
  env: string;
  enabled: number;
  scope: string | null;
  owner_member_id: string | null;
  shared: number | null;
  created_at: number;
}

function toConnector(r: ConnectorRow): McpConnector {
  return {
    id: r.id,
    kind: 'mcp',
    type: r.type,
    label: r.label,
    description: r.description,
    transport: (r.transport as Transport) || 'stdio',
    command: r.command,
    args: JSON.parse(r.args) as string[],
    url: r.url || '',
    headers: JSON.parse(r.headers || '{}') as Record<string, string>,
    env: JSON.parse(r.env) as Record<string, string>,
    enabled: !!r.enabled,
    scope: r.scope === 'personal' ? 'personal' : 'org',
    ownerMemberId: r.owner_member_id ?? undefined,
    shared: !!r.shared,
    createdAt: r.created_at,
  };
}

export class ConnectorStore {
  constructor(private readonly db: Db) {}

  list(): McpConnector[] {
    return this.db.prepare('SELECT * FROM connectors ORDER BY created_at').all<ConnectorRow>().map(toConnector);
  }

  get(id: string): McpConnector | undefined {
    const r = this.db.prepare('SELECT * FROM connectors WHERE id = ?').get<ConnectorRow>(id);
    return r ? toConnector(r) : undefined;
  }

  add(input: AddConnectorInput): McpConnector {
    const template = CATALOG.find((c) => c.type === input.type);
    const transport: Transport = input.transport || template?.transport || 'stdio';
    const command = (input.command || template?.command || '').trim();
    const args = input.args ?? template?.args ?? [];
    const url = (input.url || '').trim();
    const headers = input.headers ?? {};
    // A connector must be reachable: stdio needs a launch command, a remote connector needs an
    // endpoint URL — UNLESS its URL is minted at launch (Composio), in which case it just needs its
    // API key, and the per-user session URL is fetched when an agent session starts.
    if (transport === 'stdio') {
      if (!command) throw new Error('a launch command is required');
    } else if (!mintsUrl(input.type) && !url) {
      // Minted connectors (Composio) need no stored URL — it's fetched per session. The API key is
      // optional too: it can live on the connector OR in workspace Settings → Integrations (the
      // company key), which the mint falls back to. A non-minted remote connector still needs a URL.
      throw new Error('a server URL is required for a remote connector');
    }

    // Ownership: personal connectors must name their owner; org connectors never carry one.
    const scope: ConnectorScope = input.scope === 'personal' ? 'personal' : 'org';
    if (scope === 'personal' && !input.ownerMemberId) throw new Error('a personal connector requires an owner');
    const ownerMemberId = scope === 'personal' ? input.ownerMemberId : undefined;

    const existing = new Set(this.db.prepare('SELECT id FROM connectors').all<{ id: string }>().map((r) => r.id));
    const base = slug(input.label || template?.label || input.type);
    let id = base;
    for (let n = 2; existing.has(id); n++) id = `${base}-${n}`;

    const connector: McpConnector = {
      id,
      kind: 'mcp',
      type: input.type || 'custom',
      label: input.label || template?.label || input.type,
      description: input.description || template?.description || '',
      transport,
      command: transport === 'stdio' ? command : '',
      args: transport === 'stdio' ? args : [],
      url: transport === 'stdio' ? '' : url,
      headers: transport === 'stdio' ? {} : headers,
      env: transport === 'stdio' ? input.env ?? {} : {},
      enabled: true,
      scope,
      ownerMemberId,
      shared: false,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO connectors (id, type, label, description, transport, command, args, url, headers, env, enabled, scope, owner_member_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        connector.id, connector.type, connector.label, connector.description, connector.transport,
        connector.command, JSON.stringify(connector.args), connector.url, JSON.stringify(connector.headers),
        JSON.stringify(connector.env), 1, connector.scope, connector.ownerMemberId ?? null, connector.createdAt,
      );
    return connector;
  }

  setEnabled(id: string, enabled: boolean): McpConnector | undefined {
    const res = this.db.prepare('UPDATE connectors SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return res.changes ? this.get(id) : undefined;
  }

  /** Share (or un-share) a PERSONAL connector with the whole team. No-op (undefined) for org connectors. */
  setShared(id: string, shared: boolean): McpConnector | undefined {
    const c = this.get(id);
    if (!c || c.scope !== 'personal') return undefined;
    this.db.prepare('UPDATE connectors SET shared = ? WHERE id = ?').run(shared ? 1 : 0, id);
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM connectors WHERE id = ?').run(id).changes > 0;
  }

  /** Delete a member's PERSONAL connectors (their own stored credentials) — called when the member is
   *  removed, so their secrets don't outlive the account. Org connectors (shared) are untouched.
   *  Returns the removed connector ids. */
  removeByOwner(memberId: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM connectors WHERE scope = 'personal' AND owner_member_id = ?")
      .all(memberId) as Array<{ id: string }>;
    this.db.prepare("DELETE FROM connectors WHERE scope = 'personal' AND owner_member_id = ?").run(memberId);
    return rows.map((r) => r.id);
  }

  /**
   * Does this connector belong in `memberId`'s sessions?
   *   - `org`                  → everyone (one shared company identity).
   *   - `personal` + `shared`  → everyone, acting as the owner (the owner explicitly shared their own
   *     credentials team-wide); also injected into automation/system spawns (memberId undefined).
   *   - `personal` + private   → ONLY its owner; never another member's or a system spawn's session.
   */
  private boundTo(c: McpConnector, memberId?: string): boolean {
    if (c.scope !== 'personal') return true;
    if (c.shared) return true;
    return !!memberId && c.ownerMemberId === memberId;
  }

  /**
   * The claude `--mcp-config` payload for the member spawning the session: every ENABLED connector
   * BOUND TO that member (all org connectors + that member's own personal ones) as an MCP server.
   * stdio connectors emit `{ command, args, env }`; remote ones emit `{ type, url, headers }`.
   * Connectors whose URL is minted at launch (Composio) are SKIPPED here and layered on by the
   * launcher (see TerminalManager.writeMcpConfig), so their API key never lands in the file and each
   * session gets a fresh per-user endpoint.
   */
  mcpConfig(memberId?: string): { mcpServers: Record<string, McpServerSpec> } {
    const mcpServers: Record<string, McpServerSpec> = {};
    for (const c of this.list()) {
      if (!c.enabled || mintsUrl(c.type) || !this.boundTo(c, memberId)) continue;
      mcpServers[c.id] =
        c.transport === 'stdio'
          ? { command: c.command, args: c.args, env: c.env }
          : { type: c.transport, url: c.url, headers: c.headers };
    }
    return { mcpServers };
  }

  /**
   * Enabled connectors whose endpoint is minted at launch (Composio), bound to `memberId`. The
   * launcher resolves these per-session. A personal Composio connector only mints for its owner.
   */
  dynamic(memberId?: string): McpConnector[] {
    return this.list().filter((c) => c.enabled && mintsUrl(c.type) && this.boundTo(c, memberId));
  }

  /**
   * Connectors a console viewer may see: every org connector + every SHARED personal connector (the
   * whole team gets them, so the team can see they exist), plus PRIVATE personal connectors — their
   * own only for a regular member, or everyone's for an owner/admin (governance oversight). Secrets
   * are still redacted by the caller; this only decides which rows are listed.
   */
  listForConsole(viewerId: string, isAdmin: boolean): McpConnector[] {
    return this.list().filter((c) => c.scope !== 'personal' || c.shared || isAdmin || c.ownerMemberId === viewerId);
  }

  hasEnabled(): boolean {
    return this.db.prepare('SELECT COUNT(*) AS n FROM connectors WHERE enabled = 1').get<{ n: number }>()!.n > 0;
  }
}

/**
 * Strip secret VALUES before sending a connector to the browser — keep the KEYS for display.
 * Covers both stdio creds (`env`) and remote auth (`headers`); the endpoint `url` is kept (no secret).
 */
export function redact(c: McpConnector): Omit<McpConnector, 'env' | 'headers'> & { envKeys: string[]; headerKeys: string[] } {
  const { env, headers, ...rest } = c;
  return { ...rest, envKeys: Object.keys(env), headerKeys: Object.keys(headers) };
}
