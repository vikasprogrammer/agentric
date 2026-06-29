/**
 * The data home — where an instance's USER-OWNED state lives, separate from the software.
 *
 *   agent-os (the repo)  = the software: src/, web/, bundled example agents + default policy.
 *   AGENT_OS_HOME        = the user's data: their agents, their policy, audit, runtime sockets.
 *
 * The home is configurable so you can (a) keep your data outside the repo / in its own private
 * git repo, and (b) run SEVERAL agent-os instances on one machine — each gets a distinct home,
 * and the tmux socket + logs live *inside* the home, so instances never collide. Pair a distinct
 * home with a distinct PORT and the two are fully isolated.
 *
 * Resolution order for the home root:
 *   1. $AGENT_OS_HOME            (env — resolved against the CWD; absolute paths win)
 *   2. `home` in the config file (resolved against the repo baseDir)
 *   3. <baseDir>/data            (default — already gitignored)
 */
import * as fs from 'fs';
import * as path from 'path';

export interface Paths {
  /** User-owned data root for this instance. */
  home: string;
  /** Bundled example agents that ship with the software (read-only fixtures/seeds). */
  bundledAgents: string;
  /** The user's own agents — each a folder Claude can open and write into. */
  userAgents: string;
  /** The user's connectors (MCP server configs + their credentials). */
  connectors: string;
  /** The workspace skills library — global Claude Code Skills materialised into every agent. */
  skills: string;
  /** The deliverables gallery: snapshotted artifacts agents publish (`<id>/<filename>`). */
  artifacts: string;
  /** The company knowledge base: living wiki pages (`kb/<section>/<slug>.md`). */
  kb: string;
  /** Append-only audit event store for this instance. */
  audit: string;
  /** Per-workspace SQLite database (team/login, connectors, sessions, approvals, audit mirror). */
  db: string;
  /** Per-instance tmux socket (under the home → instances don't collide). */
  tmuxSocket: string;
  /** Per-instance server log. */
  logFile: string;
  /** Resolved policy file: the user's if present, else the bundled default. */
  policyFile: string;
  /** Where a console-edited policy override is written (the user's policy file in the home). */
  policyOverride: string;
}

export interface HomeConfig {
  home?: string;
  agentsDir?: string;
  policyDir?: string;
}

/** The data-home ROOT for this process (`$AGENT_OS_HOME` → config `home` → `<baseDir>/data`). */
export function homeRoot(baseDir: string, cfg: HomeConfig = {}): string {
  const fromEnv = process.env.AGENT_OS_HOME;
  return fromEnv ? path.resolve(process.cwd(), fromEnv) : path.resolve(baseDir, cfg.home || 'data');
}

/**
 * Per-tenant paths for the multi-tenant registry. Every per-instance path nests under
 * `<home>/tenants/<tenantId>/` so many tenants share one process without colliding (each gets its
 * own DB, tmux socket, audit dir, connectors, skills, artifacts, kb, log). The DEFAULT tenant keeps
 * the legacy un-nested home via `resolvePaths`, so existing single-tenant installs need no migration.
 */
export function resolveTenantPaths(baseDir: string, cfg: HomeConfig, tenantId: string): Paths {
  const tenantHome = path.join(homeRoot(baseDir, cfg), 'tenants', tenantId);
  return pathsUnder(baseDir, cfg, tenantHome);
}

/** The control-plane home — `<home>/control/` — holds the tenant registry DB (never a tenant's). */
export function controlHome(baseDir: string, cfg: HomeConfig = {}): string {
  return path.join(homeRoot(baseDir, cfg), 'control');
}

export function resolvePaths(baseDir: string, cfg: HomeConfig = {}): Paths {
  return pathsUnder(baseDir, cfg, homeRoot(baseDir, cfg));
}

/** Derive the full Paths tree rooted at `home` (shared by the default + per-tenant resolvers). */
function pathsUnder(baseDir: string, cfg: HomeConfig, home: string): Paths {
  const bundledAgents = path.resolve(baseDir, cfg.agentsDir || 'config/agents');
  const userPolicy = path.join(home, 'policy', 'default.policy.json');
  const bundledPolicy = path.resolve(baseDir, cfg.policyDir || 'config/policy', 'default.policy.json');

  return {
    home,
    bundledAgents,
    userAgents: path.join(home, 'agents'),
    connectors: path.join(home, 'connectors'),
    skills: path.join(home, 'skills'),
    artifacts: path.join(home, 'artifacts'),
    kb: path.join(home, 'kb'),
    audit: path.join(home, 'audit'),
    db: path.join(home, 'agent-os.db'),
    tmuxSocket: path.join(home, 'tmux.sock'),
    logFile: path.join(home, 'server.log'),
    policyFile: fs.existsSync(userPolicy) ? userPolicy : bundledPolicy,
    policyOverride: userPolicy,
  };
}
