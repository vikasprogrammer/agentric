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
      'and more important memories. Each line shows its relevance AND an id you can pass to `revise`/`forget`.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'What to look for (free text).' },
        limit: { type: 'number', minimum: 1, maximum: 50, default: 8, description: 'Max results (default 8).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'remember',
    description:
      'Store a durable memory for your future self. WHEN to write one — the moments worth encoding: you ' +
      'were SURPRISED (something behaved differently than you expected), you spent real EFFORT figuring ' +
      'something out, you made a DECISION others will depend on, or you hit a GOTCHA / constraint / root ' +
      'cause. Skip routine steps, anything already in the knowledge base, and run-specific trivia — ' +
      'remembering everything is as useless as remembering nothing. Keep each memory one self-contained ' +
      'fact; add short tags. Set `importance` honestly — it can bias future recall toward what matters. ' +
      'Got a fact wrong later? Use `revise` to correct it or `forget` to drop it (recall shows each memory\'s id).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: 'The fact to remember (self-contained).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Short labels, e.g. ["bug-fix","deploy"].' },
        type: { type: 'string', enum: ['Decision', 'Pattern', 'Preference', 'Style', 'Habit', 'Insight', 'Context'], description: 'The kind of memory this is.' },
        importance: { type: 'number', minimum: 0, maximum: 1, description: '0..1 — how important to retain. ~0.8+ for a key decision/rule, ~0.5 default, ~0.3 for a minor note. Favoured in recall when the workspace enables importance ranking.' },
        shared: { type: 'boolean', description: 'Set true to store as SHARED, company-wide knowledge every agent in the workspace can recall — a stable fact, policy, or convention others will reuse. Default false = private to you. Only share durable, broadly-useful facts; keep run-specific notes private.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'revise',
    description:
      'Correct or sharpen one of your OWN existing memories instead of storing a contradictory duplicate. ' +
      'Use it when a fact you remembered turned out wrong or incomplete. Pass the `id` from a recall result ' +
      'and only the fields you want to change. You can only revise memories you authored.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'The memory id (shown by recall).' },
        content: { type: 'string', description: 'Replacement fact (omit to keep the current content).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tags (omit to keep current).' },
        type: { type: 'string', enum: ['Decision', 'Pattern', 'Preference', 'Style', 'Habit', 'Insight', 'Context'], description: 'Replacement type (omit to keep current).' },
        importance: { type: 'number', minimum: 0, maximum: 1, description: 'Replacement importance 0..1 (omit to keep current).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'forget',
    description:
      'Delete one of your OWN memories — a fact that is now stale, wrong, or no longer useful — so it stops ' +
      'surfacing in recall. Pass the `id` from a recall result. You can only forget memories you authored; ' +
      'this is irreversible.',
    annotations: { destructiveHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: 'The memory id (shown by recall).' } },
      required: ['id'],
    },
  },
  {
    name: 'kb_search',
    description:
      'Search the company KNOWLEDGE BASE — the shared, canonical wiki every agent and human co-authors ' +
      '(runbooks, decisions, conventions, facts). Search it before starting non-trivial work or answering ' +
      'questions, so you build on what the company already knows. KB = shared canonical knowledge for ' +
      'everyone; Memory = your own private notes for your own future runs.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'What to look for (free text).' },
        section: { type: 'string', description: 'Optional: restrict to one section, e.g. "engineering".' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filters.' },
        limit: { type: 'number', minimum: 1, maximum: 50, default: 8, description: 'Max results (default 8).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kb_read',
    description: 'Open a knowledge-base page by section + slug (from kb_search results) and read its full markdown.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
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
      additionalProperties: false,
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
    name: 'kb_history',
    description:
      'List the revision history of a knowledge-base page (newest first) — who changed it, when, the one-line ' +
      'summary, and each revision number. Check this before overwriting a page (to see what you would clobber) ' +
      'or to pick a revision number to restore with kb_revert.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        section: { type: 'string', description: 'The page\'s section, e.g. "engineering".' },
        slug: { type: 'string', description: 'The page\'s slug, e.g. "deploy-runbook".' },
      },
      required: ['section', 'slug'],
    },
  },
  {
    name: 'kb_revert',
    description:
      'Restore a knowledge-base page to an earlier revision (from kb_history) — e.g. to undo a bad edit. This is ' +
      'itself a new, auditable, revertable write, so it is always safe. Pass the section + slug + the rev number ' +
      'to restore.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        section: { type: 'string', description: 'The page\'s section.' },
        slug: { type: 'string', description: 'The page\'s slug.' },
        rev: { type: 'number', minimum: 1, description: 'The revision number to restore (from kb_history).' },
      },
      required: ['section', 'slug', 'rev'],
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
      additionalProperties: false,
      properties: { question: { type: 'string', description: 'A specific, self-contained question.' } },
      required: ['question'],
    },
  },
  {
    name: 'report',
    description:
      'Report that you have finished the task. Posts a completion card to the Inbox with the outcome and a ' +
      'one-line summary. Call this once, when done — so the operator sees the result without reading the terminal. ' +
      'This is also your moment to reflect: if the task taught you something durable — a fix and its root cause, ' +
      'a gotcha, a decision your future runs will reuse — pass it in `lessons` and it is saved to your memory so ' +
      'the next session benefits. Omit `lessons` for routine work with nothing worth keeping.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        outcome: { type: 'string', enum: ['success', 'failure', 'partial'], description: 'How the task ended.' },
        summary: { type: 'string', description: 'One line: what you did / what happened.' },
        lessons: { type: 'string', description: 'Optional — a durable lesson from this task (a fix + root cause, a gotcha, a reusable decision), saved to your memory as a note to your future self. Self-contained. Omit for routine work.' },
      },
      required: ['outcome', 'summary'],
    },
  },
  {
    name: 'update',
    description:
      'Post a short progress update to the operator\'s Inbox feed while you work — what you just did, ' +
      'a milestone reached, or a heads-up they should see. Use it sparingly for SIGNAL on a longer task ' +
      '(not a play-by-play): "Scraped 40 pages, analysing now", "Found the bug, drafting the fix". This ' +
      'does NOT block — keep working after calling it. Set `important: true` for a key milestone or a ' +
      'heads-up worth highlighting. For finishing the task use `report`; to ask a blocking question use `ask`.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message: { type: 'string', description: 'One line: what just happened / what you are doing next.' },
        important: { type: 'boolean', description: 'Highlight this as a key milestone or heads-up. Default false.' },
      },
      required: ['message'],
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
      additionalProperties: false,
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
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'policy_check',
    description:
      'Dry-run the governance policy for a specific action BEFORE you attempt it. Tells you whether it ' +
      'would be allowed, require human approval, or be denied — WITHOUT performing it or notifying ' +
      'anyone. Use it to decide whether to proceed, to batch up approvals, or to explain a limitation ' +
      'in your report. Some rules depend on argument values (e.g. a refund amount), so pass `args`.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
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
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'A name or email (substring match). Blank = list everyone.' },
      },
    },
  },
  {
    name: 'check_inbox',
    description:
      'Read your own inbox feed for this session WITHOUT blocking — answers the operator gave to questions ' +
      'you asked, the status of approvals you triggered, and notes/updates on your run. Use this to pick up ' +
      'a human reply you were not actively waiting on (vs `ask`, which blocks until answered). Read-only.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { limit: { type: 'number', minimum: 1, maximum: 50, default: 20, description: 'Max items, newest first (default 20).' } },
    },
  },
  {
    name: 'artifacts_list',
    description:
      'List the deliverables you have already published to the Artifacts gallery (your own past outputs). ' +
      'Check this before publishing to avoid duplicating work, or to build on a report/file you produced ' +
      'in an earlier run. Returns titles + descriptions, not file contents. Read-only.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { limit: { type: 'number', minimum: 1, maximum: 50, default: 20, description: 'Max items, newest first (default 20).' } },
    },
  },
  {
    name: 'schedule',
    description:
      'Schedule a future task for yourself — a follow-up or "check back later". At the chosen time a fresh ' +
      'session of THIS agent starts (unattended) with the task you give, acting as the same identity you run ' +
      'as now. Give either `in_minutes` (relative) or `at` (an absolute ISO time). Use this instead of trying ' +
      'to stay alive waiting: finish now, and let the scheduled run pick the work back up. One-shot (it fires ' +
      'once); it appears in the operator\'s Automations page where it can be cancelled, and `unschedule` cancels ' +
      'it by id. Bounds: 1 minute to 30 days out.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'string', description: 'What the future session should do — written as a self-contained instruction.' },
        in_minutes: { type: 'number', minimum: 1, description: 'Run this many minutes from now (use this OR `at`).' },
        at: { type: 'string', description: 'Absolute time, ISO-8601 e.g. "2026-07-01T14:00:00Z" (use this OR `in_minutes`).' },
        name: { type: 'string', description: 'Optional short label shown in the Automations page.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'unschedule',
    description: 'Cancel a pending scheduled task you created earlier (by the id schedule returned). No effect once it has already fired.',
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: 'The scheduled task id (returned by schedule).' } },
      required: ['id'],
    },
  },
  // ── Tasks: the shared work queue (the durable unit of work, distinct from Memory + KB) ──
  {
    name: 'task_create',
    description:
      'File a durable unit of work on the shared team board — something you or another agent will act on and ' +
      'close, with a lifecycle (todo → doing → blocked → done). This is how you DELEGATE or HAND OFF: assign ' +
      'it to another agent by name to have them pick it up (e.g. a support agent files a coding task for ' +
      '`assignee:"agent:engineer"`). Set `autoDispatch:true` to have an agent-assigned task spawn a session ' +
      'automatically. Distinct from `remember` (your private note) and `kb_write` (shared reference knowledge): ' +
      'a Task is WORK someone must do. Use sub-tasks (`parentId`) to break big work down.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'A short imperative title, e.g. "Fix null-deref in billing.ts".' },
        body: { type: 'string', description: 'Markdown detail / acceptance criteria — enough for whoever works it.' },
        assignee: { type: 'string', description: 'Who works it: "agent:<id>" to hand off to another agent, a member id, or "me" for yourself. Omit to leave it open for anyone to claim.' },
        priority: { type: 'number', minimum: 0, maximum: 3, description: '0 urgent … 3 low (default 2).' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Optional freeform labels.' },
        parentId: { type: 'string', description: 'Parent task id, to file this as a sub-task.' },
        autoDispatch: { type: 'boolean', description: 'If true and assigned to an agent, the board auto-spawns a session to work it. Default false.' },
        mode: { type: 'string', enum: ['headless', 'interactive'], description: 'How a dispatched session runs: "headless" (default — works to completion then exits) or "interactive" (an attachable TUI a human drives).' },
      },
      required: ['title'],
    },
  },
  {
    name: 'task_list',
    description:
      'Query the shared task board. Check this BEFORE starting or creating work so you don\'t duplicate or ' +
      'collide with another agent. Filter by `status`, `assignee` ("me" = tasks assigned to you), `label`, or ' +
      'a free-text `query`. Read-only.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done', 'cancelled'], description: 'Only tasks in this status.' },
        assignee: { type: 'string', description: '"me" for your own tasks, or "agent:<id>" / a member id.' },
        label: { type: 'string', description: 'Only tasks carrying this label.' },
        query: { type: 'string', description: 'Full-text search over title/body/labels.' },
        limit: { type: 'number', minimum: 1, maximum: 200, description: 'Max results (default 100).' },
      },
    },
  },
  {
    name: 'task_get',
    description: 'Read one task in full — its description, current status, and complete activity timeline (comments, status changes, claims, dispatches). Read-only.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: 'The task id.' } },
      required: ['id'],
    },
  },
  {
    name: 'task_claim',
    description:
      'Atomically take an OPEN task to work it yourself — assigns it to you and moves it to `doing`. Claim ' +
      'BEFORE you start so two agents don\'t work the same item; if someone already holds it you\'ll get a ' +
      'clear "already claimed" and should move on to another task. Close it out later with task_update.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: 'The task id to claim.' } },
      required: ['id'],
    },
  },
  {
    name: 'task_update',
    description:
      'Update a task: change its `status`, leave a `note` (appended to the activity timeline), reassign it, or ' +
      'reprioritise. This is how you CLOSE YOUR LOOP — when you finish work dispatched to you, call ' +
      'task_update({ id, status:"done", note:"<what you did>" }); if you\'re stuck, status:"blocked" with why. ' +
      'A note without a status change is just a comment others will see.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'The task id.' },
        status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done', 'cancelled'], description: 'New status.' },
        note: { type: 'string', description: 'A comment / progress note appended to the timeline.' },
        assignee: { type: 'string', description: 'Reassign: "agent:<id>", a member id, "me", or null to unassign.' },
        priority: { type: 'number', minimum: 0, maximum: 3, description: '0 urgent … 3 low.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Replace the label set.' },
      },
      required: ['id'],
    },
  },
  // ── Agents: author new agents (the agent-author's build tools) ──
  {
    name: 'agent_create',
    description:
      'Create a brand-new agent in this workspace and register it live (no restart) — the way to turn a ' +
      'role into a real, governed teammate. You supply its id, description, and CLAUDE.md (its system ' +
      'prompt), plus optional category/model/effort/icon/example prompts. The new agent appears in the ' +
      'console under its category and can then be run or assigned by a human. Use this when someone asks ' +
      'you to build or spin up an agent for a job.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Lowercase letters, digits and hyphens (2–40 chars, starts with a letter), e.g. "seo-writer".' },
        description: { type: 'string', description: 'One-line summary of what the agent does.' },
        claudeMd: { type: 'string', description: "The agent's system prompt (CLAUDE.md): role, method, tools it uses, boundaries, how it finishes." },
        category: { type: 'string', description: 'Grouping label for the console, e.g. Support / Engineering / Marketing / Sales / Research / Ops. Omit → Uncategorized.' },
        model: { type: 'string', description: 'Model alias/id override, e.g. "claude-opus-4-8". Omit → inherit the workspace default.' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Reasoning effort override. Omit → inherit the workspace default.' },
        examplePrompts: { type: 'array', items: { type: 'string' }, description: '2–3 clickable starter tasks shown on the agent\'s spawn card.' },
        icon: { type: 'string', description: 'A lucide icon name from the built-in library (e.g. "Bot", "Wrench", "Megaphone"). Omit → default glyph.' },
      },
      required: ['id', 'description', 'claudeMd'],
    },
  },
  {
    name: 'agent_update',
    description:
      'Refine an existing agent: pass its id plus only the fields you want to change (its CLAUDE.md, ' +
      'description, category, model, effort, example prompts, or icon). Re-registers it live so the next ' +
      'session uses the new values. Prefer this over creating a near-duplicate when an agent nearly fits.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'The id of the agent to edit.' },
        description: { type: 'string', description: 'New one-line description.' },
        claudeMd: { type: 'string', description: "Replacement CLAUDE.md (the agent's system prompt)." },
        category: { type: 'string', description: 'New grouping label (empty string clears it → Uncategorized).' },
        model: { type: 'string', description: 'Model override (empty string clears → inherit the workspace default).' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Reasoning-effort override.' },
        examplePrompts: { type: 'array', items: { type: 'string' }, description: 'Replacement starter prompts.' },
        icon: { type: 'string', description: 'New lucide icon name (or raw <svg>).' },
      },
      required: ['id'],
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
  const data = (await res.json()) as { memories?: Array<{ id?: string; content: string; tags?: string[]; score?: number }> };
  const mems = data.memories ?? [];
  if (!mems.length) return 'No relevant memories found.';
  // Results come back ranked best-first; show each one's relevance so you can judge how strong a
  // match it is (higher = more relevant; absent when listing by recency rather than a query). The
  // leading id is the handle for `revise`/`forget`.
  return mems
    .map((m) => {
      const tags = (m.tags ?? []).filter((t) => !t.startsWith('agent:') && !t.startsWith('tenant:'));
      const rel = typeof m.score === 'number' ? `(relevance ${m.score.toFixed(3)}) ` : '';
      const id = m.id ? `[${m.id}] ` : '';
      return `- ${id}${rel}${m.content}${tags.length ? ` [${tags.join(', ')}]` : ''}`;
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
    body: JSON.stringify({ session: SESSION, agent: AGENT, outcome: String(args.outcome ?? 'success'), summary: String(args.summary ?? ''), lessons: args.lessons ? String(args.lessons) : undefined }),
  });
  const d = (await res.json()) as { ok?: boolean; error?: string };
  return d.ok ? 'Reported to the inbox.' : `Could not report: ${d.error ?? 'unknown error'}`;
}

