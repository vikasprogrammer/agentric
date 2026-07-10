/**
 * Lever 4 — **consolidation** (the episodic→semantic bridge; the "memory gardener").
 *
 * Where the deterministic Dreaming pass (src/edge/dreaming.ts) only *counts* recent activity, this
 * spawns a governed **headless agent** that *reads* the recent episodes + lessons across the fleet and
 * abstracts the recurring, durable patterns into SHARED memories + KB pages via its own recall / kb_search
 * / remember(shared) / kb_write tools. It's the plan doc's "scheduled headless agent that synthesises
 * prose into the KB" — quality synthesis by Claude, reusing all governance/audit, no in-process LLM client.
 *
 * Manual ("Consolidate now") always works; an opt-in setting runs it after each auto dream pass. Each run
 * advances a watermark (the last `learning.consolidated` audit ts) so it only ever ingests NEW material.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentOS } from '../kernel';
import type { TerminalManager } from '../terminal';
import type { AgentManifest } from '../types';

export const CONSOLIDATOR_ID = 'consolidator';
const AGENT_ID = CONSOLIDATOR_ID;
const WINDOW_FALLBACK_MS = 7 * 24 * 3_600_000;
const MAX_ITEMS = 40; // bound the prompt: newest N episodes/lessons since the watermark
const MIN_ITEMS = 3; // below this there's nothing worth a run

export interface ConsolidateResult {
  spawned: boolean;
  reason?: string;
  sessionId?: string;
  items?: number;
  window?: { since: number; until: number };
}

interface MemRow { id: string; agent_id: string; content: string; metadata: string; created_at: number; kind: string }

export class Consolidation {
  constructor(private readonly os: AgentOS, private readonly tm: TerminalManager) {}

  /** Select the new episodes+lessons since the last consolidation and, if there are enough, spawn the
   *  headless gardener to distil them. Returns without spawning (with a reason) when there's too little. */
  async run(by = 'automation:consolidation'): Promise<ConsolidateResult> {
    const db = this.os.db;
    const until = Date.now();
    const last = db.prepare("SELECT MAX(ts) AS t FROM audit_events WHERE type = 'learning.consolidated'").get<{ t: number | null }>();
    const since = last?.t ?? until - WINDOW_FALLBACK_MS;
    const window = { since, until };

    // Raw material: episodes (what happened) + lessons (what an agent already chose to keep), fleet-wide,
    // since the watermark. Exclude the gardener's own runs so it never consolidates itself recursively.
    const rows = db
      .prepare(
        "SELECT id, agent_id, content, metadata, created_at, " +
          "CASE WHEN tags LIKE '%\"lesson\"%' THEN 'lesson' ELSE 'episode' END AS kind " +
          "FROM memories WHERE created_at > ? AND agent_id != ? " +
          "AND (tags LIKE '%\"episode\"%' OR tags LIKE '%\"lesson\"%') " +
          "ORDER BY created_at DESC LIMIT ?",
      )
      .all<MemRow>(since, AGENT_ID, MAX_ITEMS);

    if (rows.length < MIN_ITEMS) {
      return { spawned: false, reason: `only ${rows.length} new episodes/lessons since last consolidation (need ${MIN_ITEMS})`, items: rows.length, window };
    }

    this.ensureAgent();
    rows.reverse(); // oldest→newest reads more naturally
    const task = this.buildTask(rows);
    const session = this.tm.createSession(AGENT_ID, `Memory consolidation — ${rows.length} episodes/lessons`, task, by, true /* headless */);

    // Advance the watermark at KICKOFF so the same material isn't re-fed next time. The gardener's own
    // memory/KB writes are audited by their tools (memory.stored / kb.written); this just marks the batch.
    this.os.audit.append({ ts: until, runId: session.id, tenant: this.os.tenant, principal: by, type: 'learning.consolidated', data: { items: rows.length, window, sessionId: session.id } });
    return { spawned: true, sessionId: session.id, items: rows.length, window };
  }

  private buildTask(rows: MemRow[]): string {
    const items = rows.map((r, i) => {
      let outcome = '';
      try { outcome = String((JSON.parse(r.metadata || '{}') as { outcome?: unknown }).outcome ?? ''); } catch { /* ignore */ }
      const head = `--- [${i + 1}] agent=${r.agent_id} kind=${r.kind}${outcome ? ` outcome=${outcome}` : ''} ---`;
      return `${head}\n${r.content.trim()}`;
    });
    return [TASK_HEADER, '', items.join('\n\n'), '', TASK_FOOTER].join('\n');
  }

  /** Provision the system gardener agent into the data home on first use (isolated folder + manifest +
   *  CLAUDE.md), then register it live so createSession resolves a real claude-code runtime. Idempotent. */
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
  description: 'Fleet memory gardener — consolidates recent episodes + lessons into durable, shared knowledge.',
  category: 'System',
  principal: 'svc-consolidator',
  policyContext: 'default@v3',
  runtime: 'claude-code',
  model: 'claude-opus-4-8',
  budget: { usdCap: 1, tokenCap: 300_000, wallClockMs: 900_000 },
};

