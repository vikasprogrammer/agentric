/**
 * Root-cause **diagnosis** — the gardener-powered half of the Insights layer. The deterministic scorecard
 * (src/edge/insights.ts) says *which* agent is struggling and by how much; this answers **why**. On demand
 * (a "Diagnose" button on a struggling scorecard row) it spawns a governed headless **analyst** agent that
 * reads that agent's recent FAILED / STOPPED runs, finds the recurring failure pattern, hypothesizes the
 * root cause, and writes a short diagnosis to a KB page (`operations/diagnosis/<agent>`) + reports.
 *
 * Same shape as the consolidation gardener (a spawned claude-code agent reusing all governance/audit) — no
 * in-process LLM client. Deliberately on-demand, not automatic: it costs a run, and an owner asks for it
 * about a specific agent. The scorecard then links to the diagnosis page. See src/edge/insights.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentOS } from '../kernel';
import type { TerminalManager } from '../terminal';
import type { AgentManifest } from '../types';

export const ANALYST_ID = 'analyst';
const WINDOW_MS = 45 * 24 * 3_600_000; // look back far enough to gather a struggling agent's failures
const MAX_ITEMS = 30;
const MIN_ITEMS = 2; // need at least a couple of failures to find a pattern

export interface DiagnoseResult { spawned: boolean; reason?: string; sessionId?: string; items?: number; slug?: string }

interface EpRow { content: string; metadata: string; created_at: number }

export function diagnosisSlug(agentId: string): string {
  return `diagnosis/${agentId.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;
}

export class Diagnosis {
  constructor(private readonly os: AgentOS, private readonly tm: TerminalManager) {}

  /** Gather `agentId`'s recent non-success runs and spawn the analyst to diagnose the root cause. */
  async run(agentId: string, by: string): Promise<DiagnoseResult> {
    if (!this.os.agents.get(agentId)) return { spawned: false, reason: `unknown agent ${agentId}` };
    const db = this.os.db;
    const since = Date.now() - WINDOW_MS;
    const rows = db
      .prepare("SELECT content, metadata, created_at FROM memories WHERE agent_id = ? AND tags LIKE '%\"episode\"%' AND created_at > ? ORDER BY created_at DESC LIMIT 120")
      .all<EpRow>(agentId, since);
    const failures = rows.filter((r) => {
      let o = '';
      try { o = String((JSON.parse(r.metadata || '{}') as { outcome?: unknown }).outcome ?? ''); } catch { /* ignore */ }
      return o === 'failure' || o === 'stopped' || o === 'partial';
    }).slice(0, MAX_ITEMS);

    if (failures.length < MIN_ITEMS) {
      return { spawned: false, reason: `only ${failures.length} recent non-success runs for ${agentId} (need ${MIN_ITEMS})`, items: failures.length };
    }

    this.ensureAgent();
    failures.reverse();
    const slug = diagnosisSlug(agentId);
    const task = this.buildTask(agentId, failures, slug);
    const session = this.tm.createSession(ANALYST_ID, `Diagnose ${agentId} — ${failures.length} failed runs`, task, by, true /* headless */, undefined, undefined, by /* run-as the requester */);
    this.os.audit.append({ ts: Date.now(), runId: session.id, tenant: this.os.tenant, principal: by, type: 'insights.diagnose', data: { agent: agentId, items: failures.length, sessionId: session.id, slug } });
    return { spawned: true, sessionId: session.id, items: failures.length, slug };
  }

  private buildTask(agentId: string, rows: EpRow[], slug: string): string {
    const items = rows.map((r, i) => {
      let outcome = '';
      try { outcome = String((JSON.parse(r.metadata || '{}') as { outcome?: unknown }).outcome ?? ''); } catch { /* ignore */ }
      return `--- [${i + 1}]${outcome ? ` outcome=${outcome}` : ''} ---\n${r.content.trim()}`;
    });
    return [
      `You are diagnosing why the agent **${agentId}** keeps struggling. Below are its recent FAILED / STOPPED /`,
      `PARTIAL runs (end-of-session recaps). Find the RECURRING failure pattern, hypothesize the ROOT CAUSE,`,
      `and recommend a concrete FIX — follow your CLAUDE.md method.`,
      ``,
      items.join('\n\n'),
      ``,
      `--- end of runs ---`,
      `Now write your diagnosis to the Knowledge Base with \`kb_write\` at section \`operations\`, slug \`${slug}\`,`,
      `title \`Diagnosis: ${agentId}\`. Keep it short and actionable: **Pattern**, **Likely cause**, **Suggested fix**,`,
      `and a one-line **Evidence** citing how many runs show it. Then \`report\` a one-line summary.`,
    ].join('\n');
  }

  /** Provision the analyst agent into the data home on first use. Idempotent (mirrors the consolidator). */
  private ensureAgent(): void {
    if (this.os.agents.get(ANALYST_ID)?.dir) return;
    const base = this.os.paths?.userAgents ?? path.join(process.cwd(), 'data', 'agents');
    const dir = path.join(base, ANALYST_ID);
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, 'agent.json');
    if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST, null, 2));
    if (!fs.existsSync(path.join(dir, 'CLAUDE.md'))) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), CLAUDE_MD);
    this.os.registerAgent({ ...MANIFEST, dir });
  }
}

const MANIFEST: AgentManifest = {
  id: ANALYST_ID,
  version: '1.0.0',
  description: 'Fleet analyst — diagnoses why a struggling agent keeps failing, root-cause + fix, into the KB.',
  category: 'System',
  principal: 'svc-analyst',
  policyContext: 'default@v3',
  runtime: 'claude-code',
  model: 'claude-opus-4-8',
  budget: { usdCap: 1, tokenCap: 200_000, wallClockMs: 600_000 },
};

const CLAUDE_MD = `# Fleet analyst (root-cause)

You are Agent OS's **analyst**. You are handed the recent FAILED / STOPPED / PARTIAL runs of a single
agent that's underperforming, and you diagnose **why** — so a human can fix the actual cause instead of
guessing.

## Method
1. **Read the runs in your task.** Look for the RECURRING thread — the same error, the same blocker, the
   same wrong assumption showing up across multiple runs. One-off flukes are noise; you want the pattern.
2. **Name the likely ROOT CAUSE.** Not the symptom ("the run stopped") but the cause ("the Atlas image API
   rate-limits on retry and the agent has no backoff", "it keeps needing a host that was never granted",
   "the task is ambiguous and it guesses"). Be specific and evidence-based; say "unclear" if the runs
   genuinely don't show one rather than inventing.
3. **Recommend a concrete FIX** — a policy/host/tuning change, a CLAUDE.md instruction, a missing tool, a
   clearer task. Something the owner can act on.
4. **Write it with \`kb_write\`** to the section/slug/title given in your task. Keep it SHORT and skimmable:
   **Pattern** · **Likely cause** · **Suggested fix** · **Evidence** (how many runs show it). Overwrite the
   page if it exists (it's the living diagnosis for this agent).
5. **Finish with \`report\`** — a one-line summary (e.g. "researcher: 5/7 media-tool runs hit Atlas
   rate-limits — add backoff or switch backend").

You only read the batch in your task and write one KB page. Nothing you do needs a human's connectors.`;