async function update(args: Record<string, unknown>): Promise<string> {
  const message = String(args.message ?? '').trim();
  if (!message) return 'Nothing to post (message is required).';
  const res = await fetch(AOS_URL + '/api/update', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, message, important: args.important === true }),
  });
  const d = (await res.json()) as { ok?: boolean; error?: string };
  return d.ok ? 'Progress posted to the inbox.' : `Could not post update: ${d.error ?? 'unknown error'}`;
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

async function revise(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id ?? '').trim();
  if (!id) return 'Which memory? (id is required — recall shows it).';
  const res = await fetch(AOS_URL + '/api/memory/revise', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      session: SESSION,
      id,
      content: args.content !== undefined ? String(args.content) : undefined,
      tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
      type: args.type,
      importance: typeof args.importance === 'number' ? args.importance : undefined,
    }),
  });
  const d = (await res.json()) as { ok?: boolean; id?: string; error?: string };
  return d.ok ? `Revised memory ${d.id}.` : `Could not revise: ${d.error ?? 'unknown error'}`;
}

async function forget(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id ?? '').trim();
  if (!id) return 'Which memory? (id is required — recall shows it).';
  const res = await fetch(AOS_URL + '/api/memory/forget', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, id }),
  });
  const d = (await res.json()) as { ok?: boolean; deleted?: boolean; error?: string };
  if (!d.ok) return `Could not forget: ${d.error ?? 'unknown error'}`;
  return d.deleted ? `Forgot memory ${id}.` : `No memory ${id} of yours to forget (already gone, or not yours).`;
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

