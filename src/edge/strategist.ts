/**
 * The **goal strategist** — the outbound edge of the Goals plane (goal → work).
 *
 * Where a goal is a passive, human-owned objective that work links UP to, the strategist is the actor
 * that turns a goal DOWN into a concrete, reviewable plan of tasks. Triggered from the Goal page ("Plan
 * this goal"), it spawns a governed headless claude-code agent that reads the goal + its current progress,
 * figures out the gap to the target, and files the tasks needed to close it (linked to the goal, assigned
 * to specialists) — then STOPS for a human to review and dispatch. File-only by design: it shapes work,
 * it never runs it.
 *
 * Deliberately NOT wired to Dreaming: Dreaming today is a deterministic tally aggregator with no goal
 * awareness, so it can't act as an intelligent "this goal is stalled → plan it" sensor. The strategist
 * stands alone, human-triggered. (A deterministic goal-stall auto-trigger is a separate later phase.)
 *
 * Reuses the consolidation gardener's proven mold: provision a governed agent on first use, spawn it
 * headless, audit the kickoff — no in-process LLM client, all governance/audit for free.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentOS } from '../kernel';
import type { TerminalManager } from '../terminal';
import type { AgentManifest, Goal, Task } from '../types';

export const STRATEGIST_ID = 'strategist';
const AGENT_ID = STRATEGIST_ID;

export interface PlanResult {
  spawned: boolean;
  reason?: string;
  sessionId?: string;
}

export class Strategist {
  constructor(private readonly os: AgentOS, private readonly tm: TerminalManager) {}

  /**
   * Spawn the strategist to turn one goal into a reviewable task plan. `by` = provenance principal (the
   * human who triggered it); `runAs` = the identity the session acts as (same human, so its filed tasks
   * and any specialist it later delegates to ladder back to an accountable person). File-only — the run
   * files tasks but never dispatches; a human reviews the plan under the goal and dispatches.
   */
  async plan(goalId: string, by: string, runAs?: string): Promise<PlanResult> {
    const goal = this.os.goals.get(goalId);
    if (!goal) return { spawned: false, reason: 'goal not found' };
    if (goal.status !== 'active' && goal.status !== 'draft') {
      return { spawned: false, reason: `goal is ${goal.status} — only an active or draft goal can be planned` };
    }
    this.ensureAgent();
    const existing = this.os.tasks.tasksForGoal(goalId);
    const task = this.buildTask(goal, existing);
    const session = this.tm.createSession(AGENT_ID, `Plan goal — ${goal.title}`, task, `goal:${goalId}`, true /* headless */, undefined, undefined, runAs);
    this.os.audit.append({
      ts: Date.now(), runId: session.id, tenant: this.os.tenant, principal: by,
      type: 'goal.planned', data: { goalId, title: goal.title, sessionId: session.id, existingTasks: existing.length },
    });
    return { spawned: true, sessionId: session.id };
  }

  /** The opening prompt: the goal, its current progress, and the tasks already linked (so a re-run only
   *  fills gaps). The full method lives in the agent's CLAUDE.md. */
  private buildTask(goal: Goal, existing: Task[]): string {
    const prog = this.os.goals.progress(goal.id);
    const existingList = existing.length
      ? existing.map((t) => `  - [${t.status}] ${t.id} — ${t.title}${t.assignee ? ` (→ ${t.assignee})` : ''}`).join('\n')
      : '  (none yet)';
    const lines: string[] = [
      'You are planning the work for the GOAL below. Turn it into a concrete set of tasks that will move it',
      'to its target, then stop for a human to review and dispatch.',
      '',
      `GOAL ${goal.id}: ${goal.title}`,
    ];
    if (goal.target) lines.push(`Target: ${goal.target}`);
    if (goal.body) lines.push('', goal.body);
    lines.push(
      '',
      `Current progress: ${prog.percent}% (${prog.done}/${prog.total} linked tasks done).`,
      'Tasks already linked to this goal:',
      existingList,
      '',
      `Now follow your CLAUDE.md method: goal_get "${goal.id}" for the full picture, identify the GAP to the`,
      `target, and file the tasks needed to close it with task_create({ goalId: "${goal.id}", ... }),`,
      'assigning each to the right specialist (list_agents). Do NOT duplicate a task already linked above.',
      'File tasks in ORDER: when a step can only start after an earlier one finishes, capture the earlier',
      "task's id from its result and pass it as the later task's dependsOn — a dependent won't dispatch until",
      'its blockers are done, so this turns your plan into an enforced pipeline (not just a to-do list).',
      'Do NOT set autoDispatch — leave the plan for a human to review and dispatch. Finish with report.',
    );
    return lines.join('\n');
  }

  /** Provision the strategist agent into the data home on first use (folder + manifest + CLAUDE.md), then
   *  register it live so createSession resolves a real claude-code runtime. Idempotent. Mirrors the
   *  consolidation gardener's ensureAgent. */
  private ensureAgent(): void {
    if (this.os.agents.get(AGENT_ID)?.dir) return;
    const base = this.os.paths?.userAgents ?? path.join(process.cwd(), 'data', 'agents');
    const dir = path.join(base, AGENT_ID);
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, 'agent.json');
    if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST, null, 2));
    if (!fs.existsSync(path.join(dir, 'CLAUDE.md'))) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), CLAUDE_MD);
    this.os.registerAgent({ ...MANIFEST, dir });
  }
}

