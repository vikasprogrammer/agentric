/**
 * Pre-fetch the npm package behind every `npx` connector, so a session's MCP server starts warm.
 *
 * Claude Code starts each stdio MCP server when the session launches and gives up on one that has not
 * answered `initialize` in time. A cold `npx -y <pkg>@<ver>` downloads and installs the package first:
 * measured 21s (`dataforseo-mcp-server@2.9.13`) and 35s (`@3.1.3`) on the Mac Mini, against ~0.6s
 * warm. So the first session after a connector is added, or after npm evicts its cache, comes up with
 * the connector silently missing. That reads exactly like the connector being "flaky".
 *
 * `npx -y --package=<spec> -- node -e 0` installs into the SAME `_npx` cache entry a later
 * `npx -y <spec>` resolves (the cache key is the package list, not the command run), then exits at
 * once without starting the server. Fire-and-forget, async (`spawn`, never `spawnSync`, which stalls
 * the single-threaded server), and at most one in flight per spec.
 */
import { spawn } from 'node:child_process';
import type { McpConnector } from './connectors';
import type { AgentOS } from '../kernel';

/** The package spec an `npx` connector launches (`resend-mcp`, `dataforseo-mcp-server@3.1.3`), or
 *  undefined when it isn't an npx launch or the spec can't be read off its args. */
export function npxSpec(c: Pick<McpConnector, 'transport' | 'command' | 'args'>): string | undefined {
  if (c.transport !== 'stdio' || c.command.trim() !== 'npx') return undefined;
  for (const a of c.args) {
    if (a === '-y' || a === '--yes') continue;
    if (a.startsWith('--package=')) return a.slice('--package='.length) || undefined;
    if (a.startsWith('-')) return undefined; // an option we don't model — don't guess
    return a;
  }
  return undefined;
}

const WARM_TIMEOUT_MS = 5 * 60_000;
const inFlight = new Set<string>();

export type WarmRunner = (spec: string) => Promise<boolean>;

const npxRunner: WarmRunner = (spec) => new Promise((resolve) => {
  let child;
  try {
    child = spawn('npx', ['-y', `--package=${spec}`, '--', 'node', '-e', '0'], { stdio: 'ignore', env: process.env });
  } catch { resolve(false); return; }
  const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, WARM_TIMEOUT_MS);
  child.on('error', () => { clearTimeout(t); resolve(false); });
  child.on('exit', (code) => { clearTimeout(t); resolve(code === 0); });
});

/** Warm every ENABLED npx connector. Returns the specs it started; `onDone` reports each outcome. */
export function warmNpxConnectors(
  connectors: McpConnector[],
  onDone?: (spec: string, ok: boolean) => void,
  run: WarmRunner = npxRunner,
): string[] {
  const started: string[] = [];
  for (const c of connectors) {
    if (!c.enabled) continue;
    const spec = npxSpec(c);
    if (!spec || inFlight.has(spec)) continue;
    inFlight.add(spec);
    started.push(spec);
    void run(spec)
      .catch(() => false)
      .then((ok) => { inFlight.delete(spec); try { onDone?.(spec, ok); } catch { /* advisory */ } });
  }
  return started;
}

/** Warm a tenant's npx connectors (all enabled ones, or just `only`), auditing each fetch's outcome as
 *  `connector.warmed`. A failure isn't fatal: the session's own `npx` will try the same install. */
export function warmConnectorPackages(os: AgentOS, only?: McpConnector[]): string[] {
  try {
    return warmNpxConnectors(only ?? os.connectors.list(), (spec, ok) => {
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: 'system', type: 'connector.warmed', data: { spec, ok } });
    });
  } catch { return []; }
}
