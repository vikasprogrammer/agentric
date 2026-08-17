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

/** Human steering for a plan run — an optional pre-plan step where the requester shapes what the
 *  strategist files before it runs. All fields optional; an empty object plans with no constraints. */
export interface PlanSteer {
  /** Free-text guidance the strategist must honour (focus, constraints, which specialists to prefer, …). */
  guidance?: string;
  /** Hard cap on how many NEW tasks to file this run — keeps a plan tight instead of sprawling. */
  maxTasks?: number;
  /** When true, the tasks this plan files auto-dispatch (agent-assigned ones run without a human pressing
   *  dispatch). ENFORCED server-side: the create route stamps `auto_dispatch=1` on every task the plan
   *  session files, so it never depends on the agent obeying the prompt. Default false = file-only (a human
   *  reviews the plan and dispatches). Respects `dependsOn` — a dependent still waits for its blockers. */
  autoDispatch?: boolean;
}

export class Strategist {
  constructor(private readonly os: AgentOS, private readonly tm: TerminalManager) {}

  /**
   * Spawn the strategist to turn one goal into a reviewable task plan. `by` = provenance principal (the
   * human who triggered it); `runAs` = the identity the session acts as (same human, so its filed tasks
   * and any specialist it later delegates to ladder back to an accountable person). File-only — the run
   * files tasks but never dispatches; a human reviews the plan under the goal and dispatches.
   */
  async plan(goalId: string, by: string, runAs?: string, steer?: PlanSteer): Promise<PlanResult> {
    const goal = this.os.goals.get(goalId);
    if (!goal) return { spawned: false, reason: 'goal not found' };
    if (goal.status !== 'active' && goal.status !== 'draft') {
      return { spawned: false, reason: `goal is ${goal.status} — only an active or draft goal can be planned` };
    }
    this.ensureAgent();
    const existing = this.os.tasks.tasksForGoal(goalId);
    const task = this.buildTask(goal, existing, steer);
    const session = this.tm.createSession(AGENT_ID, `Plan goal — ${goal.title}`, task, `goal:${goalId}`, true /* headless */, undefined, undefined, runAs);
    // Deterministic auto-dispatch: flag this plan session so the tasks/create route stamps `auto_dispatch=1`
    // on every task it files — the enforcement doesn't trust the agent to set the flag (its prompt never
    // mentions it). Default off leaves the plan file-only for a human to dispatch.
    if (steer?.autoDispatch) this.tm.markPlanAutoDispatch(session.id);
    this.os.audit.append({
      ts: Date.now(), runId: session.id, tenant: this.os.tenant, principal: by,
      type: 'goal.planned', data: { goalId, title: goal.title, sessionId: session.id, existingTasks: existing.length, steered: !!(steer?.guidance || steer?.maxTasks), autoDispatch: !!steer?.autoDispatch },
    });
    return { spawned: true, sessionId: session.id };
  }

  /**
   * Open a CONVERSATION about a goal — the goal room's chat. Same agent, same governance, different shape:
   * a **resident** interactive run (warm between turns, so a follow-up is instant) that the human keeps
   * talking to, rather than a headless plan run that files and exits.
   *
   * Why the strategist and not a fresh persona: it already holds the goal→task method, and the thing a
   * person actually wants to do in a goal room — "why is this stalled?", "file a task for X", "run step 3
   * now", "drop step 5" — is exactly its subject. It reaches the work through the same governed tools
   * (`task_create`/`task_dispatch`/`task_update`), so a chat can't do anything a plan run couldn't.
   *
   * The conversation contract lives in this PROMPT, not the persona: the persona says "you never dispatch
   * work", which is right for an unattended plan run and wrong here (a human is in the room asking), and a
   * prompt is the one place that can override it without rewriting a file already provisioned — and
   * possibly hand-edited — on every live tenant.
   */
  async discuss(goalId: string, by: string, runAs: string | undefined, message: string, who?: string): Promise<PlanResult> {
    const goal = this.os.goals.get(goalId);
    if (!goal) return { spawned: false, reason: 'goal not found' };
    this.ensureAgent();
    const prompt = this.buildChat(goal, this.os.tasks.tasksForGoal(goalId), message, who);
    const session = this.tm.createSession(
      AGENT_ID, `Goal chat — ${goal.title}`, prompt, `goal:${goalId}`,
      false /* not headless: an attachable run the human drives */, undefined, undefined, runAs,
      undefined, true /* resident: keep the runtime warm between turns */,
    );
    this.os.audit.append({
      ts: Date.now(), runId: session.id, tenant: this.os.tenant, principal: by,
      type: 'goal.chat.started', data: { goalId, title: goal.title, sessionId: session.id },
    });
    return { spawned: true, sessionId: session.id };
  }