interface KbRevLite { rev: number; author: string; summary?: string; title: string; createdAt: number }

async function kbHistory(args: Record<string, unknown>): Promise<string> {
  const u = new URL(AOS_URL + '/api/kb/history');
  u.searchParams.set('session', SESSION);
  u.searchParams.set('section', String(args.section ?? ''));
  u.searchParams.set('slug', String(args.slug ?? ''));
  const res = await fetch(u, { headers: H() });
  if (!res.ok) return 'Page not found.';
  const data = (await res.json()) as { current?: number; revisions?: KbRevLite[] };
  const revs = data.revisions ?? [];
  if (!revs.length) return 'No revision history for that page.';
  return `Current rev: ${data.current}\n` + revs
    .map((r) => `- rev ${r.rev} by ${r.author}${r.summary ? ` — ${r.summary}` : ''}`)
    .join('\n') + '\n(Use kb_revert with a rev number to restore one.)';
}

async function kbRevert(args: Record<string, unknown>): Promise<string> {
  if (!args.section || !args.slug || typeof args.rev !== 'number') return 'kb_revert needs a section, a slug, and a rev number.';
  const res = await fetch(AOS_URL + '/api/kb/revert', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, section: String(args.section), slug: String(args.slug), rev: args.rev }),
  });
  const data = (await res.json()) as { ok?: boolean; section?: string; slug?: string; rev?: number; error?: string };
  if (!data.ok) return `Could not revert: ${data.error ?? 'unknown error'}`;
  return `Restored ${data.section}/${data.slug} to the chosen revision (now rev ${data.rev}).`;
}