const CLAUDE_MD = `# Memory gardener (consolidator)

You are Agent OS's **memory gardener**. You run periodically: you are handed a batch of recent
**episodes** (end-of-session recaps) and **lessons** (notes agents kept) from across the whole agent
fleet, and you distil them into durable, **shared** knowledge the whole workspace can reuse. You are
the bridge from episodic ("what happened") to semantic ("the reusable lesson").

## Method
1. **Check what already exists first.** \`recall\` broadly and \`kb_search\` the relevant topics — do
   NOT duplicate knowledge. Prefer \`revise\`-ing an existing shared memory or updating a KB page over
   adding a near-duplicate.
2. **Find the recurring signal.** Read the batch in your task. Look for patterns that appear more than
   once: the same problem hit repeatedly, a mistake made again, a fix + root cause worth reusing, a
   stable fact about this environment, a gotcha or constraint.
3. **Write only the durable, broadly-useful patterns, choosing the right artifact for each:**
   - \`remember\` with \`shared: true\` — a self-contained **fact** every agent can recall. Write it in the
     imperative ("When X, do Y") so it's actionable. Set \`importance\` honestly.
   - \`kb_write\` — when it deserves a full runbook/reference **page** (a sensible section, e.g.
     \`operations/\`). Update an existing page rather than forking a new one.
   - \`skill_propose\` — when the batch shows a **repeatable multi-step procedure** run more than once
     that another agent could follow verbatim (a *how-to*, not a fact). List existing skills first and
     prefer refining one over proposing a near-duplicate; your proposal is a draft a human publishes.
     Use sparingly — only for genuine reusable playbooks, not one-liners.
4. **Be selective.** Quality over quantity — a few well-abstracted, high-value memories beat dozens of
   thin ones. Skip one-offs, run-specific trivia, and anything already captured.
5. **Finish with \`report\`** — outcome + a one-line summary of what you consolidated (e.g. "wrote 3
   shared memories + 1 KB page from 40 episodes"). You may pass a \`lessons\` note if the pass itself
   taught you something about consolidating.

You act on the fleet's behalf. Nothing you do needs a human's connectors — you only read the batch and
write to memory + the KB.`;

const TASK_HEADER = `You are consolidating fleet memory. Below are recent session **episodes** and **lessons** from across
the agent fleet since the last consolidation. Distil the RECURRING, durable patterns into shared
knowledge — follow your CLAUDE.md method: check existing knowledge first (recall / kb_search), be
selective, then write shared memories and/or KB pages.`;

const TASK_FOOTER = `--- end of batch ---
Now: \`recall\` + \`kb_search\` to avoid duplicates, then write only the durable, broadly-useful patterns
as SHARED memories (\`remember\` with shared:true) and/or KB pages (\`kb_write\`). Be selective. Finish
with \`report\`.`;
