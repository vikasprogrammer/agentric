// v2 mock fleet — real instapods/instawp domain flavor. This is scaffolding: the next
// increment swaps it for live /api/state + /api/sessions calls (see App.tsx TODO).

export type Status = 'run' | 'wait' | 'block' | 'idle'

export interface SessionRow {
  t: string; d: string; when: string
  tag?: Status; tagText?: string
  verdict?: 'ok' | 'warn'; verText?: string
}
export interface AutomationRow { t: string; d: string; tag: Status; tagText: string; when: string }
export interface InsightRow { t: string; d: string; when: string }
export interface MemoryRow { body: string; kind: string; when: string; recalled: string }

export interface Agent {
  id: string; handle: string; status: Status; statusText: string; blurb: string
  stats: { runs: string; cost: string; approve: string; memories: string }
  sessions: SessionRow[]
  automations: AutomationRow[]
  insights: InsightRow[]
  memories: MemoryRow[]
  model: string; effort: string; verbosity: string; permission: string
  prompt: string
}

export const AGENTS: Agent[] = [
  {
    id: 'support-ops', handle: 'agent:support-ops', status: 'run', statusText: 'running',
    blurb: 'Triage inbound FreeScout tickets, answer what it can, and delegate code work to the coding agent.',
    stats: { runs: '312', cost: '$48.20', approve: '96%', memories: '84' },
    sessions: [
      { t: 'Reply drafted for ticket #4821 — DNS propagation', d: 'FreeScout · run-as varun', tag: 'run', tagText: 'running', when: 'now' },
      { t: 'Delegated “fix pod restart loop” to coding', d: 'task:9f2a · A2A hand-off', verdict: 'ok', verText: '✓ done', when: '12m' },
      { t: 'Weekly support digest', d: 'cron · Mon 09:00', verdict: 'ok', verText: '✓ done', when: '2d' },
    ],
    automations: [
      { t: 'FreeScout ticket created', d: 'webhook · /hooks/fs-inbound', tag: 'run', tagText: 'on', when: '312 runs' },
      { t: '@mention in #support', d: 'slack · thread continuity on', tag: 'run', tagText: 'on', when: '58 runs' },
      { t: 'Weekly support digest', d: 'cron · 0 9 * * 1', tag: 'run', tagText: 'on', when: '11 runs' },
    ],
    insights: [
      { t: '53% of runs decide to do nothing', d: 'Half of triage sessions end with no action — a cheaper pre-filter on the webhook payload would cut spend.', when: '7d' },
      { t: 'Most-delegated: “restart loop”', d: '9 of 14 hand-offs to coding were the same class of pod crash — a candidate for a dedicated automation.', when: '7d' },
    ],
    memories: [
      { body: 'FreeScout is LIVE on Agent OS and working real tickets — no longer a pilot. Route billing questions to the finance channel, not engineering.', kind: 'project', when: '3d', recalled: '11×' },
      { body: 'Varun prefers a one-line summary at the top of every ticket reply before the detail.', kind: 'feedback', when: '9d', recalled: '27×' },
      { body: 'Pod “restart loop” usually = OOM on the Launch plan; suggest a plan bump before deep debugging.', kind: 'reference', when: '14d', recalled: '6×' },
    ],
    model: 'opus-4.8', effort: 'medium', verbosity: 'terse', permission: 'auto',
    prompt: '# support-ops\n\nYou triage inbound FreeScout tickets for Instapods. Answer what you can from the\nknowledge base. Delegate code changes to `agent:coding` via a task. Never issue a\nrefund or change a plan without an owner approval — the gate will stop you.',
  },
  {
    id: 'pod-troubleshooter', handle: 'agent:pod-troubleshooter', status: 'wait', statusText: 'waiting on you',
    blurb: 'Diagnose failing pods from logs and metrics; propose a fix, then wait for a human before touching production.',
    stats: { runs: '146', cost: '$31.90', approve: '89%', memories: '52' },
    sessions: [
      { t: 'Approval needed — restart pod umbrella-web', d: 'gate · capability pod.restart', tag: 'wait', tagText: 'blocked on you', when: '4m' },
      { t: 'Diagnosed 502 on aos.ai.instawp.io', d: 'nginx upgrade-map · root cause found', verdict: 'ok', verText: '✓ done', when: '1h' },
    ],
    automations: [
      { t: 'Uptime Kuma alert → diagnose', d: 'webhook · /hooks/kuma', tag: 'run', tagText: 'on', when: '146 runs' },
    ],
    insights: [
      { t: 'Approval latency: 22 min median', d: 'Diagnoses are fast but wait ~22 min for a human — an “always-approve restart on staging” rule would unblock the common case.', when: '7d' },
    ],
    memories: [
      { body: 'nginx conditional Connection: upgrade — a hardcoded value 502s every plain HTTP request. Use the $connection_upgrade map.', kind: 'reference', when: '5d', recalled: '4×' },
      { body: 'Never restart a prod pod without an approval; staging is fine to self-serve once the rule lands.', kind: 'feedback', when: '20d', recalled: '9×' },
    ],
    model: 'opus-4.8', effort: 'high', verbosity: 'normal', permission: 'auto',
    prompt: '# pod-troubleshooter\n\nDiagnose failing pods from logs + metrics. Propose the smallest fix. Production\nchanges (restart, redeploy, plan change) MUST go through an approval — surface the\ndiagnosis and wait via `ask`.',
  },
  {
    id: 'coding', handle: 'agent:coding', status: 'idle', statusText: 'idle',
    blurb: 'Implements changes handed off as tasks — writes code, opens a PR authored as the requesting human.',
    stats: { runs: '203', cost: '$102.40', approve: '92%', memories: '61' },
    sessions: [
      { t: 'PR #675 — feed icon + label fix', d: 'authored as vikas · squash-merged', verdict: 'ok', verText: '✓ merged', when: '6h' },
      { t: 'Fix pod restart loop (from support-ops)', d: 'task:9f2a · run-as varun', verdict: 'ok', verText: '✓ done', when: '1d' },
    ],
    automations: [],
    insights: [
      { t: 'Highest cost per run in the fleet', d: 'Averages 2.1× the fleet — long transcripts. Terse verbosity on narration could trim ~15% without touching artifacts.', when: '7d' },
    ],
    memories: [
      { body: 'Primary checkout stays clean on main; develop in per-session worktrees via scripts/wt.sh. Ship batches as one PR.', kind: 'project', when: '2d', recalled: '18×' },
      { body: 'Always pass --repo vikasprogrammer/agentric to gh — the CLI targets the fork parent otherwise.', kind: 'reference', when: '8d', recalled: '14×' },
    ],
    model: 'opus-4.8', effort: 'high', verbosity: 'normal', permission: 'auto',
    prompt: '# coding\n\nYou implement changes handed to you as tasks. Work in a worktree, keep the diff\nsmall, open a PR. Close your own loop with task_update(done).',
  },
  {
    id: 'billing-watch', handle: 'agent:billing-watch', status: 'run', statusText: 'running',
    blurb: 'Watches Stripe + plan changes for anomalies and posts a heads-up before anything bills.',
    stats: { runs: '58', cost: '$9.10', approve: '100%', memories: '19' },
    sessions: [
      { t: 'Flagged 3 pods approaching plan limits', d: 'posted to #ops', tag: 'run', tagText: 'running', when: 'now' },
    ],
    automations: [{ t: 'Nightly billing sweep', d: 'cron · 0 2 * * *', tag: 'run', tagText: 'on', when: '58 runs' }],
    insights: [],
    memories: [{ body: 'A first card grants a one-time $10 credit — don’t flag a new pod’s trial as unpaid.', kind: 'reference', when: '30d', recalled: '3×' }],
    model: 'haiku-4.5', effort: 'low', verbosity: 'terse', permission: 'auto',
    prompt: '# billing-watch\n\nNightly, scan pods + plans for anomalies. Post a heads-up; never change a plan\nyourself.',
  },
  {
    id: 'consolidator', handle: 'agent:consolidator', status: 'idle', statusText: 'system · idle',
    blurb: 'The learning gardener — abstracts recurring patterns from fleet episodes into shared memory and KB pages.',
    stats: { runs: '41', cost: '$14.60', approve: '—', memories: '203' },
    sessions: [{ t: 'Consolidated 62 episodes → 4 shared memories', d: 'reflect pass · headless', verdict: 'ok', verText: '✓ done', when: '18h' }],
    automations: [{ t: 'Reflect pass', d: 'cron · 0 */6 * * *', tag: 'run', tagText: 'on', when: '41 runs' }],
    insights: [],
    memories: [{ body: 'Recurring fleet pattern: agents self-delegate then wait — 98% of tasks are agent→agent. Consider a delegation budget.', kind: 'project', when: '1d', recalled: '2×' }],
    model: 'sonnet-5', effort: 'medium', verbosity: 'terse', permission: 'auto',
    prompt: '# consolidator\n\nSystem agent. Abstract recurring, durable patterns from recent episodes into shared\nmemories + KB pages via your own tools. Do not act on the world.',
  },
]

export interface TabDef { key: string; label: string; count?: (a: Agent) => number }
export const TABS: TabDef[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'automations', label: 'Automations', count: (a) => a.automations.length },
  { key: 'insights', label: 'Insights', count: (a) => a.insights.length },
  { key: 'memory', label: 'Memory', count: (a) => a.memories.length },
  { key: 'settings', label: 'Settings' },
]