interface FeedMsgLite { type: string; title: string; body: string; status: string; answer?: string; outcome?: string; createdAt: number }

async function checkInbox(args: Record<string, unknown>): Promise<string> {
  const u = new URL(AOS_URL + '/api/inbox');
  u.searchParams.set('session', SESSION);
  u.searchParams.set('limit', String(typeof args.limit === 'number' ? args.limit : 20));
  const res = await fetch(u, { headers: H() });
  const data = (await res.json()) as { messages?: FeedMsgLite[] };
  const msgs = data.messages ?? [];
  if (!msgs.length) return 'Your inbox is empty for this session.';
  return msgs
    .map((m) => {
      const extra = m.answer ? ` → answer: ${m.answer}` : m.outcome ? ` (${m.outcome})` : '';
      return `- [${m.type}/${m.status}] ${m.title}${m.body ? `: ${m.body}` : ''}${extra}`;
    })
    .join('\n');
}

interface ArtifactLite { title: string; description?: string; kind: string; filename: string; bytes: number; createdAt: number }

async function artifactsList(args: Record<string, unknown>): Promise<string> {
  const u = new URL(AOS_URL + '/api/agent/artifacts');
  u.searchParams.set('session', SESSION);
  u.searchParams.set('limit', String(typeof args.limit === 'number' ? args.limit : 20));
  const res = await fetch(u, { headers: H() });
  const data = (await res.json()) as { artifacts?: ArtifactLite[]; enabled?: boolean };
  if (data.enabled === false) return 'The Artifacts gallery is disabled in this workspace.';
  const arts = data.artifacts ?? [];
  if (!arts.length) return 'You have not published any deliverables yet.';
  return arts
    .map((a) => `- ${a.title}${a.description ? ` — ${a.description}` : ''} (${a.kind}, ${a.filename})`)
    .join('\n');
}

