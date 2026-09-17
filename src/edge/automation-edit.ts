/**
 * "Edit with agent" — changing an EXISTING automation through a conversation with the agent it runs.
 *
 * Two halves, both deliberately thin:
 *   1. {@link buildAutomationEditBrief} composes the opening prompt of an interactive session with the
 *      automation's own agent: the current configuration verbatim, a few recent runs to ground the
 *      conversation, and the one way to land a change — `automation_propose({ editOf })`.
 *   2. {@link planAutomationEdit} turns that call into a reviewable EDIT: the agent sends only what changes,
 *      this merges it over the live automation, validates it the same way `Automations.update` will at
 *      approve time, and names each changed field for the card.
 *
 * Nothing here writes. An edit proposal is a card; the automation changes only when an owner/admin who may
 * manage it approves (`POST /api/automations/proposals/:id/approve`, which calls `Automations.update`). The
 * agent never gets a direct write lane onto its own trigger — that would let a run reschedule or re-prompt
 * the job that spawns it with no human in the loop.
 *
 * Staleness: the card pins {@link automationEditBase} of the automation as it was proposed against. If a
 * human edits the automation in the meantime, approval refuses (409) rather than silently reverting their
 * change with the agent's older full-field snapshot. `enabled` is excluded on purpose — pausing an
 * automation while its edit waits for review is normal and must not invalidate the proposal.
 */
import { createHash } from 'crypto';
import type { Automation } from './automations';
import { parseCron } from './automations';
import { validateFilter } from './webhook-ingress';

/** The fields an edit proposal may change — exactly what `Automations.update` accepts from a human edit,
 *  minus the credentials (`signingSecret`) and toggles (`enabled`) an agent has no business proposing. */
export interface AutomationEditPatch {
  name?: string;
  schedule?: string;
  filter?: string;
  task?: string;
  mode?: 'headless' | 'interactive';
  /** undefined = keep; '' = clear back to company identity; else a member id or email. */
  runAs?: string;
}

/** The editable snapshot of an automation — what an edit card stores as `before` and `after`. */
export interface AutomationEditState {
  name: string;
  mode: 'headless' | 'interactive';
  schedule?: string;
  filter?: string;
  task: string;
  runAs?: string;
}

export const EDITABLE_TYPES: ReadonlyArray<Automation['type']> = ['cron', 'webhook', 'composio', 'slack', 'discord', 'telegram', 'clickup'];

const FILTER_TYPES: ReadonlyArray<Automation['type']> = ['webhook', 'composio', 'slack', 'discord', 'telegram', 'clickup'];

export function editStateOf(a: Automation): AutomationEditState {
  return {
    name: a.name,
    mode: a.mode === 'interactive' ? 'interactive' : 'headless',
    ...(a.type === 'cron' && a.schedule ? { schedule: a.schedule } : {}),
    ...(FILTER_TYPES.includes(a.type) && a.filter ? { filter: a.filter } : {}),
    task: a.task,
    ...(a.runAs ? { runAs: a.runAs } : {}),
  };
}

/** A stable fingerprint of the editable fields, so approval can tell the automation moved underneath it. */
export function automationEditBase(a: Automation): string {
  const s = editStateOf(a);
  const canon = [s.name, s.mode, s.schedule ?? '', s.filter ?? '', s.task, s.runAs ?? ''];
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16);
}

const FIELD_LABEL: Record<keyof AutomationEditState, string> = {
  name: 'name', mode: 'mode', schedule: 'schedule', filter: 'filter', task: 'task prompt', runAs: 'run as',
};

/**
 * Merge an agent's partial edit over the live automation and validate it. Returns the full `after` state,
 * the changed field names, and one preview line per change — or an error the agent can act on.
 * `resolveMember` maps an id/email to a member id (undefined = unknown); `memberLabel` names one for humans.
 */