  /** The chat opener: who you're talking to, the goal + its work as it stands, and the rules of THIS
   *  conversation (act when asked, keep replies short, never close the goal yourself). */
  private buildChat(goal: Goal, existing: Task[], message: string, who?: string): string {
    const prog = this.os.goals.progress(goal.id);
    const taskLines = existing.length
      ? existing.map((t) => `  - [${t.status}] ${t.id} — ${t.title}${t.assignee ? ` (→ ${t.assignee})` : ''}`).join('\n')
      : '  (none yet)';
    return [
      `You are in the GOAL ROOM for goal ${goal.id}, talking with ${who || 'a member of the company'} in the`,
      'Agentric console. This is a CONVERSATION, not a plan run: they can see the goal, its tasks and their',
      'statuses on screen next to this chat, and they will ask you about them and tell you what to do.',
      '',
      `GOAL ${goal.id}: ${goal.title}`,
      ...(goal.target ? [`Target: ${goal.target}`] : []),
      ...(goal.body ? ['', goal.body] : []),
      '',
      `Progress: ${prog.percent}% (${prog.done}/${prog.counted} linked tasks done, ${prog.total} filed).`,
      'Tasks linked to this goal:',
      taskLines,
      '',
      'How to work in this room:',
      `- **Ground every answer in state.** goal_get "${goal.id}" and task_get/task_list before you explain`,
      "  why something is stalled or what's left — the list above ages the moment work moves.",
      '- **Act when asked.** Your CLAUDE.md tells you to shape work and never run it; that rule is about',
      '  unattended planning. Here a human is asking, so when they say run/stop/re-prioritise/drop it, DO it:',
      `  task_create({ goalId: "${goal.id}", … }) to file, task_dispatch to run one now, task_update to`,
      '  change status/assignee/priority. Then say what you did in one line.',
      '- **Confirm before anything wide.** Dispatching several tasks at once, or cancelling work someone',
      '  else filed, gets one short "want me to?" first — each run costs real money.',
      '- **Strategy stays theirs.** Never mark this goal achieved/abandoned and never activate a goal;',
      '  propose (goal_propose) and let them decide.',
      '- **Talk like a colleague.** A few sentences or a short list. No preamble, no sign-off, no essay.',
      '  Do NOT call report — this is a conversation, and each of your turns IS the reply they read.',
      '',
      `${who || 'They'} said:`,
      message,
    ].join('\n');
  }

  /** The opening prompt: the goal, its current progress, and the tasks already linked (so a re-run only
   *  fills gaps). The full method lives in the agent's CLAUDE.md. */
  private buildTask(goal: Goal, existing: Task[], steer?: PlanSteer): string {
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
    );
    // Optional human steering — a pre-plan step where the requester shaped this run. Treat it as a
    // binding constraint on top of the standard method, not a suggestion.
    const maxTasks = steer?.maxTasks && steer.maxTasks > 0 ? Math.floor(steer.maxTasks) : undefined;
    const guidance = steer?.guidance?.trim();
    if (maxTasks || guidance) {
      lines.push('', '--- STEERING FROM THE REQUESTER (must honour) ---');
      if (guidance) lines.push(`Guidance: ${guidance}`);
      if (maxTasks) lines.push(`File AT MOST ${maxTasks} new task(s) this run — prioritise the highest-leverage work and stop there.`);
      lines.push('--- end steering ---');
    }
    lines.push(
      '',
      `Now follow your CLAUDE.md method: goal_get "${goal.id}" for the full picture, identify the GAP to the`,
      `target, and file the tasks needed to close it with task_create({ goalId: "${goal.id}", ... }),`,
      'assigning each to the right specialist (list_agents). Do NOT duplicate a task already linked above.',
      'File tasks in ORDER: when a step can only start after an earlier one finishes, capture the earlier',
      "task's id from its result and pass it as the later task's dependsOn — a dependent won't dispatch until",
      'its blockers are done, so this turns your plan into an enforced pipeline (not just a to-do list).',
      'NUMBER the titles: prefix each task title with its step number in run order — "1. ", "2. ", … — so',
      'the sequence is visible at a glance on the board (a parallel/independent track can share a number).',
    );
    if (steer?.autoDispatch) {
      // The requester chose to auto-run this plan. The server force-stamps auto-dispatch on the tasks you
      // file, so you don't set the flag — but the ordering is now load-bearing: a task runs the moment its
      // blockers finish, with no human gate. Get the dependsOn chain right.
      lines.push(
        'This plan will AUTO-RUN: each task you file dispatches on its own the moment its dependsOn blockers',
        'are done — there is NO human review step, so your dependsOn ordering IS the execution order. Get it',
        'exactly right and scope each task tightly. (You do not set autoDispatch — that is handled for you.)',
        'Finish with report.',
      );
    } else {
      lines.push('Do NOT set autoDispatch — leave the plan for a human to review and dispatch. Finish with report.');
    }
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
  budget: { usdCap: 1, tokenCap: 300_000, wallClockMs: 900_000 },
};

const CLAUDE_MD = `# Goal strategist

You are Agentric's **goal strategist**. You are handed one company GOAL and your job is to turn it into a
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
   - **Number the titles.** Prefix each task title with its step number in execution order ("1. …",
     "2. …", …) so the sequence is obvious on the board — matching the \`dependsOn\` order.
4. **Propose strategy, don't set it.** If the goal genuinely needs sub-objectives, \`goal_propose\` them for
   a human to activate — never create or activate goals yourself. Tasks are yours to file; strategy is the
   human's to own.
5. **Finish with \`report\`** — outcome + a one-line summary of the plan you filed (e.g. "filed 6 tasks
   across engineer + designer to close the gap on 'Grow signups'"). Note anything you could not plan.

You act on the company's behalf. You never dispatch or run the work — you shape it and hand it back.`;