async function schedule(args: Record<string, unknown>): Promise<string> {
  const task = String(args.task ?? '').trim();
  if (!task) return 'Nothing to schedule (task is required).';
  if (typeof args.in_minutes !== 'number' && args.at === undefined) return 'Give either in_minutes or at.';
  const res = await fetch(AOS_URL + '/api/agent/schedule', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      session: SESSION,
      task,
      inMinutes: typeof args.in_minutes === 'number' ? args.in_minutes : undefined,
      at: args.at !== undefined ? String(args.at) : undefined,
      name: args.name !== undefined ? String(args.name) : undefined,
    }),
  });
  const d = (await res.json()) as { ok?: boolean; id?: string; runAt?: number; error?: string };
  if (!d.ok) return `Could not schedule: ${d.error ?? 'unknown error'}`;
  const when = d.runAt ? new Date(d.runAt).toISOString() : 'the scheduled time';
  return `Scheduled (id ${d.id}) — a fresh session will run it at ${when}. Cancel with unschedule "${d.id}".`;
}

async function unschedule(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id ?? '').trim();
  if (!id) return 'Which scheduled task? (id is required).';
  const res = await fetch(AOS_URL + '/api/agent/schedule/cancel', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, id }),
  });
  const d = (await res.json()) as { ok?: boolean; cancelled?: boolean; error?: string };
  if (!d.ok) return `Could not cancel: ${d.error ?? 'unknown error'}`;
  return d.cancelled ? `Cancelled scheduled task ${id}.` : `Nothing to cancel for ${id} (already fired, or not yours).`;
}

