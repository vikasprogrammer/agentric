/**
 * Skills improvement tile — **"generate the fix" for the skills library** (Skills domain of Insights v2).
 *
 * The other tiles surface what already exists (proposed skills awaiting publish); this one is generative:
 * it spawns a governed headless **skill-scout** that reads a slice of the fleet's recent SUCCESSFUL runs,
 * finds a RECURRING multi-step procedure the fleet keeps doing by hand (ideally across agents), checks it
 * isn't already a skill, and drafts ONE reusable skill via `skill_propose`. That lands on the EXISTING
 * proposed-skill rail — an owner reviews + publishes it from the Skills page — so there is no new apply
 * surface; the scout only adds to the review queue the Skills tile already counts.
 *
 * Same governed-spawn shape as the analyst / improver / consolidation gardener (a real claude-code session
 * through every gate + audit, no in-process LLM). On-demand: it costs a run, and an owner asks for it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentOS } from '../kernel';
import type { TerminalManager } from '../terminal';
import type { AgentManifest } from '../types';

export const SCOUT_ID = 'skill-scout';
const WINDOW_MS = 21 * 24 * 3_600_000; // recent enough to reflect how the fleet works now
const MAX_ITEMS = 45;                   // token-bounded sample of successful runs
const MIN_ITEMS = 8;                    // below this there isn't enough signal to spot a repeated pattern

export interface ScoutResult { spawned: boolean; reason?: string; sessionId?: string; items?: number }

interface EpRow { agent_id: string; content: string; metadata: string; created_at: number }

export class SkillScout {
  constructor(private readonly os: AgentOS, private readonly tm: TerminalManager) {}

  /** Spawn the scout to mine recent fleet work for a recurring pattern and draft a skill (proposal-gated). */
  async draft(by: string): Promise<ScoutResult> {
    const db = this.os.db;
    const since = Date.now() - WINDOW_MS;
    const rows = db
      .prepare("SELECT agent_id, content, metadata, created_at FROM memories WHERE created_at > ? AND tags LIKE '%\"episode\"%' ORDER BY created_at DESC LIMIT 300")
      .all<EpRow>(since);
    // Successful runs only — a skill codifies what WORKS, and we want the repeatable happy path.
    const wins = rows.filter((r) => {
      let o = '';
      try { o = String((JSON.parse(r.metadata || '{}') as { outcome?: unknown }).outcome ?? ''); } catch { /* ignore */ }
      return o === 'success';
    }).slice(0, MAX_ITEMS);

    if (wins.length < MIN_ITEMS) {
      return { spawned: false, reason: `only ${wins.length} recent successful runs (need ${MIN_ITEMS} to spot a repeated pattern)`, items: wins.length };
    }

    this.ensureAgent();
    wins.reverse();
    const task = this.buildTask(wins);
    const session = this.tm.createSession(SCOUT_ID, `Mine ${wins.length} fleet runs for a reusable skill`, task, by, true /* headless */, undefined, undefined, by /* run-as the requester */);
    this.os.audit.append({ ts: Date.now(), runId: session.id, tenant: this.os.tenant, principal: by, type: 'insights.skill.scout', data: { items: wins.length, sessionId: session.id } });
    return { spawned: true, sessionId: session.id, items: wins.length };
  }

  private buildTask(rows: EpRow[]): string {
    const items = rows.map((r, i) => `--- [${i + 1}] ${r.agent_id} ---\n${firstLines(r.content, 6)}`);
    return [
      `You are the fleet **skill-scout**. Below are recent SUCCESSFUL runs from across the fleet (end-of-run`,
      `recaps). Your job: find ONE recurring, reusable **procedure** — a multi-step task the fleet keeps doing`,
      `by hand, ideally by more than one agent or repeatedly by one — and draft it as a reusable skill so the`,
      `whole fleet can follow the same playbook next time.`,
      ``,
      items.join('\n\n'),
      ``,
      `--- end of runs ---`,
      ``,
      `Steps:`,
      `1. **First call \`skill_find\`** (no query) to see what's ALREADY in the library — do NOT propose`,
      `   something that already exists or closely overlaps.`,
      `2. Pick the single STRONGEST recurring pattern in the runs above — one that genuinely repeats and would`,
      `   save real work as a playbook. If nothing recurs clearly enough, **do not force it**: \`report\` that`,
      `   you found no strong candidate and stop. A weak/speculative skill is worse than none.`,
      `3. If you found one, draft it with **\`skill_propose\`** — a clear name, a one-line description of WHEN`,
      `   to use it, and a concise step-by-step body (the reusable method, not a recap of these runs). Set`,
      `   \`rationale\` to which runs/agents show the pattern.`,
      `4. **\`report\`** one line: the skill you proposed (or that you found no candidate). Note the owner`,
      `   reviews + publishes proposals on the Skills page.`,
    ].join('\n');
  }

  /** Provision the scout agent into the data home on first use (idempotent; mirrors the analyst). */
  private ensureAgent(): void {
    if (this.os.agents.get(SCOUT_ID)?.dir) return;
    const base = this.os.paths?.userAgents ?? path.join(process.cwd(), 'data', 'agents');
    const dir = path.join(base, SCOUT_ID);
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, 'agent.json');
    if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST, null, 2));
    if (!fs.existsSync(path.join(dir, 'CLAUDE.md'))) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), CLAUDE_MD);
    this.os.registerAgent({ ...MANIFEST, dir });
  }
}

function firstLines(s: string, n: number): string {
  return s.trim().split('\n').slice(0, n).join('\n').slice(0, 500);
}

const MANIFEST: AgentManifest = {
  id: SCOUT_ID,
  version: '1.0.0',
  description: 'Fleet skill-scout — mines recurring successful patterns and drafts reusable skills (proposal-gated).',
  category: 'System',
  principal: 'svc-skill-scout',
  policyContext: 'default@v3',
  runtime: 'claude-code',
  budget: { usdCap: 1, tokenCap: 200_000, wallClockMs: 600_000 },
};

const CLAUDE_MD = `# Fleet skill-scout (procedural memory)

You are Agent OS's **skill-scout**. You are handed a batch of the fleet's recent SUCCESSFUL runs and you
look for a **repeated procedure** worth turning into a reusable skill — a playbook the whole fleet can
follow so the same multi-step task isn't re-figured-out every time.

## Method
1. **See what already exists.** Call \`skill_find\` (no query) first. Never propose a skill that duplicates
   or closely overlaps one already in the library.
2. **Find the strongest pattern.** Read the runs and look for the same multi-step task recurring — ideally
   across different agents, or repeatedly by one. You want a genuine, repeatable procedure, not a one-off.
3. **Don't force it.** If nothing recurs clearly enough to be worth a playbook, \`report\` that you found no
   strong candidate and stop. A speculative skill is noise; restraint is the right call.
4. **Draft one skill** with \`skill_propose\`: a clear \`name\`, a one-line \`description\` of WHEN to reach
   for it, and a \`body\` that is the concise, reusable step-by-step method (general — not a transcript of
   the sample runs). Put the evidence (which runs/agents show the pattern) in \`rationale\`.
5. **\`report\`** one line naming the skill you proposed (or that there was no candidate). It lands as a
   proposal for an owner to review + publish on the Skills page — you never publish it yourself.

You only read the batch in your task and propose at most one skill. Nothing you do needs anyone's connectors.`;
