/**
 * Agent OS memory — a tiny stdio MCP server the OS injects into every claude-code session.
 *
 * It exposes the OS-owned tools to the agent — `recall`/`remember` (memory), `ask`/`report` (operator),
 * and `list_capabilities`/`policy_check` (policy preview) — and implements them by calling back into
 * agent-os over loopback (the session-scoped /api/* routes), tagged with this session's id. So the
 * backend (sqlite / automem) stays swappable server-side,
 * the per-agent namespace is enforced by the server (not trusted from the agent), and the agent
 * gets durable memory with zero bespoke code — exactly how connectors deliver other MCP tools.
 *
 * Zero-dependency: speaks JSON-RPC 2.0 over newline-delimited stdio by hand (Node's MCP stdio
 * transport), and uses the global `fetch`. Spawned by claude with AOS_URL/SESSION/AGENT in env.
 */
const AOS_URL = (process.env.AOS_URL || 'http://127.0.0.1:3010').replace(/\/$/, '');
const SESSION = process.env.SESSION || '';
const AGENT = process.env.AGENT || '';
// Per-session bearer (0d): the server requires this on the session-scoped loopback routes, so this
// MCP server can only act as ITS session. Injected into this process's env by the launcher.
const SECRET = process.env.AOS_SECRET || '';
// Tenant id (multi-tenant): the server routes these loopback calls to THIS tenant's runtime via the
// `x-aos-tenant` header (loopback has no Host subdomain). Empty → the server falls back to default.
const TENANT = process.env.AOS_TENANT || '';
/** Headers for a loopback agent call: the session bearer + tenant route, plus any extras (e.g. JSON). */
function H(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-aos-secret': SECRET, ...(TENANT ? { 'x-aos-tenant': TENANT } : {}), ...extra };
}

interface JsonRpc {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

// Native Slack reply tool — only offered for Slack-triggered sessions (SLACK_REPLY=1), which have a
// channel/thread bound server-side. The agent supplies only `text`; the server resolves where to post.
const SLACK_REPLY = process.env.SLACK_REPLY === '1';

const SLACK_REPLY_TOOL = {
  name: 'slack_reply',
  description:
    'Reply in the Slack thread that triggered this session. Posts your message back to the exact ' +
    'channel + thread the user wrote from — you do NOT pass a channel id. Call this when you have your ' +
    'answer (you can call it more than once for progress updates). This is the way to talk back to Slack.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'The message to post (Slack mrkdwn supported).' } },
    required: ['text'],
  },
};

// Native Discord reply tool — the exact analogue of slack_reply, offered only for Discord-triggered
// sessions (DISCORD_REPLY=1), which have a channel/message bound server-side.
const DISCORD_REPLY = process.env.DISCORD_REPLY === '1';

const DISCORD_REPLY_TOOL = {
  name: 'discord_reply',
  description:
    'Reply in the Discord channel that triggered this session. Posts your message back as a reply to ' +
    'the exact message the user wrote — you do NOT pass a channel id. Call this when you have your ' +
    'answer (you can call it more than once for progress updates). This is the way to talk back to Discord.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'The message to post (Discord markdown supported).' } },
    required: ['text'],
  },
};