// ── Tasks: the shared work queue ──────────────────────────────────────────────
interface TaskLite { id: string; title: string; status: string; priority: number; assignee?: string; labels?: string[]; body?: string }
interface TaskEventLite { kind: string; body?: string; author: string; createdAt: number }

async function taskCreate(args: Record<string, unknown>): Promise<string> {
  const title = String(args.title ?? '').trim();
  if (!title) return 'A task needs a title.';
  const res = await fetch(AOS_URL + '/api/tasks/create', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      session: SESSION, title,
      body: args.body !== undefined ? String(args.body) : undefined,
      assignee: args.assignee !== undefined ? String(args.assignee) : undefined,
      priority: typeof args.priority === 'number' ? args.priority : undefined,
      labels: Array.isArray(args.labels) ? args.labels.map(String) : undefined,
      parentId: args.parentId !== undefined ? String(args.parentId) : undefined,
      autoDispatch: args.autoDispatch === true,
      mode: args.mode === 'interactive' ? 'interactive' : undefined,
    }),
  });
  const d = (await res.json()) as { ok?: boolean; id?: string; error?: string };
  if (!d.ok) return `Could not create the task: ${d.error ?? 'unknown error'}`;
  const who = args.assignee ? ` (assigned to ${String(args.assignee)})` : ' (open — anyone can claim it)';
  return `Filed task ${d.id}: "${title}"${who}. Track it with task_get "${d.id}".`;
}

