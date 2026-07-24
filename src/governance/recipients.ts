/**
 * Recipient routing — the single global answer to "who is the receiver of a notification?".
 *
 * Before this module the logic was re-derived in every notifier (approvals, questions, task-overdue),
 * each with its own owner→admins fallback chain and its own copy of the identity-map DM loop. An
 * `Audience` is the one vocabulary every push (Slack/Discord DM) and — see `docs/inbox-plan.md` — every
 * inbox card's visibility resolves through, so recipient policy lives in ONE place. `resolveRecipients`
 * turns an intent (`{kind:'approvers', level}`, `{kind:'member', id}`, …) into the concrete member set;
 * callers state WHO should hear about a thing, never how to find them.
 */
import type { AgentOS } from '../kernel';
import { Member, ApprovalLevel, canApprove } from '../types';

/**
 * The routing INTENT of a notification. A notifier declares one of these instead of hand-resolving a
 * member set; `resolveRecipients` expands it.
 * - `member`        — one named person (a task's owner/assignee, a run's human).
 * - `approvers`     — everyone who `canApprove(role, level)` (the approval-card audience).
 * - `admins`        — active owners + admins; the shared escalation/fallback tier.
 * - `sessionOwner`  — the human a run acts for: its `run_as`, else a member who spawned it (empty for a
 *                     pure automation/task/chat spawn, whose provenance is prefixed `x:`).
 * - `task`          — the human participants of a task's Discussion: its owner + human assignee + every
 *                     human who has posted in it (see `docs/task-rooms-plan.md`). The fan-out set for a
 *                     Discussion-wide event; individual @mentions use `member` instead.
 */
export type Audience =
  | { kind: 'member'; id: string }
  | { kind: 'approvers'; level: ApprovalLevel }
  | { kind: 'admins' }
  | { kind: 'sessionOwner'; id: string }
  | { kind: 'task'; id: string };

/**
 * Resolve an {@link Audience} to the concrete members who should receive the notification. Pure over
 * `os.team` (+ `os.db` for a session's provenance). The `admins`/`approvers` tiers are limited to
 * `active` members (an invited-but-not-accepted account can't act); a directly-named `member`/
 * `sessionOwner` is returned as-is when found, matching the pre-refactor behavior (it may still carry a
 * linked chat handle worth DMing). Callers apply their own fallback by resolving a second audience when
 * this returns empty — see `deliverDM` callers in `tenant-registry.ts`.
 */
export function resolveRecipients(os: AgentOS, audience: Audience): Member[] {
  switch (audience.kind) {
    case 'member': {
      const m = os.team.getMember(audience.id);
      return m ? [m] : [];
    }
    case 'admins':
      return os.team.listMembers().filter((m) => m.status === 'active' && (m.role === 'owner' || m.role === 'admin'));
    case 'approvers':
      return os.team.listMembers().filter((m) => m.status === 'active' && canApprove(m.role, audience.level));
    case 'sessionOwner': {
      const row = os.db
        .prepare('SELECT spawned_by, run_as FROM term_sessions WHERE id = ?')
        .get<{ spawned_by: string | null; run_as: string | null }>(audience.id);
      let m = row?.run_as ? os.team.getMember(row.run_as) : undefined;
      // A console-spawned run's provenance IS a member id (automation:/task:/chat: spawns are prefixed).
      if (!m && row?.spawned_by && !row.spawned_by.includes(':')) m = os.team.getMember(row.spawned_by);
      return m ? [m] : [];
    }
    case 'task': {
      // The Discussion's human participants: owner + human assignee + every human who has posted a
      // Discussion message (source is a bare member id; agents post with an `agent:<id>` source).
      const t = os.tasks.get(audience.id);
      const ids = new Set<string>();
      if (t?.owner) ids.add(t.owner);
      if (t?.assignee && !t.assignee.includes(':')) ids.add(t.assignee);
      for (const r of os.db
        .prepare("SELECT DISTINCT source FROM messages WHERE session_id = ? AND type = 'task.chat' AND source IS NOT NULL")
        .all<{ source: string }>(`task:${audience.id}`)) {
        if (r.source && !r.source.includes(':')) ids.add(r.source);
      }
      return [...ids].map((id) => os.team.getMember(id)).filter((m): m is Member => !!m);
    }
  }
}

/**
 * Who an approval card/DM should reach — the one rule shared by the inbox card's audience and the
 * out-of-band approver DM, so a card is shown to exactly whom it's pushed to. Scoping principle: an
 * approval is the session owner's OWN business when they hold approval authority for its level (an
 * admin/owner running their own agent self-approves — nobody else needs pinging). Only when the owner
 * can't clear it does it escalate to the full approver tier (`canApprove(role, level)` — owners for
 * red, owners+admins for yellow). This is what stops every admin from being DMed about every other
 * admin's self-approvable session — the flood the un-audienced broadcast used to cause.
 */
export function approvalAudience(os: AgentOS, sessionId: string, level: ApprovalLevel): Audience {
  const owner = resolveRecipients(os, { kind: 'sessionOwner', id: sessionId })[0];
  if (owner && owner.status === 'active' && canApprove(owner.role, level)) {
    return { kind: 'sessionOwner', id: sessionId };
  }
  return { kind: 'approvers', level };
}
