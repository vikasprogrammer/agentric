/**
 * Session activity — turn a run's raw audit stream into the human question "which agent-os primitives
 * did this session use?". Pure classification (audit type + data → a one-line activity descriptor);
 * the DB read + un-audited `update` folding live in the /api/sessions/:id/activity route in server.ts.
 *
 * The categories mirror the OS planes an agent touches: `action` (governed gateway/gate effects — the
 * external tool calls the gate decided on), `operator` (the human-facing channel: ask/report/update/
 * publish), `memory`, `knowledge` (KB), `tasks`, `scheduling`, `agents`, `approval`. Anything that is
 * pure session plumbing (lifecycle, secret/skill materialisation, the paired half of a governed action)
 * is NOISE and never surfaces as a primitive.
 */

export type ActivityCategory =
  | 'action' | 'operator' | 'memory' | 'knowledge' | 'tasks'
  | 'scheduling' | 'agents' | 'approval' | 'secrets' | 'skills' | 'policy' | 'other';

export type ActivityEffect = 'allow' | 'approve' | 'deny' | 'error';

/** The kind of live object a trail entry opened — the key the route uses to resolve the object's
 *  CURRENT status (audit is point-in-time; "task created" ≠ "task is now done"). `id` is whatever
 *  uniquely locates the row in its store: a task id, a `section/slug` for KB, the key for a secret,
 *  the skill name / secret key / policy capability for the matching proposal card. */
export type TargetKind =
  | 'task' | 'kb' | 'approval' | 'secret' | 'secret-request' | 'skill-proposal' | 'policy-proposal';
export interface ActivityTarget { kind: TargetKind; id: string }

/** One classified primitive-use, sans timestamp (the route stamps `ts` from the audit row). */
export interface ActivityDescriptor {
  category: ActivityCategory;
  /** The primitive the agent used — an OS tool name (`remember`, `ask`, `task_create`) or, for a
   *  governed effect, the capability id (`Bash`, `email.send`, `mcp__gmail__send`). */
  primitive: string;
  /** A one-line human gloss built from the event's data (memory tags, KB slug, task title, …). */
  summary: string;
  /** For governed actions/approvals: how the gate classified it (allow/approve/deny) or the outcome. */
  effect?: ActivityEffect;
  /** The live object this entry opened, if any — lets the route attach the object's CURRENT status
   *  (a task's todo→done, a proposal's pending→approved) so the trail tracks state, not just history. */
  target?: ActivityTarget;
}

/** Session plumbing + the paired/duplicate half of a governed action — not, on their own, a primitive
 *  the agent "used". Keeping these out is what makes the activity feed read as intent, not machinery. */
const NOISE = new Set<string>([
  'session.created', 'session.ended', 'session.resumed', 'session.stopped', 'session.error',
  'session.tuning', 'session.progress', 'session.notified', 'session.attachment', 'session.deleted',
  'skills.materialized', 'skills.error',
  'connector.minted', 'connector.mint.failed', 'connector.secret.unresolved',
  'shell.secret.injected', 'shell.secret.unresolved',
  'gate.attempt', 'gate.killswitch', 'episode.stored', 'episode.error', 'lesson.stored', 'lesson.error',
  'action.attempt', 'policy.decision', 'space.released', 'approval.notified', 'approval.auto_approved',
  // The human side of the two agent→human channels — a follow-up to the agent's primitive, not one itself.
  'approval.resolved', 'question.answered',
]);