// ── Agents: author new agents ─────────────────────────────────────────────────
async function agentCreate(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id ?? '').trim().toLowerCase();
  const description = String(args.description ?? '').trim();
  const claudeMd = String(args.claudeMd ?? '');
  if (!id) return 'A new agent needs an id (lowercase letters, digits and hyphens).';
  if (!description) return 'A new agent needs a one-line description.';
  if (!claudeMd.trim()) return "A new agent needs a CLAUDE.md (its system prompt).";
  const res = await fetch(AOS_URL + '/api/agents/create', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      session: SESSION, id, description, claudeMd,
      category: args.category !== undefined ? String(args.category) : undefined,
      model: args.model !== undefined ? String(args.model) : undefined,
      effort: args.effort !== undefined ? String(args.effort) : undefined,
      examplePrompts: Array.isArray(args.examplePrompts) ? args.examplePrompts.map(String) : undefined,
      icon: args.icon !== undefined ? String(args.icon) : undefined,
    }),
  });
  const d = (await res.json()) as { ok?: boolean; id?: string; error?: string };
  if (!d.ok) return `Could not create the agent: ${d.error ?? 'unknown error'}`;
  return `Created agent "${d.id}". It's live in the console now (grouped under ${args.category ? String(args.category) : 'Uncategorized'}); a human can run or assign it. Use agent_update "${d.id}" to refine it.`;
}

async function agentUpdate(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id ?? '').trim().toLowerCase();
  if (!id) return 'Which agent? (id is required).';
  // Only forward fields the caller actually supplied, so an unset field is left untouched server-side.
  const body: Record<string, unknown> = { session: SESSION, id };
  for (const k of ['description', 'claudeMd', 'category', 'model', 'effort', 'icon'] as const) {
    if (args[k] !== undefined) body[k] = String(args[k]);
  }
  if (Array.isArray(args.examplePrompts)) body.examplePrompts = args.examplePrompts.map(String);
  const res = await fetch(AOS_URL + '/api/agents/update', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const d = (await res.json()) as { ok?: boolean; id?: string; error?: string };
  if (!d.ok) return `Could not update the agent: ${d.error ?? 'unknown error'}`;
  return `Updated agent "${id}". The next session it runs will use the new configuration.`;
}

async function taskList(args: Record<string, unknown>): Promise<string> {
  const u = new URL(AOS_URL + '/api/tasks/list');
  u.searchParams.set('session', SESSION);
  if (args.status) u.searchParams.set('status', String(args.status));
  if (args.assignee) u.searchParams.set('assignee', String(args.assignee));
  if (args.label) u.searchParams.set('label', String(args.label));
  if (args.query) u.searchParams.set('q', String(args.query));
  if (typeof args.limit === 'number') u.searchParams.set('limit', String(args.limit));
  const res = await fetch(u, { headers: H() });
  const data = (await res.json()) as { tasks?: TaskLite[] };
  const tasks = data.tasks ?? [];
  if (!tasks.length) return 'No tasks match.';
  return tasks
    .map((t) => `- [${t.status}] ${t.id} · P${t.priority} — ${t.title}${t.assignee ? ` → ${t.assignee}` : ''}${t.labels?.length ? ` [${t.labels.join(', ')}]` : ''}`)
    .join('\n') + '\n(Use task_get <id> for detail, task_claim <id> to take one.)';
}

