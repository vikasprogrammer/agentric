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
  /** Append-only audit event store for this instance. */
  audit: string;
  /** Per-instance tmux socket (under the home → instances don't collide). */
  tmuxSocket: string;
  /** Per-instance server log. */
  logFile: string;
  /** Resolved policy file: the user's if present, else the bundled default. */
  policyFile: string;
}

export interface HomeConfig {
  home?: string;
  agentsDir?: string;
  policyDir?: string;
}

export function resolvePaths(baseDir: string, cfg: HomeConfig = {}): Paths {
  const fromEnv = process.env.AGENT_OS_HOME;
  const home = fromEnv
    ? path.resolve(process.cwd(), fromEnv)
    : path.resolve(baseDir, cfg.home || 'data');

  const bundledAgents = path.resolve(baseDir, cfg.agentsDir || 'config/agents');
  const userPolicy = path.join(home, 'policy', 'default.policy.json');
  const bundledPolicy = path.resolve(baseDir, cfg.policyDir || 'config/policy', 'default.policy.json');

  return {
    home,
    bundledAgents,
    userAgents: path.join(home, 'agents'),
    audit: path.join(home, 'audit'),
    tmuxSocket: path.join(home, 'tmux.sock'),
    logFile: path.join(home, 'server.log'),
    policyFile: fs.existsSync(userPolicy) ? userPolicy : bundledPolicy,
  };
}
