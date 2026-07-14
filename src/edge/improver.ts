/**
 * **Improver** — the generative half of the Agents improvement tile ("generate the fix"). The scorecard
 * says an agent is underperforming and Diagnosis says *why*; this DRAFTS the fix: a governed headless
 * **improver** agent reads the target's current CLAUDE.md + its recent failures (+ any diagnosis) and
 * writes an improved CLAUDE.md **as a proposal** — a KB page at `operations/proposed/<agent>` whose body
 * IS the proposed system prompt verbatim. Nothing changes live: an owner reviews the draft and **Applies**
 * (commit it as an agent revision) or **Dismisses** (discard the page). See src/server.ts proposal routes.
 *
 * Same governed-spawn shape as Diagnosis / the consolidation gardener (a real claude-code session reusing
 * every gate + audit) — no in-process LLM. On-demand only: it costs a run, and an owner asks for it about
 * a specific agent. The proposal-for-review posture reuses existing rails end to end — KB stores + versions
 * the draft, agent-revisions applies + can roll it back, `report` posts the owner Inbox card.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentOS } from '../kernel';
import type { TerminalManager } from '../terminal';
import type { AgentManifest } from '../types';
import { diagnosisSlug } from './diagnosis';

export const IMPROVER_ID = 'improver';
const PROPOSAL_SECTION = 'operations';
const WINDOW_MS = 45 * 24 * 3_600_000;
const MAX_ITEMS = 20;

export interface ImproveResult { spawned: boolean; reason?: string; sessionId?: string; items?: number; slug?: string }

interface EpRow { content: string; metadata: string; created_at: number }

/** KB slug the improver writes its proposed CLAUDE.md to (the review artifact). */
export function proposalSlug(agentId: string): string {
  return `proposed/${agentId.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;
}

export class Improver {
  constructor(private readonly os: AgentOS, private readonly tm: TerminalManager) {}

  /** Spawn the improver to DRAFT a better CLAUDE.md for `agentId` (does not change it live). */
  async improveAgent(agentId: string, by: string): Promise<ImproveResult> {
    const target = this.os.agents.get(agentId);
    if (!target?.dir) return { spawned: false, reason: `unknown agent ${agentId}` };

    const claudeFile = path.join(target.dir, 'CLAUDE.md');
    const currentMd = fs.existsSync(claudeFile) ? fs.readFileSync(claudeFile, 'utf8') : '';
    if (!currentMd.trim()) return { spawned: false, reason: `${agentId} has no CLAUDE.md to improve` };

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

    // An existing root-cause diagnosis is the best fuel — reference it so the rewrite targets the real cause.
    const diagnosis = this.os.kb.read(this.os.tenant, PROPOSAL_SECTION, diagnosisSlug(agentId));

    this.ensureAgent();
    failures.reverse();
    const slug = proposalSlug(agentId);
    const task = this.buildTask(agentId, currentMd, failures, diagnosis?.body, slug);
    const session = this.tm.createSession(IMPROVER_ID, `Draft an improved CLAUDE.md for ${agentId}`, task, by, true /* headless */, undefined, undefined, by /* run-as the requester */);
    this.os.audit.append({ ts: Date.now(), runId: session.id, tenant: this.os.tenant, principal: by, type: 'insights.improve', data: { agent: agentId, items: failures.length, sessionId: session.id, slug } });
    return { spawned: true, sessionId: session.id, items: failures.length, slug };
  }

  private buildTask(agentId: string, currentMd: string, rows: EpRow[], diagnosis: string | undefined, slug: string): string {
    const items = rows.map((r, i) => {
      let outcome = '';
      try { outcome = String((JSON.parse(r.metadata || '{}') as { outcome?: unknown }).outcome ?? ''); } catch { /* ignore */ }
      return `--- [${i + 1}]${outcome ? ` outcome=${outcome}` : ''} ---\n${r.content.trim()}`;
    });
    const lines = [
      `You are drafting an improved system prompt (**CLAUDE.md**) for the agent **${agentId}**, which has been`,
      `underperforming. Below is its CURRENT CLAUDE.md, then its recent FAILED / STOPPED / PARTIAL runs, and`,
      diagnosis ? `a prior root-cause DIAGNOSIS. Use the diagnosis as your primary guide.` : `(no prior diagnosis exists — infer the recurring failure pattern yourself).`,
      ``,
      `=== CURRENT CLAUDE.md (${currentMd.length} chars) ===`,
      currentMd.trim(),
      `=== end current CLAUDE.md ===`,
      ``,
    ];
    if (diagnosis) lines.push(`=== ROOT-CAUSE DIAGNOSIS ===`, diagnosis.trim(), `=== end diagnosis ===`, ``);
    if (items.length) lines.push(`=== RECENT NON-SUCCESS RUNS (${items.length}) ===`, items.join('\n\n'), `=== end runs ===`, ``);
    lines.push(
      `Now produce a REVISED CLAUDE.md that fixes the recurring cause — clearer method, guardrails against the`,
      `specific failures, tighter instructions. **Preserve** what already works (identity, tools, structure);`,
      `change only what the evidence says is wrong. Keep it the same document, improved — not a rewrite from`,
      `scratch, and not longer for its own sake.`,
      ``,
      `**Write the FULL revised CLAUDE.md** — and nothing else, no commentary — with \`kb_write\` at section`,
      `\`${PROPOSAL_SECTION}\`, slug \`${slug}\`, title \`Proposed CLAUDE.md: ${agentId}\`. The page BODY must be`,
      `exactly the new CLAUDE.md an owner would approve verbatim.`,
      ``,
      `Then \`report\` a 2-3 line summary of WHAT you changed and WHY (the owner reads this to decide whether to`,
      `Apply). Say the owner can review the draft in Knowledge and Apply/Dismiss it from Insights.`,
    );
    return lines.join('\n');
  }

  /** Provision the improver agent into the data home on first use (idempotent; mirrors the analyst). */
  private ensureAgent(): void {
    if (this.os.agents.get(IMPROVER_ID)?.dir) return;
    const base = this.os.paths?.userAgents ?? path.join(process.cwd(), 'data', 'agents');
    const dir = path.join(base, IMPROVER_ID);
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, 'agent.json');
    if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST, null, 2));
    if (!fs.existsSync(path.join(dir, 'CLAUDE.md'))) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), CLAUDE_MD);
    this.os.registerAgent({ ...MANIFEST, dir });
  }
}