export function planAutomationEdit(
  current: Automation,
  patch: AutomationEditPatch,
  resolveMember: (ref: string) => string | undefined,
  memberLabel: (id: string) => string,
): { before: AutomationEditState; after: AutomationEditState; changes: (keyof AutomationEditState)[]; preview: string } | { error: string } {
  if (!EDITABLE_TYPES.includes(current.type)) return { error: `a "${current.type}" automation can't be edited by proposal — it's a one-shot, cancel it and schedule a new one` };
  const before = editStateOf(current);
  const after: AutomationEditState = { ...before };

  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (!n) return { error: 'name can\'t be empty — omit it to keep the current name' };
    after.name = n;
  }
  if (patch.task !== undefined) {
    const t = patch.task.trim();
    if (!t) return { error: 'task can\'t be empty — omit it to keep the current prompt' };
    after.task = t;
  }
  if (patch.mode !== undefined) after.mode = patch.mode;
  if (patch.schedule !== undefined) {
    if (current.type !== 'cron') return { error: `schedule only applies to a cron automation — this one is a ${current.type} trigger (change its filter instead)` };
    const s = patch.schedule.trim();
    try { parseCron(s); } catch (e) { return { error: `invalid cron schedule "${s}": ${e instanceof Error ? e.message : String(e)}` }; }
    after.schedule = s;
  }
  if (patch.filter !== undefined) {
    if (!FILTER_TYPES.includes(current.type)) return { error: 'filter only applies to event triggers — a cron automation is changed by its schedule' };
    const f = current.type === 'composio' ? patch.filter.trim().toUpperCase() : patch.filter.trim();
    if (current.type === 'webhook' || current.type === 'slack') {
      const bad = validateFilter(f || undefined);
      if (bad) return { error: bad };
    }
    if (f) after.filter = f; else delete after.filter;
  }
  if (patch.runAs !== undefined) {
    const raw = patch.runAs.trim();
    if (!raw) delete after.runAs;
    else {
      const id = resolveMember(raw);
      if (!id) return { error: `unknown member "${raw}" for runAs — pass a member id or email (use directory_lookup), or "" for the company identity` };
      after.runAs = id;
    }
  }

  const keys: (keyof AutomationEditState)[] = ['name', 'schedule', 'filter', 'mode', 'runAs', 'task'];
  const changes = keys.filter((k) => (before[k] ?? '') !== (after[k] ?? ''));
  if (!changes.length) return { error: 'that edit changes nothing — every field you sent matches the automation as it is' };

  const show = (k: keyof AutomationEditState, s: AutomationEditState): string => {
    const v = s[k];
    if (k === 'runAs') return v ? memberLabel(String(v)) : 'company identity';
    if (v === undefined || v === '') return '(none)';
    return `\`${v}\``;
  };
  const lines = changes.map((k) => k === 'task'
    ? `${FIELD_LABEL.task}: rewritten (${before.task.length} → ${after.task.length} chars)`
    : `${FIELD_LABEL[k]}: ${show(k, before)} → ${show(k, after)}`);
  return { before, after, changes, preview: lines.join('\n') };
}

/** One recent run of the automation, as the brief shows it. */
export interface BriefRun { title?: string; status: string; createdAt: number; summary?: string }

/** The opening prompt of an "Edit with agent" session. */
export function buildAutomationEditBrief(a: Automation, opts: { memberName: string; runAsLabel: string; runs: BriefRun[]; note?: string; now?: number; canApprove: boolean }): string {
  const trigger = a.type === 'cron'
    ? `cron \`${a.schedule ?? ''}\``
    : `${a.type} trigger${a.filter ? ` — filter \`${a.filter}\`` : ' — any event'}`;
  const now = opts.now ?? Date.now();
  const ago = (t: number) => {
    const m = Math.max(0, Math.round((now - t) / 60000));
    return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  };
  const runs = opts.runs.length
    ? opts.runs.map((r) => `- ${ago(r.createdAt)} · ${r.status}${r.title ? ` · ${r.title}` : ''}${r.summary ? ` — ${r.summary}` : ''}`).join('\n')
    : '- (no runs yet)';
  const fields = a.type === 'cron' ? 'name, schedule, mode, runAs, task' : 'name, filter, mode, runAs, task';
  return [
    `${opts.memberName} opened this session to EDIT an automation you run. Help them change it.`,
    '',
    `## The automation as it is now`,
    `- id: ${a.id}`,
    `- name: ${a.name}`,
    `- trigger: ${trigger}`,
    `- mode: ${a.mode}`,
    `- runs as: ${opts.runAsLabel}`,
    `- enabled: ${a.enabled ? 'yes' : 'no'}`,
    `- task prompt (what each fired run receives, verbatim):`,
    '```',
    a.task,
    '```',
    '',
    `## Recent runs (newest first)`,
    runs,
    '',
    `## How to work`,
    opts.note?.trim()
      ? `1. They said what they want: "${opts.note.trim()}". Restate the change in one line, and ask only if something is genuinely ambiguous.`
      : `1. Ask what they want to change, in one short question. If they want ideas, ground them in the configuration and the recent runs above (use \`session_open\` on a run if you need detail) — don't invent problems.`,
    `2. Show the concrete change before proposing it — for a task prompt, the full revised text; for a schedule, the cron expression AND what it means in words.`,
    `3. When they agree, call \`automation_propose\` with \`editOf: "${a.id}"\`, ONLY the fields that change (${fields}), and a one-line \`rationale\`. \`task\` replaces the WHOLE prompt, so send the complete revised text, never a fragment. The trigger type and the agent can't be changed by an edit — if they need that, propose a new automation instead and say the old one should then be deleted.`,
    opts.canApprove
      ? `4. The edit is a DRAFT until it's approved on the Automations page — ${opts.memberName} can approve it there. Tell them that; don't claim it's applied.`
      : `4. The edit is a DRAFT until an owner/admin approves it on the Automations page. Tell ${opts.memberName} that; don't claim it's applied.`,
    '',
    `Don't create a new automation, don't edit files to change this one, and don't run the task yourself — this session is only about the automation's configuration.`,
  ].join('\n');
}