/** Category by type-prefix — the fallback for any audited effect not spelled out below. */
const PREFIX: ReadonlyArray<readonly [string, ActivityCategory]> = [
  ['memory.', 'memory'], ['kb.', 'knowledge'], ['task.', 'tasks'], ['agent.', 'agents'],
  ['automation.', 'scheduling'], ['approval.', 'approval'], ['gate.', 'action'], ['action.', 'action'],
  ['question.', 'operator'], ['artifact.', 'operator'],
  ['secret.', 'secrets'], ['skill.', 'skills'], ['policy.', 'policy'],
];

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Collapse whitespace and clip to a feed-friendly length. */
export function clipText(v: unknown, n = 140): string {
  const t = str(v).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** A KB target keyed by `section/slug` — the route resolves the page's current rev / existence. */
const kbTarget = (data: Record<string, unknown>): ActivityTarget | undefined => {
  const section = str(data.section), slug = str(data.slug);
  return section && slug ? { kind: 'kb', id: `${section}/${slug}` } : undefined;
};

const normEffect = (e: string): ActivityEffect | undefined =>
  e === 'allow' || e === 'approve' || e === 'deny' || e === 'error' ? e : undefined;

const fmtWhen = (v: unknown): string => {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(v).toISOString().slice(0, 16).replace('T', ' ');
  }
  return str(v);
};

/**
 * Classify one audit event into an activity descriptor, or `null` if it's noise (and therefore not a
 * primitive the session used). Pure — no I/O, no clock; the caller supplies `ts`.
 */
