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
 *
 * It also owns the SAFETY primitives every agent-driven edit shares — {@link resolveClaudeMd} (anchored
 * patches, so "add a section" isn't expressed as "retype 20KB perfectly"), {@link contentHash} (the
 * optimistic-concurrency handle) and {@link assessClaudeMdEdit} (the shrink/dropped-heading guard). They
 * live here rather than in either caller because the self-edit lane and the cross-agent lanes are equally
 * destructive: the incident that motivated them was one of each, minutes apart.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentOS } from '../kernel';
import { AgentManifest, isCodingRuntime, runtimeTuningPatch, sanitizeCategory, sanitizeExamplePrompts, sanitizeIcon, sanitizeRuntimeTuning, sanitizeShellSecrets, sanitizeAgentSkills, sanitizeAgentTools } from '../types';
import { AgentConfigSnapshot } from './agent-revisions';

/** The full editable state of an agent, from its manifest + on-disk CLAUDE.md — the unit revisions snapshot. */
export function manifestToSnapshot(ag: AgentManifest, claudeMd: string): AgentConfigSnapshot {
  return {
    description: ag.description ?? '',
    category: ag.category, icon: ag.icon,
    model: ag.model, effort: ag.effort, permissionMode: ag.permissionMode, verbosity: ag.verbosity,
    examplePrompts: ag.examplePrompts ?? [], shellSecrets: ag.shellSecrets ?? [],
    skills: ag.skills ?? [], tools: ag.tools ?? [],
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

// ── CLAUDE.md edit safety: read-before-write, patch-don't-retype, and a brake on deletions ──────────

/**
 * Short fingerprint of a CLAUDE.md — the handle that makes read-before-write MECHANICAL rather than a
 * matter of discipline. `agent_get` hands it out, the edit tools take it back as `baseHash`, and a
 * mismatch means the document moved under the caller (a stale read, or a concurrent edit) so the write
 * is refused instead of silently clobbering.
 */
export function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/** One anchored replacement — the harness `Edit` contract: `oldString` must occur EXACTLY once. */
export interface ClaudeMdEdit { oldString: string; newString: string }

/** The CLAUDE.md change an edit call is asking for, in any of the three accepted shapes. */
export interface ClaudeMdRequest {
  claudeMd?: unknown;        // full replacement (the escape hatch)
  claudeMdEdits?: unknown;   // [{ oldString, newString }] — anchored, uniqueness-checked
  claudeMdAppend?: unknown;  // text added at the end (the commonest edit of all)
}

/** How much a CLAUDE.md rewrite destroys — the signal that separates "added a section" from "clobbered it". */
export interface ClaudeMdRisk {
  bytesBefore: number;
  bytesAfter: number;
  removedPct: number;        // 0–1, share of the original length that disappeared
  droppedHeadings: string[]; // markdown headings present before and gone after
  destructive: boolean;
  reason?: string;           // human sentence for the refusal / the approval card
}

/** A rewrite that deletes more than this share of the prompt is treated as destructive. */
export const CLAUDE_MD_SHRINK_LIMIT = 0.2;

function headings(text: string): string[] {
  return text.split('\n').map((l) => /^#{1,6}\s+(.+?)\s*$/.exec(l)?.[1]).filter((h): h is string => !!h);
}

/**
 * Turn an edit request into the full replacement text, or explain why it can't be.
 *
 * Returns `text: undefined` when the request touches no CLAUDE.md at all (a description-only edit), which
 * callers must distinguish from "replace it with the empty string". Anchored edits apply in order and each
 * `oldString` must match exactly once — an anchor that matches twice is ambiguous and an anchor that
 * matches zero times means the caller is editing a document it hasn't actually read, which is precisely
 * the failure this whole path exists to stop.
 */
export function resolveClaudeMd(current: string, req: ClaudeMdRequest): { ok: true; text?: string } | { ok: false; error: string } {
  const hasFull = req.claudeMd !== undefined;
  const hasEdits = req.claudeMdEdits !== undefined;
  const hasAppend = req.claudeMdAppend !== undefined;
  if (hasFull && (hasEdits || hasAppend)) {
    return { ok: false, error: 'pass either claudeMd (full replacement) or claudeMdEdits/claudeMdAppend (a patch) — not both' };
  }
  if (hasFull) return { ok: true, text: String(req.claudeMd ?? '') };
  if (!hasEdits && !hasAppend) return { ok: true, text: undefined };

  let text = current;
  if (hasEdits) {
    if (!Array.isArray(req.claudeMdEdits)) return { ok: false, error: 'claudeMdEdits must be an array of { oldString, newString }' };
    if (!req.claudeMdEdits.length) return { ok: false, error: 'claudeMdEdits is empty — pass at least one { oldString, newString }' };
    for (const [i, raw] of req.claudeMdEdits.entries()) {
      const e = raw as Partial<ClaudeMdEdit>;
      const oldString = String(e?.oldString ?? '');
      const newString = String(e?.newString ?? '');
      if (!oldString) return { ok: false, error: `claudeMdEdits[${i}]: oldString is required (use claudeMdAppend to add text at the end)` };
      if (oldString === newString) return { ok: false, error: `claudeMdEdits[${i}]: oldString and newString are identical — nothing to change` };
      const first = text.indexOf(oldString);
      if (first === -1) {
        return { ok: false, error: `claudeMdEdits[${i}]: oldString was not found in the current CLAUDE.md. Read it with agent_get first — your copy is stale.` };
      }
      if (text.indexOf(oldString, first + 1) !== -1) {
        return { ok: false, error: `claudeMdEdits[${i}]: oldString matches more than once — include enough surrounding text to make it unique.` };
      }
      text = text.slice(0, first) + newString + text.slice(first + oldString.length);
    }
  }
  if (hasAppend) {
    const add = String(req.claudeMdAppend ?? '');
    if (add.trim()) text = text.replace(/\s*$/, '') + '\n\n' + add.replace(/^\s*\n/, '') + '\n';
  }
  return { ok: true, text };
}

/**
 * Score a CLAUDE.md rewrite for accidental destruction. Deleting most of a prompt, or losing a section
 * heading that was there before, is the single strongest signal of a caller that submitted a FRAGMENT
 * rather than the whole document — the exact shape of the incident this guards. Renaming a heading trips
 * it too; that's intended, since the caller then has to say out loud that it meant to.
 */
export function assessClaudeMdEdit(before: string, after: string): ClaudeMdRisk {
  const bytesBefore = before.length;
  const bytesAfter = after.length;
  const removedPct = bytesBefore ? Math.max(0, bytesBefore - bytesAfter) / bytesBefore : 0;
  const afterHeadings = new Set(headings(after));
  const droppedHeadings = [...new Set(headings(before))].filter((h) => !afterHeadings.has(h));
  const shrank = removedPct > CLAUDE_MD_SHRINK_LIMIT;
  const destructive = bytesBefore > 0 && (shrank || droppedHeadings.length > 0);
  const parts: string[] = [];
  if (shrank) parts.push(`it removes ${Math.round(removedPct * 100)}% of the current prompt (${bytesBefore} → ${bytesAfter} chars)`);
  if (droppedHeadings.length) {
    const shown = droppedHeadings.slice(0, 5).map((h) => `"${h}"`).join(', ');
    parts.push(`it drops ${droppedHeadings.length} existing section${droppedHeadings.length === 1 ? '' : 's'} (${shown}${droppedHeadings.length > 5 ? ', …' : ''})`);
  }
  return { bytesBefore, bytesAfter, removedPct, droppedHeadings, destructive, reason: parts.join(' and ') || undefined };
}

/** `−1,234 / +56` — the diff stat a human reads at a glance on an approval card. */
export function diffStat(risk: ClaudeMdRisk): string {
  const delta = risk.bytesAfter - risk.bytesBefore;
  return `${delta < 0 ? '−' : '+'}${Math.abs(delta).toLocaleString('en-US')} chars (${risk.bytesBefore.toLocaleString('en-US')} → ${risk.bytesAfter.toLocaleString('en-US')})`;
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
  const shellSecrets = 'shellSecrets' in fields ? sanitizeShellSecrets(fields.shellSecrets) : ag.shellSecrets;
  // Context-shaping allowlists. Self-editable on purpose: an agent trimming its OWN skill/tool offer is
  // the cheapest thing it can do for its own run cost, and it cannot widen a capability this way — the
  // lists only narrow what it is offered, and the gateway governs every effect regardless.
  const skills = 'skills' in fields ? sanitizeAgentSkills(fields.skills) : ag.skills;
  const tools = 'tools' in fields ? sanitizeAgentTools(fields.tools) : ag.tools;
  const next: AgentManifest = { ...ag, description, model: tuning.model, effort: tuning.effort, verbosity: tuning.verbosity, category, icon, examplePrompts, shellSecrets, skills, tools };
  const { dir: _dir, ...onDisk } = next; // `dir` is set at load, not persisted
  fs.writeFileSync(path.join(ag.dir!, 'agent.json'), JSON.stringify(onDisk, null, 2) + '\n');
  if ('claudeMd' in fields) fs.writeFileSync(path.join(ag.dir!, 'CLAUDE.md'), String(fields.claudeMd ?? ''));
  os.registerAgent(next);
  const after = manifestToSnapshot(next, 'claudeMd' in fields ? String(fields.claudeMd ?? '') : before.claudeMd);
  const rev = os.agentRevisions.commit(os.tenant, ag.id, before, after, opts.summary, opts.author);
  return { ok: true, rev, target: ag.id };
}
