/**
 * Fleet-agent-as-sub-agent materialisation.
 *
 * Claude Code has a native, in-process sub-agent runtime: the built-in `Agent`/Task tool spawns a
 * child defined by a `.claude/agents/<name>.md` file (frontmatter + persona), runs it to completion,
 * and returns its result inline — sub-second, no separate process. Agent OS piggybacks on it: when a
 * parent agent's manifest opts in via `usableSubagents`, we render EACH named fleet teammate into the
 * parent's `<dir>/.claude/agents/<id>.md` at launch, exactly like the skills library is synced into
 * `.claude/skills`. The running claude can then delegate a slice of its OWN turn to a teammate persona
 * without filing a task or spawning a governed session — the lightweight counterpart to `task_dispatch`.
 *
 * The invariant survives because a native sub-agent runs IN THE SAME PROCESS as the parent session:
 * the PreToolUse gate hook fires for the sub-agent's tool calls too (Claude Code passes `agent_type`/
 * `agent_id` on the hook input), so every effect is still classified/approved/budgeted/audited — under
 * THIS session's principal + budget, tagged with which sub-agent produced it. The only real guardrails
 * on "how big can a session amplify itself" are therefore (a) the `usableSubagents` allow-list and
 * (b) the capped toolset below — deliberately excluding proactive egress (`slack_send`/`discord_send`),
 * the secrets tools, `publish`, and the operator/inbox surface. A sub-agent is a worker for the current
 * turn, not an independent citizen. See docs/subagents-plan.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AgentManifest } from '../types';

/**
 * The toolset a materialised fleet sub-agent is allowed to use, written verbatim into the `tools:`
 * frontmatter (a Claude Code allow-list; anything not listed is unavailable to the child). Chosen to
 * be a genuinely useful worker whose risky actions are STILL gated — Bash/Edit/Write pass the gate
 * hook — while withholding the amplifying tools a delegate has no business reaching under the parent's
 * identity: proactive egress, the vault, `publish`, `ask`/`report`, agent/policy self-mutation. The
 * OS-owned memory RECALL tools are included so the child has read context; writes/forget are not.
 */
export const SUBAGENT_DEFAULT_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'Bash',
  'Edit',
  'Write',
  'mcp__agentos__recall',
  'mcp__agentos__kb_search',
  'mcp__agentos__kb_read',
];

/** Marker file listing the `.md` files we manage, so a re-sync refreshes ONLY ours and leaves any
 *  hand-authored per-agent sub-agents in `.claude/agents/` untouched (mirrors skills' `.aos-managed`). */
const INDEX = '.aos-managed.json';

/** Escape a value for a single-line YAML frontmatter scalar (description can contain colons/quotes). */
function yamlScalar(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Render one fleet manifest as a Claude Code sub-agent definition (frontmatter + persona body). */
export function renderSubagentMd(delegate: AgentManifest, tools: readonly string[]): string {
  const persona = readPersona(delegate);
  const lines = [
    '---',
    `name: ${delegate.id}`,
    `description: ${yamlScalar(delegate.description || `The ${delegate.id} agent.`)}`,
    `tools: ${tools.join(', ')}`,
  ];
  if (delegate.model) lines.push(`model: ${delegate.model}`);
  lines.push('---', '');
  lines.push(
    `You are the **${delegate.id}** agent, invoked as a sub-agent to handle a focused slice of a`,
    `teammate's task. Do the work, then return your result — it becomes the caller's tool result, not a`,
    `message to a human. ${delegate.description || ''}`.trim(),
    '',
  );
  if (persona) {
    lines.push('---', '', '# Your operating instructions', '', persona.trim(), '');
  }
  return lines.join('\n');
}

/** The delegate's own CLAUDE.md is its persona/system prompt when launched normally; embed it so the
 *  sub-agent adopts the same behaviour. Best-effort — a missing/oversized file just yields no body. */
function readPersona(delegate: AgentManifest): string {
  if (!delegate.dir) return '';
  try {
    const p = path.join(delegate.dir, 'CLAUDE.md');
    const stat = fs.statSync(p);
    if (stat.size > 64 * 1024) return ''; // don't inline a runaway file
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Decide which fleet teammates a parent may spawn as sub-agents, given the fleet-wide posture:
 *  - A teammate must be **eligible**: a different agent, `claude-code` runtime, and NOT opted out
 *    (`spawnableAsSubagent !== false`). The opt-out is absolute — an internal agent is excluded even
 *    if a parent lists it explicitly.
 *  - If the parent declares a non-empty `usableSubagents`, that's a **narrowing override**: exactly the
 *    listed (and eligible) teammates, whatever the default.
 *  - Otherwise the default posture applies: `'all'` ⇒ every eligible teammate; `'none'` ⇒ none.
 */
export function resolveSubagents(
  parent: AgentManifest,
  fleet: Map<string, AgentManifest>,
  defaultMode: 'all' | 'none',
): AgentManifest[] {
  const eligible = (m: AgentManifest | undefined): m is AgentManifest =>
    !!m && m.id !== parent.id && m.runtime === 'claude-code' && m.spawnableAsSubagent !== false;
  const explicit = parent.usableSubagents ?? [];
  if (explicit.length) return explicit.map((id) => fleet.get(id)).filter(eligible);
  return defaultMode === 'all' ? [...fleet.values()].filter(eligible) : [];
}

/**
 * Sync the parent agent's sub-agents into `<claudeDir>/agents/*.md`. Returns the delegate ids
 * actually written. Idempotent and safe to call every launch:
 *  - the `.claude/agents` dir is always ensured (Claude only watches a dir that existed at startup);
 *  - files we previously managed but no longer should (removed from the list / gone from the fleet)
 *    are deleted, tracked via the `.aos-managed.json` index;
 *  - hand-authored `.md` files not in our index are never touched;
 *  - membership is decided by {@link resolveSubagents} (fleet-wide `defaultMode` + the parent's
 *    `usableSubagents` override + each teammate's `spawnableAsSubagent` opt-out).
 * Best-effort by contract: the caller wraps this so a failure never blocks a session launch.
 */
export function materializeSubagents(
  claudeDir: string,
  parent: AgentManifest,
  fleet: Map<string, AgentManifest>,
  defaultMode: 'all' | 'none' = 'all',
  tools: readonly string[] = SUBAGENT_DEFAULT_TOOLS,
): string[] {
  const agentsDir = path.join(claudeDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  const wanted = resolveSubagents(parent, fleet, defaultMode);

  // Remove files we managed last time but shouldn't now (deselected or vanished from the fleet).
  const prev = readIndex(agentsDir);
  const nextNames = new Set(wanted.map((m) => `${m.id}.md`));
  for (const stale of prev) {
    if (!nextNames.has(stale)) {
      try { fs.rmSync(path.join(agentsDir, stale), { force: true }); } catch { /* best-effort */ }
    }
  }

  const written: string[] = [];
  for (const delegate of wanted) {
    try {
      fs.writeFileSync(path.join(agentsDir, `${delegate.id}.md`), renderSubagentMd(delegate, tools));
      written.push(delegate.id);
    } catch { /* skip a single unwritable delegate, keep the rest */ }
  }
  writeIndex(agentsDir, written.map((id) => `${id}.md`));
  return written;
}

function readIndex(agentsDir: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(agentsDir, INDEX), 'utf8'));
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeIndex(agentsDir: string, names: string[]): void {
  try {
    if (names.length) fs.writeFileSync(path.join(agentsDir, INDEX), JSON.stringify(names));
    else fs.rmSync(path.join(agentsDir, INDEX), { force: true });
  } catch { /* best-effort */ }
}