const TOOLS = [
  {
    name: 'recall',
    description:
      "Search your persistent memory for relevant past context (decisions, fixes, gotchas, " +
      'preferences). Call it before non-trivial work to avoid repeating mistakes or re-deriving facts. ' +
      'Returns your own memories AND any shared, company-wide knowledge other agents have published. ' +
      'Results are ranked by relevance — and, where the workspace enables it, nudged toward more recent ' +
      'and more important memories. Each line shows its relevance.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for (free text).' },
        limit: { type: 'number', description: 'Max results (default 8).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'remember',
    description:
      'Store a durable memory for your future self: a decision and its rationale, a fix and its root ' +
      'cause, a gotcha, or a stable preference. Keep each memory one self-contained fact; add short tags. ' +
      'Set `importance` honestly — it can bias future recall toward what matters.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact to remember (self-contained).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Short labels, e.g. ["bug-fix","deploy"].' },
        type: { type: 'string', description: 'Decision | Pattern | Preference | Style | Habit | Insight | Context' },
        importance: { type: 'number', description: '0..1 — how important to retain. ~0.8+ for a key decision/rule, ~0.5 default, ~0.3 for a minor note. Favoured in recall when the workspace enables importance ranking.' },
        shared: { type: 'boolean', description: 'Set true to store as SHARED, company-wide knowledge every agent in the workspace can recall — a stable fact, policy, or convention others will reuse. Default false = private to you. Only share durable, broadly-useful facts; keep run-specific notes private.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'kb_search',
    description:
      'Search the company KNOWLEDGE BASE — the shared, canonical wiki every agent and human co-authors ' +
      '(runbooks, decisions, conventions, facts). Search it before starting non-trivial work or answering ' +
      'questions, so you build on what the company already knows. KB = shared canonical knowledge for ' +
      'everyone; Memory = your own private notes for your own future runs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for (free text).' },
        section: { type: 'string', description: 'Optional: restrict to one section, e.g. "engineering".' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filters.' },
        limit: { type: 'number', description: 'Max results (default 8).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kb_read',
    description: 'Open a knowledge-base page by section + slug (from kb_search results) and read its full markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'The page\'s section, e.g. "engineering".' },
        slug: { type: 'string', description: 'The page\'s slug, e.g. "deploy-runbook".' },
      },
      required: ['section', 'slug'],
    },
  },
  {
    name: 'kb_write',
    description:
      'Create or update a KNOWLEDGE-BASE page — durable, company-wide knowledge others will reuse (a runbook ' +
      'you followed, a decision and its rationale, a convention, a fact you established). Editing an existing ' +
      'page is ENCOURAGED — search first (kb_search) and update in place rather than create a duplicate; your ' +
      'change is versioned and revertable. Use this for shared canonical knowledge, NOT private run notes (use ' +
      'remember for those).',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Section/folder, e.g. "engineering" (lowercased, url-safe).' },
        slug: { type: 'string', description: 'Page slug, e.g. "deploy-runbook" (identifies the page; created if absent).' },
        title: { type: 'string', description: 'Human title (required when creating a new page).' },
        body: { type: 'string', description: 'The full page markdown. Link related pages with [[section/slug]].' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Short labels for search/grouping.' },
        summary: { type: 'string', description: 'One line: what changed (stored on the revision).' },
      },
      required: ['section', 'slug', 'body'],
    },
  },
  {
    name: 'ask',
    description:
      "Ask the human operator a question and WAIT for their answer. Use when you're blocked on a decision " +
      'only they can make (which option, missing detail, risky judgement call). The question appears in their ' +
      'Inbox; this call blocks until they reply, then returns their answer. Prefer this over guessing.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string', description: 'A specific, self-contained question.' } },
      required: ['question'],
    },
  },
  {
    name: 'report',
    description:
      'Report that you have finished the task. Posts a completion card to the Inbox with the outcome and a ' +
      'one-line summary. Call this once, when done — so the operator sees the result without reading the terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', description: 'success | failure | partial' },
        summary: { type: 'string', description: 'One line: what you did / what happened.' },
      },
      required: ['outcome', 'summary'],
    },
  },
  {
    name: 'publish',
    description:
      'Publish a finished deliverable to the Artifacts gallery so the operator can view and download ' +
      "it — a PDF, a Markdown document, an image, a chart. Pass `path` (relative to your working " +
      'folder, e.g. "report.pdf"), a short `title`, and an optional one-line `description`. The file is ' +
      'snapshotted on publish, so you can keep editing your working copy freely. An inbox notification ' +
      'is posted automatically. Use this for real outputs the human should see — NOT for scratch files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file in your working folder (relative, e.g. "report.pdf").' },
        title: { type: 'string', description: 'A short human-readable title for the deliverable.' },
        description: { type: 'string', description: 'Optional one-line description / context.' },
      },
      required: ['path', 'title'],
    },
  },
  {
    name: 'list_capabilities',
    description:
      'List the governed capabilities and how policy treats each one right now: allowed outright, ' +
      'needs human approval (and at what level), or denied. Check this when planning work so you ' +
      'understand your boundaries up front instead of getting blocked mid-task.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'policy_check',
    description:
      'Dry-run the governance policy for a specific action BEFORE you attempt it. Tells you whether it ' +
      'would be allowed, require human approval, or be denied — WITHOUT performing it or notifying ' +
      'anyone. Use it to decide whether to proceed, to batch up approvals, or to explain a limitation ' +
      'in your report. Some rules depend on argument values (e.g. a refund amount), so pass `args`.',
    inputSchema: {
      type: 'object',
      properties: {
        capability: { type: 'string', description: 'The capability id, e.g. "stripe.refund", "deploy.prod".' },
        args: { type: 'object', description: 'The arguments you intend to use (rules may key off values like amountUsd).' },
      },
      required: ['capability'],
    },
  },
  {
    name: 'directory_lookup',
    description:
      'Look up people on the team by name or email. Returns each match with their role and the external ' +
      'accounts they are known by (Slack/Discord user id, GitHub login, email) — so you can figure out ' +
      'WHO to reach and on WHICH channel (e.g. to DM someone on Slack or @-mention them). Leave the query ' +
      'blank to list the whole team. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A name or email (substring match). Blank = list everyone.' },
      },
    },
  },
];