const MANIFEST: AgentManifest = {
  id: IMPROVER_ID,
  version: '1.0.0',
  description: 'Fleet improver — drafts a better CLAUDE.md for an underperforming agent, as a review-gated proposal.',
  category: 'System',
  principal: 'svc-improver',
  policyContext: 'default@v3',
  runtime: 'claude-code',
  model: 'claude-opus-4-8',
  budget: { usdCap: 1, tokenCap: 200_000, wallClockMs: 600_000 },
};

const CLAUDE_MD = `# Fleet improver (system-prompt rewriter)

You are Agent OS's **improver**. You are handed one underperforming agent's CURRENT CLAUDE.md, its recent
FAILED / STOPPED / PARTIAL runs, and (usually) a root-cause diagnosis. You draft a **better CLAUDE.md** for
it — a proposal an owner reviews before anything goes live.

## Method
1. **Anchor on the cause.** If a diagnosis is provided, fix THAT. Otherwise read the runs and find the
   recurring failure thread yourself (the same wrong assumption / missing guardrail / ambiguity across runs).
2. **Revise, don't replace.** Keep the agent's identity, its tools, and the parts that already work. Change
   only what the evidence says is wrong — add the missing guardrail, sharpen the vague step, cut what
   misleads. The result should read as the same agent, improved. Don't pad it to look thorough.
3. **Write the full revised document** with \`kb_write\` to the exact section/slug/title in your task. The
   page BODY is the new CLAUDE.md **verbatim** — no preamble, no "here's what I changed" inside it. An owner
   will approve the body as-is.
4. **Then \`report\`** 2-3 lines: what you changed and why. That is the owner's decision aid — be concrete
   ("added a retry/backoff rule for the Atlas 429s that stopped 4 runs"; "removed the contradictory
   'always ask' vs 'never interrupt' guidance"). Point them to Knowledge to read the draft and Insights to
   Apply or Dismiss.

You only read the batch in your task and write one KB page + one report. You never edit the target agent's
files directly — Apply is a human's click. Nothing you do needs anyone's connectors.`;