const MANIFEST: AgentManifest = {
  id: AGENT_ID,
  version: '1.0.0',
  description: 'Goal strategist — turns a company goal into a reviewable plan of tasks for the fleet.',
  category: 'System',
  principal: 'svc-strategist',
  policyContext: 'default@v3',
  runtime: 'claude-code',
  model: 'claude-opus-4-8',
  budget: { usdCap: 1, tokenCap: 300_000, wallClockMs: 900_000 },
};

const CLAUDE_MD = `# Goal strategist

You are Agent OS's **goal strategist**. You are handed one company GOAL and your job is to turn it into a
concrete, reviewable PLAN of work — the tasks needed to move it to its target — then stop for a human to
review and dispatch. You are the bridge from a strategic objective to actual work on the board.

## Method
1. **Understand the goal.** \`goal_get\` the goal you were given: its target, its current progress, and the
   tasks ALREADY linked to it. Work out what is done, what is in flight, and — most importantly — what is
   still MISSING or BLOCKED to reach the target. Plan the GAP, not the whole world.
2. **Know your fleet.** \`list_agents\` to see which specialists you can hand work to. Assign each task to
   the agent best suited to it rather than leaving it unassigned (an unassigned task just sits there).
3. **File the gap as tasks.** For each concrete piece of work, \`task_create({ title, body, goalId:
   "<this goal>", assignee: "agent:<specialist>" })\`, each well-scoped with enough detail to act on. Use
   \`parentId\` to nest genuine sub-tasks under a larger one — a sub-task inherits the goal automatically.
   - **Do NOT set autoDispatch.** You produce a PLAN; a human reviews it under the goal and dispatches.
   - **Do NOT duplicate** a task already linked to the goal — you may be re-run as the goal evolves, so
     only fill the gaps; skip work that already exists.
   - Give a task a single-line \`criteria\` when it has a clear, checkable "done" condition — a later
     headless dispatch will then converge under that condition.
   - **Set \`dependsOn\` to encode ORDER.** When a step can't start until an earlier one finishes, file the
     earlier task first, capture its id, and pass it in the later task's \`dependsOn\`. A dependent won't
     dispatch until every blocker is done — that makes your plan an enforced pipeline, not a flat list.
4. **Propose strategy, don't set it.** If the goal genuinely needs sub-objectives, \`goal_propose\` them for
   a human to activate — never create or activate goals yourself. Tasks are yours to file; strategy is the
   human's to own.
5. **Finish with \`report\`** — outcome + a one-line summary of the plan you filed (e.g. "filed 6 tasks
   across engineer + designer to close the gap on 'Grow signups'"). Note anything you could not plan.

You act on the company's behalf. You never dispatch or run the work — you shape it and hand it back.`;