function send(msg: JsonRpc): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function recall(args: Record<string, unknown>): Promise<string> {
  const u = new URL(AOS_URL + '/api/memory/recall');
  u.searchParams.set('session', SESSION);
  u.searchParams.set('agent', AGENT);
  if (args.query) u.searchParams.set('q', String(args.query));
  u.searchParams.set('limit', String(typeof args.limit === 'number' ? args.limit : 8));
  const res = await fetch(u, { headers: H() });
  const data = (await res.json()) as { memories?: Array<{ content: string; tags?: string[]; score?: number }> };
  const mems = data.memories ?? [];
  if (!mems.length) return 'No relevant memories found.';
  // Results come back ranked best-first; show each one's relevance so you can judge how strong a
  // match it is (higher = more relevant; absent when listing by recency rather than a query).
  return mems
    .map((m) => {
      const tags = (m.tags ?? []).filter((t) => !t.startsWith('agent:') && !t.startsWith('tenant:'));
      const rel = typeof m.score === 'number' ? `(relevance ${m.score.toFixed(3)}) ` : '';
      return `- ${rel}${m.content}${tags.length ? ` [${tags.join(', ')}]` : ''}`;
    })
    .join('\n');
}

async function ask(args: Record<string, unknown>): Promise<string> {
  const question = String(args.question ?? '').trim();
  if (!question) return 'No question provided.';
  const res = await fetch(AOS_URL + '/api/ask', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, agent: AGENT, question }),
  });
  const { id } = (await res.json()) as { id?: string };
  if (!id) return 'Could not post the question.';
  // Poll the inbox for the human's answer (up to ~1h), same model as the gate hook.
  for (let i = 0; i < 1800; i++) {
    await sleep(2000);
    const r = await fetch(`${AOS_URL}/api/ask/${id}`);
    const d = (await r.json()) as { status?: string; answer?: string };
    if (d.status === 'answered') return d.answer || '(the operator gave no answer)';
  }
  return 'No answer yet (timed out waiting on the operator). Proceed using your best judgement or ask again.';
}

async function slackReply(args: Record<string, unknown>): Promise<string> {
  const text = String(args.text ?? '').trim();
  if (!text) return 'Nothing to post (text is required).';
  const res = await fetch(AOS_URL + '/api/agent/slack/reply', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, text }),
  });
  const d = (await res.json()) as { ok?: boolean; error?: string };
  return d.ok ? 'Posted to Slack.' : `Could not post to Slack: ${d.error ?? 'unknown error'}`;
}

async function discordReply(args: Record<string, unknown>): Promise<string> {
  const text = String(args.text ?? '').trim();
  if (!text) return 'Nothing to post (text is required).';
  const res = await fetch(AOS_URL + '/api/agent/discord/reply', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, text }),
  });
  const d = (await res.json()) as { ok?: boolean; error?: string };
  return d.ok ? 'Posted to Discord.' : `Could not post to Discord: ${d.error ?? 'unknown error'}`;
}

async function report(args: Record<string, unknown>): Promise<string> {
  const res = await fetch(AOS_URL + '/api/report', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, agent: AGENT, outcome: String(args.outcome ?? 'success'), summary: String(args.summary ?? '') }),
  });
  const d = (await res.json()) as { ok?: boolean; error?: string };
  return d.ok ? 'Reported to the inbox.' : `Could not report: ${d.error ?? 'unknown error'}`;
}

