/**
 * The ONE place an agent's editable config (manifest fields + CLAUDE.md) is written to disk from a
 * field delta, plus the snapshot helpers around it.
 *
 * This used to live inline in the owner-approve route in `src/server.ts`. It moved here when the
 * cross-agent proposal path grew a trust tier: a proposal from a HIGH-maturity agent applies without a
 * human (see `TerminalManager.proposeAgentUpdate`), so the same write has two callers — the owner's
 * approve route and the auto-apply lane. Sharing the primitive is what keeps the two identical: same
 * validation (claude-code + user-home only), same tuning sanitiser, same `agent.json`/`CLAUDE.md`
 * write, same re-register, and — critically — the same revision snapshot, so an auto-applied edit is
 * as revertable as a human-approved one.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AgentOS } from '../kernel';
import { AgentManifest, isCodingRuntime, runtimeTuningPatch, sanitizeCategory, sanitizeExamplePrompts, sanitizeIcon, sanitizeRuntimeTuning } from '../types';
import { AgentConfigSnapshot } from './agent-revisions';

/** The full editable state of an agent, from its manifest + on-disk CLAUDE.md — the unit revisions snapshot. */
export function manifestToSnapshot(ag: AgentManifest, claudeMd: string): AgentConfigSnapshot {
  return {
    description: ag.description ?? '',
    category: ag.category, icon: ag.icon,
    model: ag.model, effort: ag.effort, permissionMode: ag.permissionMode, verbosity: ag.verbosity,
    examplePrompts: ag.examplePrompts ?? [], shellSecrets: ag.shellSecrets ?? [],
    claudeMd,
  };
}

/** Read the agent's current on-disk snapshot (manifest fields + CLAUDE.md), to record as the "before". */
export function readAgentSnapshot(ag: AgentManifest): AgentConfigSnapshot {
  const file = ag.dir ? path.join(ag.dir, 'CLAUDE.md') : '';
  const claudeMd = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return manifestToSnapshot(ag, claudeMd);
}

/**
 * Is this agent editable at all? The same check the human self-edit route makes, so no proposal lane
 * can reach a target a person couldn't edit either: a CLI-backed agent living under the user-agents
 * root (never a bundled example shipped with the software).
 */
export function agentEditable(os: AgentOS, id: string): { ok: true; ag: AgentManifest } | { ok: false; error: string } {
  if (!os.paths) return { ok: false, error: 'editing agents requires a data home' };
  const ag = os.agents.get(id);
  if (!ag?.dir) return { ok: false, error: `unknown agent "${id}"` };
  if (!isCodingRuntime(ag.runtime)) return { ok: false, error: 'only CLI-backed agents can be edited' };
  const userRoot = path.resolve(os.paths.userAgents) + path.sep;
  if (!(path.resolve(ag.dir) + path.sep).startsWith(userRoot)) return { ok: false, error: 'built-in agents cannot be edited' };
  return { ok: true, ag };
}

/**
 * Apply a proposed field delta to an agent and snapshot the change as a revision.
 *
 * `fields` is the propose-time delta: only keys actually present are applied, everything else keeps its
 * current value (so a proposal that touches only `description` can't blank a CLAUDE.md). `author` is who
 * the revision is attributed to — the approving owner's email on the gated lane, `agent:<proposer>` when
 * a trusted agent applied it itself — and `summary` records both parties either way.
 */
export function applyAgentEdit(
  os: AgentOS,
  ag: AgentManifest,
  fields: Record<string, unknown>,
  opts: { summary: string; author: string },
): { ok: true; rev: number | null; target: string } | { ok: false; error: string } {
  // NB: no `runtime` arg — same as the self-edit and approve routes this shares. An agent-proposed model
  // is validated by the CLI at launch, not here, so the three lanes stay behaviourally identical.
  const { tuning, error } = sanitizeRuntimeTuning(runtimeTuningPatch(fields, ag, { fields: ['model', 'effort', 'verbosity'] }));
  if (error) return { ok: false, error };
  const before = readAgentSnapshot(ag);
  const description = 'description' in fields ? String(fields.description ?? '').trim() : ag.description;
  const category = 'category' in fields ? sanitizeCategory(fields.category) : ag.category;
  const icon = 'icon' in fields ? sanitizeIcon(fields.icon) : ag.icon;
  const examplePrompts = 'examplePrompts' in fields ? sanitizeExamplePrompts(fields.examplePrompts) : ag.examplePrompts;
  const next: AgentManifest = { ...ag, description, model: tuning.model, effort: tuning.effort, verbosity: tuning.verbosity, category, icon, examplePrompts };
  const { dir: _dir, ...onDisk } = next; // `dir` is set at load, not persisted
  fs.writeFileSync(path.join(ag.dir!, 'agent.json'), JSON.stringify(onDisk, null, 2) + '\n');
  if ('claudeMd' in fields) fs.writeFileSync(path.join(ag.dir!, 'CLAUDE.md'), String(fields.claudeMd ?? ''));
  os.registerAgent(next);
  const after = manifestToSnapshot(next, 'claudeMd' in fields ? String(fields.claudeMd ?? '') : before.claudeMd);
  const rev = os.agentRevisions.commit(os.tenant, ag.id, before, after, opts.summary, opts.author);
  return { ok: true, rev, target: ag.id };
}