async function taskGet(args: Record<string, unknown>): Promise<string> {
  const u = new URL(AOS_URL + '/api/tasks/get');
  u.searchParams.set('session', SESSION);
  u.searchParams.set('id', String(args.id ?? ''));
  const res = await fetch(u, { headers: H() });
  if (!res.ok) return 'Task not found.';
  const d = (await res.json()) as { task?: TaskLite; events?: TaskEventLite[] };
  if (!d.task) return 'Task not found.';
  const t = d.task;
  const timeline = (d.events ?? [])
    .map((e) => `  · ${e.kind}${e.body ? `: ${e.body}` : ''} — ${e.author}`)
    .join('\n');
  return `${t.id} · [${t.status}] · P${t.priority}${t.assignee ? ` · ${t.assignee}` : ''}\n# ${t.title}\n${t.body ?? ''}\n\nActivity:\n${timeline || '  (none)'}`;
}

async function taskClaim(args: Record<string, unknown>): Promise<string> {
  const res = await fetch(AOS_URL + '/api/tasks/claim', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, id: String(args.id ?? '') }),
  });
  const d = (await res.json()) as { ok?: boolean; task?: TaskLite; error?: string };
  if (!d.ok || !d.task) return `Could not claim: ${d.error ?? 'unknown error'}. Pick another task.`;
  return `Claimed ${d.task.id}: "${d.task.title}" — it's now yours and in "doing". Close it with task_update({ id:"${d.task.id}", status:"done", note:"…" }).`;
}

async function taskUpdate(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id ?? '').trim();
  if (!id) return 'Which task? (id is required).';
  const res = await fetch(AOS_URL + '/api/tasks/update', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      session: SESSION, id,
      status: args.status !== undefined ? String(args.status) : undefined,
      note: args.note !== undefined ? String(args.note) : undefined,
      assignee: args.assignee === null ? null : (args.assignee !== undefined ? String(args.assignee) : undefined),
      priority: typeof args.priority === 'number' ? args.priority : undefined,
      labels: Array.isArray(args.labels) ? args.labels.map(String) : undefined,
    }),
  });
  const d = (await res.json()) as { ok?: boolean; task?: TaskLite; error?: string };
  if (!d.ok || !d.task) return `Could not update: ${d.error ?? 'unknown error'}`;
  return `Updated ${d.task.id} → [${d.task.status}].`;
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
        : name === 'revise' ? await revise(args)
        : name === 'forget' ? await forget(args)
        : name === 'kb_search' ? await kbSearch(args)
        : name === 'kb_read' ? await kbRead(args)
        : name === 'kb_write' ? await kbWrite(args)
        : name === 'kb_history' ? await kbHistory(args)
        : name === 'kb_revert' ? await kbRevert(args)
        : name === 'ask' ? await ask(args)
        : name === 'report' ? await report(args)
        : name === 'update' ? await update(args)
        : name === 'publish' ? await publish(args)
        : name === 'slack_reply' ? await slackReply(args)
        : name === 'discord_reply' ? await discordReply(args)
        : name === 'list_capabilities' ? await listCapabilities()
        : name === 'policy_check' ? await policyCheck(args)
        : name === 'directory_lookup' ? await directoryLookup(args)
        : name === 'check_inbox' ? await checkInbox(args)
        : name === 'artifacts_list' ? await artifactsList(args)
        : name === 'schedule' ? await schedule(args)
        : name === 'unschedule' ? await unschedule(args)
        : name === 'task_create' ? await taskCreate(args)
        : name === 'task_list' ? await taskList(args)
        : name === 'task_get' ? await taskGet(args)
        : name === 'task_claim' ? await taskClaim(args)
        : name === 'task_update' ? await taskUpdate(args)
        : name === 'agent_create' ? await agentCreate(args)
        : name === 'agent_update' ? await agentUpdate(args)
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