export function classifyActivity(type: string, data: Record<string, unknown>): ActivityDescriptor | null {
  if (NOISE.has(type)) return null;
  const id = () => str(data.id);

  switch (type) {
    // ── governed external effects — the capability the gate decided on IS the primitive ──
    case 'gate.decision': {
      const cap = str(data.capability) || 'action';
      const d = data.decision as { effect?: string } | undefined;
      return { category: 'action', primitive: cap, summary: cap, effect: normEffect(str(d?.effect)) };
    }
    case 'action.result': {
      const cap = str(data.capability) || 'action';
      return { category: 'action', primitive: cap, summary: cap, effect: data.ok === false ? 'error' : 'allow' };
    }
    case 'gate.email.blocked':
      return { category: 'action', primitive: str(data.capability) || 'email.send', summary: clipText(data.reason, 100), effect: 'deny' };

    // ── operator channel (agent ↔ human) ──
    case 'question.asked':     return { category: 'operator', primitive: 'ask', summary: clipText(data.prompt) };
    case 'session.reported':   return { category: 'operator', primitive: 'report', summary: `${str(data.outcome) || 'done'} — ${clipText(data.summary, 110)}`.replace(/ — $/, '') };
    case 'artifact.published': return { category: 'operator', primitive: 'publish', summary: clipText(data.title) || str(data.filename) };
    case 'artifact.updated':   return { category: 'operator', primitive: 'publish', summary: `updated — ${clipText(data.title) || str(data.filename)}` };
    case 'artifact.deleted':   return { category: 'operator', primitive: 'artifact_delete', summary: clipText(data.title) || id() };

    // ── memory plane ──
    case 'memory.stored': {
      const tags = Array.isArray(data.tags) ? data.tags.map(str).filter(Boolean).join(', ') : '';
      const scope = str(data.scope);
      return { category: 'memory', primitive: 'remember', summary: [tags && `[${tags}]`, scope && scope !== 'agent' ? `${scope}-scoped` : '', id() && `#${id()}`].filter(Boolean).join(' ') || 'a fact' };
    }
    case 'memory.revised':   return { category: 'memory', primitive: 'revise', summary: id() ? `#${id()}` : '' };
    case 'memory.forgotten': return { category: 'memory', primitive: 'forget', summary: id() ? `#${id()}` : '' };

    // ── knowledge base ──
    case 'kb.written':   return { category: 'knowledge', primitive: 'kb_write', summary: `${str(data.section)}/${str(data.slug)}${data.rev ? ` · rev ${str(data.rev)}` : ''}`, target: kbTarget(data) };
    case 'kb.reverted':  return { category: 'knowledge', primitive: 'kb_revert', summary: `${str(data.section)}/${str(data.slug)} → rev ${str(data.rev)}`, target: kbTarget(data) };
    case 'kb.deleted':   return { category: 'knowledge', primitive: 'kb_delete', summary: `${str(data.section)}/${str(data.slug)}`, target: kbTarget(data) };

    // ── tasks plane ──
    case 'task.created':    return { category: 'tasks', primitive: 'task_create', summary: clipText(data.title) || id(), target: { kind: 'task', id: id() } };
    case 'task.claimed':    return { category: 'tasks', primitive: 'task_claim', summary: id(), target: { kind: 'task', id: id() } };
    case 'task.updated':    return { category: 'tasks', primitive: 'task_update', summary: `${id()} → ${str(data.status)}`, target: { kind: 'task', id: id() } };
    case 'task.completed':  return { category: 'tasks', primitive: 'task_update', summary: `${id()} → ${str(data.status) || 'done'}`, effect: 'allow', target: { kind: 'task', id: id() } };
    case 'task.dispatched': { const tid = str(data.task) || id(); return { category: 'tasks', primitive: 'task_dispatch', summary: clipText(data.title) || tid, target: tid ? { kind: 'task', id: tid } : undefined }; }
    case 'task.deleted':    return { category: 'tasks', primitive: 'task_delete', summary: id(), target: { kind: 'task', id: id() } };

    // ── secrets vault (shared credential handoff) ──
    case 'secret.put':        return { category: 'secrets', primitive: 'secret_put', summary: str(data.key), target: { kind: 'secret', id: str(data.key) } };
    case 'secret.get':        return { category: 'secrets', primitive: 'secret_get', summary: str(data.key), effect: data.found === false ? 'error' : 'allow', target: { kind: 'secret', id: str(data.key) } };
    case 'secret.get.denied': return { category: 'secrets', primitive: 'secret_get', summary: `${str(data.key)} — ${clipText(data.reason, 90)}`.replace(/ — $/, ''), effect: 'deny' };
    case 'secret.requested':  return { category: 'secrets', primitive: 'secret_request', summary: `${str(data.key)}${data.mode ? ` · ${str(data.mode)}` : ''}`, target: { kind: 'secret-request', id: str(data.key) } };

    // ── skills (procedural memory — propose/request, an owner publishes) ──
    case 'skill.proposed':  return { category: 'skills', primitive: 'skill_propose', summary: str(data.name), target: { kind: 'skill-proposal', id: str(data.name) } };
    case 'skill.requested': return { category: 'skills', primitive: 'skill_request', summary: str(data.name) || str(data.skill) };

    // ── policy (propose-don't-apply — an owner approves the tightening) ──
    case 'policy.proposed': return { category: 'policy', primitive: 'policy_propose', summary: `${str(data.kind)} · ${str(data.capability)}`.replace(/^ · | · $/g, ''), target: { kind: 'policy-proposal', id: str(data.capability) } };

    // ── scheduling (agent-deferred self-runs) ──
    case 'automation.scheduled': return { category: 'scheduling', primitive: 'schedule', summary: `${str(data.agent)} @ ${fmtWhen(data.runAt)}`.trim() };
    case 'automation.cancelled': return { category: 'scheduling', primitive: 'unschedule', summary: id() };

    // ── agent authoring (the A2A / agent-author surface) ──
    case 'agent.created':        return { category: 'agents', primitive: 'agent_create', summary: str(data.agent) || id() };
    case 'agent.duplicated':     return { category: 'agents', primitive: 'agent_duplicate', summary: str(data.agent) || id() };
    case 'agent.config.updated':
    case 'agent.claude.updated': return { category: 'agents', primitive: 'agent_update', summary: str(data.agent) || id() };
    case 'agent.deleted':        return { category: 'agents', primitive: 'agent_delete', summary: str(data.agent) || id() };

    // ── approvals the agent triggered (the human resolution is folded away as noise) ──
    case 'approval.requested':   return { category: 'approval', primitive: 'approval', summary: `${str(data.level)}${data.reason ? ` · ${clipText(data.reason, 90)}` : ''}`.replace(/^ · /, ''), effect: 'approve', target: { kind: 'approval', id: str(data.approvalId) || id() } };

    default: break;
  }

  // Anything audited but not spelled out: keep it, categorised by prefix, primitive = the raw type.
  const cat = PREFIX.find(([pre]) => type.startsWith(pre))?.[1] ?? 'other';
  return { category: cat, primitive: type, summary: '' };
}