async function publish(args: Record<string, unknown>): Promise<string> {
  const filePath = String(args.path ?? '').trim();
  if (!filePath) return 'Nothing to publish (path is required).';
  const res = await fetch(AOS_URL + '/api/publish', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      session: SESSION,
      path: filePath,
      title: String(args.title ?? ''),
      description: args.description ? String(args.description) : undefined,
    }),
  });
  const d = (await res.json()) as { ok?: boolean; id?: string; error?: string };
  return d.ok
    ? `Published "${filePath}" to the Artifacts gallery (id ${d.id}). The operator has been notified.`
    : `Could not publish: ${d.error ?? 'unknown error'}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function remember(args: Record<string, unknown>): Promise<string> {
  if (!args.content) return 'Nothing to remember (content is required).';
  const res = await fetch(AOS_URL + '/api/memory/remember', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      session: SESSION,
      agent: AGENT,
      content: String(args.content),
      tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
      type: args.type,
      importance: typeof args.importance === 'number' ? args.importance : undefined,
      shared: args.shared === true, // → tenant scope (shared workspace-wide) on the server
    }),
  });
  const data = (await res.json()) as { ok?: boolean; id?: string; scope?: string; downgraded?: boolean; error?: string };
  if (!data.ok) return `Could not store memory: ${data.error ?? 'unknown error'}`;
  if (data.downgraded) return `Remembered (id ${data.id}) — stored PRIVATELY. This workspace curates shared memory: only a human can publish workspace-wide knowledge.`;
  return `Remembered (id ${data.id})${data.scope === 'tenant' ? ' — shared workspace-wide' : ''}.`;
}

interface KbPageLite { section: string; slug: string; title: string; tags?: string[]; body?: string; rev?: number }

async function kbSearch(args: Record<string, unknown>): Promise<string> {
  const u = new URL(AOS_URL + '/api/kb/search');
  u.searchParams.set('session', SESSION);
  if (args.query) u.searchParams.set('q', String(args.query));
  if (args.section) u.searchParams.set('section', String(args.section));
  if (Array.isArray(args.tags) && args.tags.length) u.searchParams.set('tags', args.tags.map(String).join(','));
  u.searchParams.set('limit', String(typeof args.limit === 'number' ? args.limit : 8));
  const res = await fetch(u, { headers: H() });
  const data = (await res.json()) as { pages?: KbPageLite[] };
  const pages = data.pages ?? [];
  if (!pages.length) return 'No knowledge-base pages found.';
  return pages
    .map((p) => `- ${p.section}/${p.slug} — ${p.title}${p.tags?.length ? ` [${p.tags.join(', ')}]` : ''}`)
    .join('\n') + '\n(Use kb_read with a section + slug to open a page.)';
}

async function kbRead(args: Record<string, unknown>): Promise<string> {
  const u = new URL(AOS_URL + '/api/kb/read');
  u.searchParams.set('session', SESSION);
  u.searchParams.set('section', String(args.section ?? ''));
  u.searchParams.set('slug', String(args.slug ?? ''));
  const res = await fetch(u, { headers: H() });
  if (!res.ok) return 'Page not found.';
  const data = (await res.json()) as { page?: KbPageLite };
  const p = data.page;
  if (!p) return 'Page not found.';
  return `# ${p.title}  (${p.section}/${p.slug}, rev ${p.rev})\n${p.tags?.length ? `tags: ${p.tags.join(', ')}\n` : ''}\n${p.body ?? ''}`;
}

async function kbWrite(args: Record<string, unknown>): Promise<string> {
  if (!args.section || !args.slug || args.body === undefined) return 'kb_write needs a section, a slug, and a body.';
  const res = await fetch(AOS_URL + '/api/kb/write', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      session: SESSION, section: String(args.section), slug: String(args.slug),
      title: args.title !== undefined ? String(args.title) : undefined, body: String(args.body),
      tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
      summary: args.summary !== undefined ? String(args.summary) : undefined,
    }),
  });
  const data = (await res.json()) as { ok?: boolean; section?: string; slug?: string; rev?: number; error?: string };
  if (!data.ok) return `Could not write the page: ${data.error ?? 'unknown error'}`;
  return `Saved ${data.section}/${data.slug} (rev ${data.rev}). The change is versioned — any edit is revertable.`;
}

function verdict(effect?: string, level?: string): string {
  if (effect === 'allow') return 'allowed';
  if (effect === 'deny') return 'DENIED';
  if (effect === 'approve') return `needs ${level ?? 'human'} approval`;
  return 'unknown';
}

async function listCapabilities(): Promise<string> {
  const u = new URL(AOS_URL + '/api/agent/policy');
  u.searchParams.set('session', SESSION);
  const res = await fetch(u, { headers: H() });
  const data = (await res.json()) as {
    capabilities?: Array<{ id: string; description?: string; effect?: string; level?: string }>;
    error?: string;
  };
  if (data.error) return `Could not list capabilities: ${data.error}`;
  const caps = data.capabilities ?? [];
  if (!caps.length) return 'No governed capabilities are registered.';
  return caps.map((c) => `- ${c.id} — ${verdict(c.effect, c.level)}${c.description ? `: ${c.description}` : ''}`).join('\n');
}

async function policyCheck(args: Record<string, unknown>): Promise<string> {
  const capability = String(args.capability ?? '').trim();
  if (!capability) return 'No capability provided.';
  const res = await fetch(AOS_URL + '/api/agent/policy/check', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      session: SESSION,
      capability,
      args: args.args && typeof args.args === 'object' ? args.args : {},
    }),
  });
  const data = (await res.json()) as { decision?: { effect: string; level?: string; reason?: string }; error?: string };
  if (!data.decision) return `Could not check policy: ${data.error ?? 'unknown error'}`;
  const d = data.decision;
  const why = d.reason ? ` (${d.reason})` : '';
  if (d.effect === 'allow') return `ALLOWED — "${capability}" would run without approval${why}.`;
  if (d.effect === 'deny') return `DENIED — "${capability}" is not permitted${why}.`;
  return `NEEDS APPROVAL — "${capability}" would pause for ${d.level ?? 'human'} approval${why}.`;
}

async function directoryLookup(args: Record<string, unknown>): Promise<string> {
  const u = new URL(AOS_URL + '/api/agent/directory');
  u.searchParams.set('session', SESSION);
  if (args.query) u.searchParams.set('q', String(args.query));
  const res = await fetch(u, { headers: H() });
  const data = (await res.json()) as {
    members?: Array<{ name: string; email: string; role: string; identities: Array<{ provider: string; externalId: string }> }>;
    error?: string;
  };
  if (data.error) return `Could not look up the directory: ${data.error}`;
  const members = data.members ?? [];
  if (!members.length) return args.query ? `No team members match "${String(args.query)}".` : 'No team members found.';
  return members
    .map((m) => {
      const ids = m.identities.map((i) => `${i.provider}:${i.externalId}`).join(', ');
      return `- ${m.name} <${m.email}> (${m.role})${ids ? ` — ${ids}` : ' — no linked chat accounts'}`;
    })
    .join('\n');
}

async function handle(req: JsonRpc): Promise<void> {
  const { id, method, params } = req;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params?.protocolVersion as string) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-os', version: '1.0.0' },
      },
    });
    return;
  }
  // Notifications carry no id and expect no response.
  if (method && method.startsWith('notifications/')) return;

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [...TOOLS, ...(SLACK_REPLY ? [SLACK_REPLY_TOOL] : []), ...(DISCORD_REPLY ? [DISCORD_REPLY_TOOL] : [])] } });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name as string;
    const args = (params?.arguments as Record<string, unknown>) || {};
    try {
      const text =
        name === 'recall' ? await recall(args)
        : name === 'remember' ? await remember(args)
        : name === 'kb_search' ? await kbSearch(args)
        : name === 'kb_read' ? await kbRead(args)
        : name === 'kb_write' ? await kbWrite(args)
        : name === 'ask' ? await ask(args)
        : name === 'report' ? await report(args)
        : name === 'publish' ? await publish(args)
        : name === 'slack_reply' ? await slackReply(args)
        : name === 'discord_reply' ? await discordReply(args)
        : name === 'list_capabilities' ? await listCapabilities()
        : name === 'policy_check' ? await policyCheck(args)
        : name === 'directory_lookup' ? await directoryLookup(args)
        : `unknown tool: ${name}`;
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `memory error: ${e instanceof Error ? e.message : String(e)}` }], isError: true } });
    }
    return;
  }

  // Unknown method with an id → proper JSON-RPC error; ignore id-less calls.
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg: JsonRpc;
    try {
      msg = JSON.parse(line) as JsonRpc;
    } catch {
      continue;
    }
    void handle(msg);
  }
});
