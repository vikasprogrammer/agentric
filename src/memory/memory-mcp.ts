/**
 * Agent OS memory — a tiny stdio MCP server the OS injects into every claude-code session.
 *
 * It exposes the OS-owned tools to the agent — `recall`/`remember` (memory), `ask_human`/`report` (operator),
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
// Absolute console deep-links agents can hand to a human. Being absolute (AOS_URL is the deployment's
// real public origin) they're clickable in the browser terminal (xterm WebLinks) and autolink in the
// console's markdown/inbox renderers. Mirrors the web app's hash routes (#/kb/<section>/<slug>, etc.).
const consoleLink = (route: string, detail?: string): string =>
  `${AOS_URL}/#/${route}${detail ? '/' + detail.split('/').map(encodeURIComponent).join('/') : ''}`;
const kbLink = (section: string, slug: string): string => consoleLink('kb', `${section}/${slug}`);
const SESSION = process.env.SESSION || '';
const AGENT = process.env.AGENT || '';
// Per-session bearer (0d): the server requires this on the session-scoped loopback routes, so this
// MCP server can only act as ITS session. Injected into this process's env by the launcher.
const SECRET = process.env.AOS_SECRET || '';
// Tenant id (multi-tenant): the server routes these loopback calls to THIS tenant's runtime via the
// `x-aos-tenant` header (loopback has no Host subdomain). Empty → the server falls back to default.
const TENANT = process.env.AOS_TENANT || '';
// UNATTENDED marks an automation/cron/task run — nobody at the terminal (it's an attachable TUI the
// server tears down at turn-end). A blocking `ask` therefore parks after a short window instead of
// hanging ~1h (#138). (Renamed from HEADLESS when unattended runs stopped being `claude -p`.)
const UNATTENDED = process.env.UNATTENDED === '1';
const UNATTENDED_ASK_WAIT_S = Number(process.env.AOS_UNATTENDED_ASK_WAIT_S) || 120;
// How long a delegating agent blocks in `task_wait` for a handed-off task to reach a terminal state. A
// delegated task can legitimately run many minutes, so this is far longer than the ask window — but still
// bounded, so a stuck child can't strand the caller forever (on timeout the tool returns "still running,
// check back", not a hang). Interactive callers wait longer (a human can steer); headless park at this.
const TASK_WAIT_S = Number(process.env.AOS_TASK_WAIT_S) || 900;
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

// Answer tool — offered ONLY to an ask_agent delegate (ASK_ANSWER=1): a one-off session spawned because
// another agent asked this one a question. Calling it returns the answer to that caller and ends the run.
// The server resolves WHICH ask from this session, so the agent supplies only the answer.
const ASK_ANSWER = process.env.ASK_ANSWER === '1';

const ANSWER_TOOL = {
  name: 'answer',
  description:
    'Return your answer to the agent that asked you (this session was spawned by another agent via ' +
    'ask_agent, and it is BLOCKED waiting on you). Call this ONCE when you have the answer — it delivers ' +
    'your reply to the caller and ends this run. Put everything the caller needs in `answer`: they receive ' +
    'ONLY this text, not the rest of your work. If you cannot help, still call it with a short reason.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { answer: { type: 'string', description: 'Your complete, self-contained answer to the calling agent.' } },
    required: ['answer'],
  },
};

// Native proactive egress — offered to ANY session when the workspace has Slack/Discord configured
// (SLACK_EGRESS / DISCORD_EGRESS = '1'), not just chat-triggered ones. Unlike the reply tools these
// are NOT thread-bound: the agent names a channel or person, so it can message anyone / anywhere.
const SLACK_EGRESS = process.env.SLACK_EGRESS === '1';
const DISCORD_EGRESS = process.env.DISCORD_EGRESS === '1';
// IMAGE_GEN: '1' when a workspace image backend (OpenRouter/Atlas) is configured — exposes image_generate.
const IMAGE_GEN = process.env.IMAGE_GEN === '1';
// VIDEO_GEN: '1' when a video backend (fal/Atlas) is configured — exposes video_generate.
const VIDEO_GEN = process.env.VIDEO_GEN === '1';
// VIDEO_UNDERSTAND: '1' when Atlas is configured (its multimodal LLMs do video→text) — exposes video_understand.
const VIDEO_UNDERSTAND = process.env.VIDEO_UNDERSTAND === '1';

const SLACK_SEND_TOOL = {
  name: 'slack_send',
  description:
    'Post a message to a Slack channel (any channel, not just the one that triggered you). Use this to ' +
    'proactively message a channel — announcements, summaries, alerts. For replying to the thread that ' +
    'triggered you, prefer slack_reply.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel id (e.g. C0123ABCD) or name (e.g. "general" / "#general"). Names are resolved to ids; the bot auto-joins public channels it is not in.' },
      text: { type: 'string', description: 'The message to post (Slack mrkdwn supported).' },
    },
    required: ['channel', 'text'],
  },
};

const SLACK_DM_TOOL = {
  name: 'slack_dm',
  description:
    'Send a direct message to a person in Slack. Reach anyone in the workspace — teammate updates, ' +
    'nudges, one-to-one answers.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'The recipient: a Slack user id (e.g. U0123ABCD) or their email address (resolved to their Slack account).' },
      text: { type: 'string', description: 'The message to send (Slack mrkdwn supported).' },
    },
    required: ['to', 'text'],
  },
};

const DISCORD_SEND_TOOL = {
  name: 'discord_send',
  description:
    'Post a message to a Discord channel (any channel, not just the one that triggered you). Use this to ' +
    'proactively message a channel — announcements, summaries, alerts. For replying to the message that ' +
    'triggered you, prefer discord_reply.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'The Discord channel id to post into.' },
      text: { type: 'string', description: 'The message to post (Discord markdown supported).' },
    },
    required: ['channel', 'text'],
  },
};

const DISCORD_DM_TOOL = {
  name: 'discord_dm',
  description:
    'Send a direct message to a person in Discord. Reach anyone in the workspace — teammate updates, ' +
    'nudges, one-to-one answers.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'The recipient Discord user id.' },
      text: { type: 'string', description: 'The message to send (Discord markdown supported).' },
    },
    required: ['to', 'text'],
  },
};

const IMAGE_GENERATE_TOOL = {
  name: 'image_generate',
  description:
    'Generate image(s) from a text prompt. Use this whenever you need to CREATE an image — you cannot ' +
    'draw natively. Each image is saved to the Library (and an inbox card) and the tool ' +
    'returns the artifact id(s); reference those rather than expecting the raw bytes. The generation is ' +
    'governed (cost-metered + audited).',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What to draw — be specific about subject, style, composition, colours.' },
      model: { type: 'string', description: 'Optional model id (backend-specific). Omit to use the workspace default.' },
      size: { type: 'string', description: 'Optional dimensions, e.g. "1024x1024". Omit for the model default.' },
      n: { type: 'number', description: 'How many images to generate (1–4, default 1).' },
    },
    required: ['prompt'],
  },
};

const IMAGE_EDIT_TOOL = {
  name: 'image_edit',
  description:
    'Edit, upscale, or run a named preset on an EXISTING image. Use this to transform an image you already ' +
    'have — change its style/content ("make the sky purple", "add a hat"), upscale it, or remove its ' +
    'background — WITHOUT redrawing from scratch. The source `image` can be a Library artifact id (e.g. from a ' +
    'prior image_generate), a file path in your working folder (a file you wrote OR one uploaded into the ' +
    'session), or an http(s) image URL. The result is saved as a NEW image in the Library (the source is never ' +
    'changed) and the tool returns the new artifact id. Pass `prompt` to describe an edit, `scale` (2 or 4) to ' +
    'upscale, OR `operation` for a named preset ("remove-background" → a transparent PNG cutout). Governed ' +
    '(cost-metered + audited). Requires an Atlas Cloud key.',
  inputSchema: {
    type: 'object',
    properties: {
      image: { type: 'string', description: 'The image to edit: a Library artifact id, a file path in your working folder (written or uploaded), or an http(s) image URL.' },
      prompt: { type: 'string', description: 'How to change the image (e.g. "turn it into a watercolor painting"). Required unless upscaling or using an `operation` preset.' },
      scale: { type: 'number', description: 'Upscale factor (2 or 4). When set, upscales the image and `prompt` is ignored.' },
      operation: { type: 'string', enum: ['remove-background'], description: 'A named preset. "remove-background" removes the background and returns a transparent PNG (no `prompt` needed). Takes precedence over `scale`/`prompt`.' },
      model: { type: 'string', description: 'Optional model id override (an Atlas image-to-image / upscaler model). Omit for the default.' },
    },
    required: ['image'],
  },
};

const VIDEO_GENERATE_TOOL = {
  name: 'video_generate',
  description:
    'Generate a video from a text prompt, OR animate an existing image (image-to-video). Use this to ' +
    'CREATE a video — you cannot produce one natively. Video renders ASYNCHRONOUSLY (usually a few minutes): ' +
    'this returns quickly, and the finished video lands in the Library with an inbox card when ready. If it ' +
    'finishes fast you get the artifact id inline; otherwise you get a job id and a "rendering" status — ' +
    'do NOT block waiting, just tell the user it will appear in the Library shortly. To animate an image, pass ' +
    '`image` and describe the motion in `prompt`. `image` accepts ANY of: a Library artifact id (e.g. from a ' +
    'prior image_generate), a file path in your working folder (a file you wrote OR one uploaded into the ' +
    'session), or an http(s) image URL. Governed (cost-metered + audited).',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What the video should show — subject, action, camera, style. For image-to-video, describe the desired motion.' },
      model: { type: 'string', description: 'Optional model id (backend-specific). Omit to use the workspace default (an image-to-video model is chosen automatically when `image` is set).' },
      durationSec: { type: 'number', description: 'Desired clip length in seconds (1–60; default 5). The model may clamp it.' },
      image: { type: 'string', description: 'Optional image to animate (image-to-video). A Library artifact id, a file path in your working folder (written or uploaded), or an http(s) image URL.' },
    },
    required: ['prompt'],
  },
};

const VIDEO_UNDERSTAND_TOOL = {
  name: 'video_understand',
  description:
    'WATCH a video and answer a question about it (video → text). Use this whenever you need to know what is ' +
    "IN a video — you cannot see video natively. It delegates to a video-capable model and returns a TEXT " +
    'description/answer directly (no artifact). Pass `video` (a Library artifact id, e.g. one video_generate ' +
    'just made; a file path in your working folder, written OR uploaded into the session; or an http(s) video ' +
    'URL) and an optional `prompt` for what to find out ("summarise", "is there a person?", "transcribe any ' +
    'on-screen text", "what happens at the end?"). Omit `prompt` for a general description. Also works on an ' +
    'image if you set `kind:"image"` (but you can usually read images directly). Governed (cost-metered + audited).',
  inputSchema: {
    type: 'object',
    properties: {
      video: { type: 'string', description: 'The video to watch: a Library artifact id, a file path in your working folder (written or uploaded), or an http(s) video URL.' },
      prompt: { type: 'string', description: 'What to find out about the video. Omit for a general detailed description.' },
      kind: { type: 'string', enum: ['video', 'image'], description: 'Media type (default "video"). Set "image" to analyse a still image instead.' },
      model: { type: 'string', description: 'Optional Atlas multimodal model id override (must accept video input). Omit for the default.' },
    },
    required: ['video'],
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
      'Store a durable memory for your future self — one self-contained fact you\'ll want on a later run ' +
      '(a gotcha, a root cause, a decision others depend on, something that surprised you or took real ' +
      'effort). Skip routine steps and run-specific trivia. Add short tags; set `importance` honestly (it ' +
      'can bias future recall). Correct a fact later with `revise`, or drop it with `forget` (recall shows ' +
      'each memory\'s id).',
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
        section: { type: 'string', description: 'Optional: restrict to one section/folder path, e.g. "engineering" or "engineering/backend".' },
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
        section: { type: 'string', description: 'The page\'s section (folder path), e.g. "engineering" or "engineering/backend".' },
        slug: { type: 'string', description: 'The page\'s slug, e.g. "deploy-runbook".' },
      },
      required: ['section', 'slug'],
    },
  },
  {
    name: 'kb_write',
    description:
      'Create or update a KNOWLEDGE-BASE page — durable, company-wide knowledge others reuse (a runbook, a ' +
      'decision + rationale, a convention, an established fact). Search first (kb_search) and edit in place ' +
      'rather than duplicate; changes are versioned and revertable. Shared canonical knowledge, NOT private ' +
      'run notes (use remember for those).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        section: { type: 'string', description: 'Section/folder path, e.g. "engineering" or "engineering/backend" (lowercased, url-safe; nest sub-folders with "/"). Reuse an existing folder (kb_search lists them) rather than inventing a new one.' },
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
        section: { type: 'string', description: 'The page\'s section (folder path), e.g. "engineering" or "engineering/backend".' },
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
        section: { type: 'string', description: 'The page\'s section (folder path), e.g. "engineering" or "engineering/backend".' },
        slug: { type: 'string', description: 'The page\'s slug.' },
        rev: { type: 'number', minimum: 1, description: 'The revision number to restore (from kb_history).' },
      },
      required: ['section', 'slug', 'rev'],
    },
  },
  {
    name: 'ask_human',
    description:
      "Ask a HUMAN a question and WAIT for their answer. Use when you're blocked on a decision only a person " +
      'can make (which option, a missing detail, a confirmation before a risky step). The question appears in ' +
      'their Inbox AND is DMd to them on Slack/Discord; this call blocks until they reply, then returns their ' +
      "answer. Prefer this over guessing. By default it goes to the operator you're working for. Set `to` (a " +
      "teammate's name or email) to ask a SPECIFIC other person instead — e.g. confirm a detail with the " +
      'account owner, or get info only they have. Same blocking behaviour; their reply comes back to you. ' +
      '(To ask another AGENT instead of a person, use ask_agent.)',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string', description: 'A specific, self-contained question.' },
        to: { type: 'string', description: 'Optional. A teammate to ask instead of the operator — their name or email (e.g. "Alex Rivera" or "alex@acme.com"). Omit to ask the human who owns this run.' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional. A short list of choices for a multiple-choice question — they render as one-click buttons in the human\'s Inbox/Chat, and their reply is the option they pick. Use this instead of a native picker when the answer is one of a few known choices (e.g. ["Ship it", "Hold", "Let me look first"]); omit for an open question.' },
      },
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
      'heads-up worth highlighting. For finishing the task use `report`; to ask a blocking question use `ask_human`.',
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
    name: 'notify',
    description:
      'Notify a SPECIFIC teammate — the person who should know about something on this run, when that is ' +
      'someone OTHER than the operator you already report to. By default your progress/updates/questions ' +
      'go only to the human who owns this session; use `notify` to deliberately loop in someone else: ' +
      '"@alex the deploy you asked about is live", "flagging this to the on-call admin". Pass `to` (their ' +
      'name or email) and a one-line `message`. They get an Inbox card + a DM. This does NOT block — keep ' +
      'working. Use it purposefully for the RIGHT person, not to broadcast; there is no team-wide notify.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: { type: 'string', description: "The teammate to notify — their name or email (e.g. \"Alex Rivera\" or \"alex@acme.com\")." },
        message: { type: 'string', description: 'One line: what you want them to know.' },
        important: { type: 'boolean', description: 'Flag as urgent/high-priority. Default false.' },
      },
      required: ['to', 'message'],
    },
  },
  {
    name: 'publish',
    description:
      'Publish a finished deliverable to the Library so the operator can view and download ' +
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
        folder: { type: 'string', description: 'Optional folder path to file it under, e.g. "reports/2024" (nest sub-folders with "/"). Reuse an existing Library folder (library_list shows them) rather than inventing a new one. Omit for the Library root.' },
      },
      required: ['path', 'title'],
    },
  },
  {
    name: 'skill_propose',
    description:
      'Propose a reusable SKILL for the whole workspace — a self-contained, multi-step playbook a ' +
      'teammate (human or agent) could follow verbatim. Use this when you have just worked out HOW to ' +
      'do something repeatable and non-obvious (a procedure, a checklist, a recipe), not a one-off fix ' +
      "and not a plain fact (use `report` lessons / `remember` for facts). Check first that a similar " +
      "skill doesn't already exist. Your proposal is a DRAFT: it is NOT active and no agent can use it " +
      'until a human reviews and publishes it — an inbox card notifies the owner/admins. Pass a short ' +
      '`name` (lowercase-hyphen), a one-line `description` (what it does + when to use it — this is what ' +
      'agents match on), the full Markdown `body` (the steps), and optionally a `rationale` for the reviewer.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Skill id: lowercase letters, digits and hyphens (2–40 chars, starts with a letter). Becomes the /command name.' },
        description: { type: 'string', description: 'One line: what the skill does and when to use it. This is what Claude matches on to auto-invoke it.' },
        body: { type: 'string', description: 'The full SKILL.md body in Markdown — the concrete, self-contained steps. Frontmatter optional (a name/description header is added if absent).' },
        rationale: { type: 'string', description: 'Optional note to the reviewer: why this is worth a skill / where it came from.' },
      },
      required: ['name', 'description', 'body'],
    },
  },
  {
    name: 'host_propose',
    description:
      'Propose a HOST connection for the workspace — a reachable destination (an SSH box, an internal ' +
      'service, a database) your agents should be governed to reach. Use this when you discover you NEED ' +
      "to reach a host that isn't granted yet (an ssh/curl/psql target that would otherwise pause for " +
      'approval every time). Your proposal is a DRAFT: it is INACTIVE and grants no access until an ' +
      'owner/admin reviews and publishes it — an inbox card notifies them. You CANNOT attach a credential ' +
      "(a secret is the admin's to add). Pass a short `name`, the `match` (a hostname like db.internal, a " +
      'wildcard *.internal, a CIDR 10.0.0.0/8, or host:port), optionally the `protocol` and default `posture`, ' +
      'and a `rationale` for the reviewer.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'A short human label for the host (e.g. "Prod database").' },
        match: { type: 'string', description: 'The destination matcher: a hostname (db.internal), a wildcard (*.internal.example.com), a CIDR (10.0.0.0/8), or host:port.' },
        protocol: { type: 'string', enum: ['ssh', 'http', 'postgres', 'any'], description: 'Optional. The protocol this host speaks. Default: any.' },
        posture: { type: 'string', enum: ['allow', 'ask', 'never'], description: 'Optional. Suggested default tier once granted: allow / ask / never. The admin can change it. Default: ask.' },
        rationale: { type: 'string', description: 'Why you need this host — shown to the reviewer.' },
      },
      required: ['name', 'match'],
    },
  },
  {
    name: 'skill_find',
    description:
      'Discover installable SKILLS — the reusable playbooks packaged for this workspace. Returns your ' +
      "library (the skills you already have, each flagged whether it's active for you) plus the bundled " +
      'catalog of ready-made skills you could ask to have installed. Pass a `query` to ALSO search the ' +
      'public skills.sh directory (thousands of community skills across GitHub repos) — each remote hit ' +
      'comes back with its `source` (owner/repo), which you pass to `skill_request`. Call this when a ' +
      'task looks like it has an established procedure you lack, BEFORE working it out from scratch — if a ' +
      'fitting skill exists, request it with `skill_request`. You cannot install skills yourself; a human does.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Optional search term — also surfaces matching community skills from the skills.sh directory (remote GitHub repos).' },
      },
    },
  },
  {
    name: 'skill_request',
    description:
      'Ask a human to INSTALL a skill for the workspace (find installable skills with `skill_find`). You ' +
      'do NOT install it yourself — this raises a request card an owner/admin reviews; once approved the ' +
      'skill is in the library and available to you on your next session. Use it when a skill would help ' +
      "your work. Pass the skill's `name`; for a community skill from `skill_find`'s query results, also " +
      "pass its `source` (the `owner/repo`). Omit `source` for a bundled-catalog skill. Optionally add a " +
      '`rationale` saying why you need it (helps the reviewer decide quickly).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'The skill id to install (from skill_find).' },
        source: { type: 'string', description: "Optional: the community source `owner/repo` (from a skill_find query hit). Omit for a bundled-catalog skill." },
        rationale: { type: 'string', description: 'Optional: why you need this skill / what task it unblocks.' },
      },
      required: ['name'],
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
    name: 'list_agents',
    description:
      'List the OTHER agents in this workspace you can hand work to — the fleet roster. Returns each ' +
      "agent's id, what it does, and its category, so you can pick the RIGHT specialist and delegate to " +
      'it. Use this before delegating instead of guessing an id — a delegation to a non-existent agent ' +
      'never runs. To ask one a question and get the answer back inline, use ask_agent({ agent, question }); ' +
      'to hand off durable, trackable work, file a task with task_create({ assignee: "agent:<id>" }). Read-only.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'ask_agent',
    description:
      'Ask ANOTHER agent a question — or to solve something — and WAIT for its answer, which is returned ' +
      "to you inline. Use this to consult a specialist mid-task (\"ask the data agent for last week's " +
      'numbers", "have the researcher find X") when you need the result NOW to keep going. It spawns that ' +
      'agent as a one-off run, primed with your question; this call blocks until it answers, then returns ' +
      'the answer. Pick the right `agent` id with list_agents first. This is the lightweight synchronous ' +
      'sibling of a task: use it for a question/answer you need back now; use task_create for durable, ' +
      'trackable work you hand off. Long jobs may time out — you then get told it is still running.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { type: 'string', description: "The id of the agent to ask (from list_agents), e.g. \"researcher\"." },
        question: { type: 'string', description: 'A specific, self-contained question or task — everything the other agent needs to answer without more context.' },
        goal: { type: 'string', description: 'Optional single-line objective / definition of done. When set, the other agent works under it as a `/goal` and converges autonomously until it holds before answering — delegate WITH a goal, no task required.' },
        timeoutSeconds: { type: 'number', description: 'Optional. How long to block before parking (default ~15min interactive / ~15min unattended, max 6h). On timeout the other agent keeps working; ask again to keep waiting.' },
      },
      required: ['agent', 'question'],
    },
  },
  {
    name: 'check_inbox',
    description:
      'Read your own inbox feed for this session WITHOUT blocking — answers the operator gave to questions ' +
      'you asked, the status of approvals you triggered, and notes/updates on your run. Use this to pick up ' +
      'a human reply you were not actively waiting on (vs `ask_human`, which blocks until answered). Read-only.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { limit: { type: 'number', minimum: 1, maximum: 50, default: 20, description: 'Max items, newest first (default 20).' } },
    },
  },
  {
    name: 'library_list',
    description:
      'List the deliverables you have already published to the Library (your own past outputs). ' +
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
      'Schedule a future task for yourself — a follow-up or "check back later". At the chosen time a ' +
      'session of THIS agent starts (unattended) with the task you give, acting as the same identity you run ' +
      'as now. By default the scheduled run RESUMES this conversation — it wakes up with your full current ' +
      'context, then reads the task as its next instruction — so you can write the task as a short reminder ' +
      '("check if the reply landed and continue") rather than re-explaining everything. Pass `resume: false` ' +
      'for a clean-slate run instead (unrelated future work, or a far-off schedule where your current context ' +
      'won\'t matter — then make the task fully self-contained). Give either `in_minutes` (relative) or `at` ' +
      '(an absolute ISO time). Use this instead of trying to stay alive waiting: finish now, and let the ' +
      'scheduled run pick the work back up. One-shot (it fires once); it appears in the operator\'s Automations ' +
      'page where it can be cancelled, and `unschedule` cancels it by id. Bounds: 1 minute to 30 days out.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'string', description: 'What the future session should do. With resume (the default) a short reminder is enough; with resume:false make it fully self-contained.' },
        in_minutes: { type: 'number', minimum: 1, description: 'Run this many minutes from now (use this OR `at`).' },
        at: { type: 'string', description: 'Absolute time, ISO-8601 e.g. "2026-07-01T14:00:00Z" (use this OR `in_minutes`).' },
        name: { type: 'string', description: 'Optional short label shown in the Automations page.' },
        resume: { type: 'boolean', description: 'Resume THIS conversation when the run fires (default true). Set false for a fresh, context-free session.' },
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
  {
    name: 'stop',
    description:
      'End THIS session now — the clean way to finish. Call it when the work is done, or when you are ' +
      'blocked and staying alive to wait is pointless (defer with `schedule` first if the work should ' +
      'resume later). This halts your run immediately: it cannot be undone from inside the session, so ' +
      'do any final `report`/`update` BEFORE calling it. A stopped session stays stopped (it will not ' +
      'auto-resume); a human can re-open it later from the console. Any of your pending questions or ' +
      'approvals are cancelled, since you will no longer be around to act on the answers.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { reason: { type: 'string', description: 'Optional short note on why you are stopping — recorded in the audit trail.' } },
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
      'automatically. To hand off and WAIT for the result before you continue, set `wait:true` (or call ' +
      '`task_wait` after filing) — one synchronous call that blocks until the delegate finishes and returns ' +
      'its outcome. Distinct from `remember` (your private note) and `kb_write` (shared reference knowledge): ' +
      'a Task is WORK someone must do. Use sub-tasks (`parentId`) to break big work down. Give time-sensitive ' +
      'work a `due` date (ISO) — the owner is DMed once if it slips past the deadline.',
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
        goalId: { type: 'string', description: 'Link this task to a strategic goal it advances (see goal_list for ids). Its progress then counts toward that goal.' },
        goal: { type: 'string', description: 'The single-line objective the delegate must achieve — the definition of done. On a headless auto-dispatched task the worker runs under this as a `/goal` and converges autonomously until it holds (alias for `criteria`). This is what to state when you delegate WITH a goal.' },
        criteria: { type: 'string', description: 'A single-line, transcript-verifiable acceptance condition, e.g. "all tests in test/auth pass". When set on a headless auto-dispatched task, the worker runs under this as a `/goal` and converges autonomously until it holds. Synonym of `goal`.' },
        poke_on_done: { type: 'boolean', description: 'Fire-and-forget delegation with an async wake-up: hand off, end your turn, and be RESUMED automatically when the delegate finishes (or blocks) — no polling. The async counterpart to `wait` (which blocks). Only for an agent-assigned auto-dispatched task. Default false.' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Task ids this task is BLOCKED BY — it will not dispatch until they are all done. To encode a pipeline: file the earlier steps first, capture their ids from the results, and pass them here so this step waits for them.' },
        autoDispatch: { type: 'boolean', description: 'If true and assigned to an agent, the board auto-spawns a session to work it. Default false.' },
        mode: { type: 'string', enum: ['headless', 'interactive'], description: 'How a dispatched session runs: "headless" (default — works to completion then exits) or "interactive" (an attachable TUI a human drives).' },
        due: { type: 'string', description: 'Optional soft deadline as an ISO date, e.g. "2026-07-15" or "2026-07-15T17:00:00Z".' },
        wait: { type: 'boolean', description: 'If true, block until this task finishes and return its result (synchronous delegation). Implies autoDispatch. Only meaningful when assigned to an agent. Default false: file it and return immediately.' },
        timeoutSeconds: { type: 'number', minimum: 10, maximum: 21600, description: 'When wait is true, max seconds to block before returning "still running" (default ~15 min headless / 1h interactive).' },
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
      'Update a task: change its `status`, leave a `note` (appended to the activity timeline), reassign it, ' +
      'reprioritise, or set/extend its `due` date. This is how you CLOSE YOUR LOOP — when you finish work dispatched to you, call ' +
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
        goalId: { type: 'string', description: 'Link this task to a strategic goal (or null to unlink).' },
        criteria: { type: 'string', description: 'Set the single-line acceptance condition for `/goal` convergence on dispatch (or null to clear).' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Replace the set of task ids this task is blocked by (won\'t dispatch until they finish); [] clears them.' },
        due: { type: 'string', description: 'Set a soft deadline as an ISO date (e.g. "2026-07-15"), or "" / null to clear it.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'task_wait',
    description:
      'Hand off and WAIT: block until a task reaches a terminal state (done / cancelled / blocked), then return ' +
      'its outcome and closing note. Use this right after delegating with task_create({ assignee:"agent:<id>", ' +
      'autoDispatch:true }) — or task_create({ …, wait:true }) to do both in one call — when you need the ' +
      'delegate\'s result before you can continue. The task is dispatched immediately if it hasn\'t started, and ' +
      'a crashed run is retried automatically. Your session stays put and resumes the moment the task finishes. ' +
      'If it times out it keeps running in the background — call task_wait or task_get again to keep watching.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'The task id to wait for.' },
        timeoutSeconds: { type: 'number', minimum: 10, maximum: 21600, description: 'Max seconds to block before returning "still running" (default ~15 min headless / 1h interactive).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'task_attach',
    description:
      'Attach a file from YOUR working folder onto a task — a screenshot, log, report, generated artifact, ' +
      'CSV, etc. — so whoever picks up the task (or the human reviewing it) can see your output. Give the ' +
      'path relative to your working folder (or absolute within it). The file is snapshotted onto the task ' +
      'and listed on its detail view alongside the activity timeline (see task_get). Use this to hand off ' +
      'concrete deliverables with a task, rather than pasting large content into a note.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'The task id to attach the file to.' },
        path: { type: 'string', description: 'Path to the file in your working folder (e.g. "report.pdf" or "out/summary.csv").' },
      },
      required: ['id', 'path'],
    },
  },
  {
    name: 'task_dispatch',
    description:
      'Kick an agent-assigned task into a governed session NOW, instead of waiting for the board to pick it ' +
      'up. Use this to HAND OFF work asynchronously: file a task with task_create({ assignee:"agent:<id>" }) ' +
      'then task_dispatch it to spawn the worker immediately. The spawned session runs to completion and ' +
      'closes its own loop (task_update). The task must be assigned to an agent. It\'s guarded against ' +
      'pile-ups — if a session is already working the task you\'ll get a clear reason and should not retry. ' +
      'This spawns a NEW session, distinct from task_claim (which pulls a task into YOUR current session).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: 'The id of an agent-assigned task to dispatch.' } },
      required: ['id'],
    },
  },
  // ── Goals: the strategic layer your work ladders up to (read + propose; humans decide) ──
  {
    name: 'goal_list',
    description:
      'List the company GOALS — the strategic direction the whole fleet works toward, above the task ' +
      'board. Check this to orient your work: prefer tasks that advance an active goal. Filter by `status` ' +
      "(default shows all) or a free-text `query`. You cannot change a goal here — that's a human decision " +
      '(use `goal_propose` to suggest a new one). Read-only.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['draft', 'active', 'achieved', 'abandoned'], description: 'Only goals in this status (default: all).' },
        query: { type: 'string', description: 'Full-text search over title/body/labels.' },
        limit: { type: 'number', minimum: 1, maximum: 200, description: 'Max results (default 100).' },
      },
    },
  },
  {
    name: 'goal_get',
    description: 'Read one goal in full — its description, target, status, and complete activity timeline. Read-only.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: 'The goal id.' } },
      required: ['id'],
    },
  },
  {
    name: 'goal_propose',
    description:
      'Propose a new company GOAL for a human to review and activate — a strategic objective the fleet ' +
      'should work toward. Use this when you have spotted a direction worth making explicit (not a one-off ' +
      "task — file that with task_create). Your proposal is a DRAFT: it is NOT active and doesn't steer " +
      'anyone until an owner/admin reviews and activates it (an inbox card notifies them). Pass a short ' +
      '`title`, an optional `body` (the what/why), and an optional free-text `target` caption.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'A short goal title, e.g. "Grow Globex signups 20% this quarter".' },
        body: { type: 'string', description: 'The what/why — enough for a human to judge and refine it.' },
        target: { type: 'string', description: 'Optional free-text target caption, e.g. "20% MoM signup growth".' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Optional freeform labels.' },
      },
      required: ['title'],
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
      'Improve YOUR OWN listing — pass only the fields you want to change (your CLAUDE.md system prompt, ' +
      'description, category, model, effort, example prompts, or icon). This is how you self-improve: when ' +
      "you notice a recurring gap in your instructions or a better way to describe what you do, refine it " +
      'here. Takes effect on your next session. Every edit is snapshotted — inspect them with agent_history ' +
      'and undo with agent_revert. You can only edit yourself (the id defaults to you); a human edits others.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Optional — defaults to you. Must be your own id; you cannot edit another agent.' },
        description: { type: 'string', description: 'New one-line description of what you do.' },
        claudeMd: { type: 'string', description: "Replacement CLAUDE.md (your full system prompt). Send the complete new text, not a diff." },
        category: { type: 'string', description: 'New grouping label (empty string clears it → Uncategorized).' },
        model: { type: 'string', description: 'Model override (empty string clears → inherit the workspace default).' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Reasoning-effort override.' },
        examplePrompts: { type: 'array', items: { type: 'string' }, description: 'Replacement starter prompts shown on your spawn card.' },
        icon: { type: 'string', description: 'New lucide icon name (or raw <svg>).' },
      },
    },
  },
  {
    name: 'agent_history',
    description:
      'List the revision history of your own listing (description, starter prompts, CLAUDE.md, tuning) — ' +
      'newest first, each with a rev number, who made it, and a one-line summary. Use this to find a good ' +
      'revision to roll back to after a self-edit that made things worse.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'agent_revert',
    description:
      "Undo a self-edit: roll YOUR OWN listing back to a prior revision (get the number from " +
      'agent_history). Restores that revision\'s description, starter prompts, tuning, and CLAUDE.md, and ' +
      'records the revert as a new revision (so it too is reversible). Takes effect on your next session.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { rev: { type: 'number', description: 'The revision number to restore (from agent_history).' } },
      required: ['rev'],
    },
  },
  // ── Apps: build hosted apps (a mini-CRM, an internal mini-tool) ──
  {
    name: 'app_create',
    description:
      'Build a small HOSTED APP for this workspace — a self-contained tool a human opens in the browser (a ' +
      'mini-CRM, a form, a dashboard, a calculator). You supply its id + name and the server.js source: a ' +
      'zero-dependency Node HTTP server that binds process.env.PORT and honours the X-Forwarded-Prefix ' +
      'header the platform injects (it is mounted at /apps/<id>). It gets its OWN SQLite at ' +
      '$AOS_APP_HOME/data.db and the logged-in user in the X-Aos-Member header. The app lands PROPOSED — a ' +
      'human reviews the code and publishes it to make it live. Use this when someone asks you to build an ' +
      'internal tool or app rather than a one-off document.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'DNS-safe slug: lowercase letters, digits and single hyphens (1–32 chars), e.g. "mini-crm". Becomes the /apps/<id> URL.' },
        name: { type: 'string', description: 'Human-facing name shown in the console + nav.' },
        serverJs: { type: 'string', description: 'The full Node server.js source (single file). Binds process.env.PORT; honours X-Forwarded-Prefix; opens $AOS_APP_HOME/data.db for persistence. Omit → a hello-world template you edit later.' },
        icon: { type: 'string', description: 'A lucide icon name (e.g. "Table", "Contact"). Omit → default glyph.' },
        capabilities: {
          type: 'object',
          additionalProperties: false,
          description: 'Default-deny governance grants. Omit for a pure UI/data app.',
          properties: {
            dispatchAgents: { type: 'array', items: { type: 'string' }, description: 'Agent ids this app may trigger in the background (via /api/app/dispatch). Empty → none.' },
            egress: { type: 'boolean', description: 'Allow outbound network. Default false.' },
            secrets: { type: 'array', items: { type: 'string' }, description: 'Vault keys the app may read.' },
          },
        },
      },
      required: ['id', 'name'],
    },
  },
  {
    name: 'app_list',
    description:
      'List the hosted apps in this workspace and their status (published?, running/cold) — so you can ' +
      'build on an existing one or avoid duplicating it before you app_create.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'app_update',
    description:
      'Edit a hosted app you (or a teammate) built — change its name, icon, capabilities, or replace the ' +
      'server.js source. Pass only what you want to change (id is required). Editing a LIVE (published) app ' +
      'unpublishes it for re-review — a human re-publishes to push the change live, so app code never goes ' +
      'live without human sign-off.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'The app id to edit.' },
        name: { type: 'string', description: 'New name.' },
        serverJs: { type: 'string', description: 'Replacement server.js source (send the full file, not a diff).' },
        icon: { type: 'string', description: 'New lucide icon name.' },
        lifecycle: { type: 'string', enum: ['scale-to-zero', 'resident'], description: 'scale-to-zero (default): cold-start on demand, idle-reaped. resident: kept warm.' },
        capabilities: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dispatchAgents: { type: 'array', items: { type: 'string' } },
            egress: { type: 'boolean' },
            secrets: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'secret_put',
    description:
      'Store a credential (password, API key, token, connection string) in the shared secrets vault so ' +
      'ANOTHER agent — or a later run of yourself — can use it, without ever putting the raw value in a ' +
      'message, memory, task, or report. This is how you hand a secret to a teammate: you store it here ' +
      'under a KEY, then tell them the key NAME (e.g. "I saved it as PROD_DB_URL") — never the value. The ' +
      'value is encrypted at rest and is NOT recorded in the audit trail. Storing a secret is a governed, ' +
      'approval-gated action: this call BLOCKS until a human approves it (unless an approver is already ' +
      'attending your run). Keys are shared tenant-wide, so any agent can secret_get them — only store ' +
      'things that are meant to be shared with the team.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: 'The handle other agents will fetch by — a letter/underscore then letters, digits or underscores, e.g. "PROD_DB_URL", "STRIPE_KEY". This name is safe to share in messages.' },
        value: { type: 'string', description: 'The secret value itself. Encrypted at rest; never logged. Do NOT repeat this value anywhere else (messages, memory, reports) — pass the key name instead.' },
        reasoning: { type: 'string', description: 'One line for the approver: what this credential is and why you are storing it.' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'secret_get',
    description:
      'Fetch a shared credential from the vault by its key (the handle another agent told you, e.g. ' +
      '"PROD_DB_URL"). Returns the plaintext value for you to USE — then use it directly (in the command, ' +
      'the request, the config) and do NOT echo it back into any durable place: not a memory, not a ' +
      'report, not a task update, not the knowledge base. Treat it as read-once. The read is audited by ' +
      'key, never by value.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: 'The secret key/handle to fetch, e.g. "PROD_DB_URL".' },
      },
      required: ['key'],
    },
  },
  {
    name: 'secret_list',
    description:
      'List the shared secret KEYS available in the vault (handles + when/who last set them) — metadata ' +
      'only, never the values. Use it to discover what credentials the team has already shared before you ' +
      'store a duplicate or ask a human, then secret_get the one you need.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'secret_request',
    description:
      'Ask a human about a credential KEY you need — an API key, password, token, or connection string. ' +
      'Two cases, handled automatically: (1) if the vault does NOT have the key, an owner/admin PROVIDES ' +
      'it by typing the value into a secure form — use this INSTEAD of asking them to paste the secret to ' +
      'you in chat, where the raw value would end up in this transcript; (2) if the key already EXISTS in ' +
      'the vault but you cannot read it (it belongs to another agent or person), an owner/admin GRANTS you ' +
      'ACCESS and the existing value is re-scoped to you — no one re-types it. Either way you pass only the ' +
      'KEY name and why you need it, never a value. Once resolved: secret_get it by that key, or (if they ' +
      'inject it) it is a shell env var on your next session. First check secret_list — you may already ' +
      'have access.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: 'The handle you will fetch the credential by — a letter/underscore then letters, digits or underscores, e.g. "STRIPE_API_KEY", "PROD_DB_URL".' },
        reasoning: { type: 'string', description: 'One line for the human: what this credential is and why you need it (helps them fulfil it quickly).' },
      },
      required: ['key'],
    },
  },
  {
    name: 'github_refresh',
    description:
      'Refresh YOUR GitHub token when git/gh suddenly fails with "Bad credentials" or a 401. Your ' +
      'GH_TOKEN is a short-lived (~8h) user token tied to the human you run as; a long or resumed run can ' +
      'outlive it. This forces a fresh token now. On success it returns a shell line to run — copy it ' +
      'EXACTLY (`export GH_TOKEN=…`) so both git and gh pick up the new token — then retry your git/gh ' +
      'command. The token is your own identity, already injected at launch; do not store or echo it ' +
      'anywhere. If it reports the human must re-link GitHub, say so and stop retrying — you cannot fix ' +
      'that yourself.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
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
  const to = args.to ? String(args.to).trim() : undefined;
  // Optional multiple-choice: a short list of string choices → one-click buttons in the human's card.
  const options = Array.isArray(args.options)
    ? args.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 8)
    : undefined;
  const res = await fetch(AOS_URL + '/api/ask', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, agent: AGENT, question, to: to || undefined, options: options?.length ? options : undefined }),
  });
  const posted = (await res.json()) as { id?: string; error?: string; to?: string };
  if (posted.error) return `Could not ask: ${posted.error}`;
  const id = posted.id;
  if (!id) return 'Could not post the question.';
  // Who we're waiting on, for the parking copy — the named teammate when `to` was given, else the operator.
  const who = posted.to || to || 'the operator';
  // Poll the inbox for the human's answer. An INTERACTIVE run waits ~1h (a human is at the terminal and
  // may take a while). An UNATTENDED run (automation/cron/task) has nobody attached, so an hour-long block
  // just strands the session and holds its memory — the question is already in the operator's Inbox +
  // DM'd the moment it was asked, so we only wait a short window in case an operator is live, then PARK
  // (return stop-cleanly guidance rather than hang or guess). NOTE: a pending question also keeps the
  // pane alive server-side (markTurnIdle won't reap a run blocked on a person), so parking here is what
  // lets the pane finally close.
  const maxPolls = UNATTENDED ? Math.max(1, Math.ceil(UNATTENDED_ASK_WAIT_S / 2)) : 1800;
  for (let i = 0; i < maxPolls; i++) {
    await sleep(2000);
    const r = await fetch(`${AOS_URL}/api/ask/${id}`);
    const d = (await r.json()) as { status?: string; answer?: string };
    if (d.status === 'answered') return d.answer || `(${who} gave no answer)`;
    if (d.status === 'cancelled') return `${who} dismissed this question without answering. Proceed using your best judgement, or ask again if you are still blocked.`;
  }
  if (UNATTENDED) {
    return `Nobody answered in the ${UNATTENDED_ASK_WAIT_S}s window on this unattended run (automation/cron/task). ` +
      `Your question is recorded in ${who === 'the operator' ? "the operator's" : `${who}'s`} Inbox and they have been ` +
      'notified, so it is NOT lost. Do NOT proceed with any risky or irreversible action on a guess. Wrap up ' +
      'now: call `report` to summarise what you did and note that you are blocked on this question, then end the ' +
      'run. They will follow up (e.g. by answering and re-running you).';
  }
  return `No answer yet (timed out waiting on ${who}). Proceed using your best judgement or ask again.`;
}

// Ask ANOTHER agent a question and block on its answer — the machine sibling of `ask_human`. Posts to
// /api/ask-agent (which spawns the delegate), then polls /api/ask-agent/:id until answered/failed/timeout.
async function askAgent(args: Record<string, unknown>): Promise<string> {
  const agent = String(args.agent ?? '').trim();
  if (!agent) return 'Which agent? (agent is required — pick an id from list_agents).';
  const question = String(args.question ?? '').trim();
  if (!question) return 'No question provided.';
  const res = await fetch(AOS_URL + '/api/ask-agent', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, agent, question, goal: args.goal !== undefined ? String(args.goal) : undefined }),
  });
  const posted = (await res.json()) as { id?: string; error?: string };
  if (posted.error) return `Could not ask ${agent}: ${posted.error}`;
  const id = posted.id;
  if (!id) return `Could not reach ${agent}.`;
  // Same wait envelope as task_wait — asking an agent to solve something can take minutes. Interactive
  // callers block longer (a human can steer); unattended runs park sooner. Explicit timeout wins; [10s, 6h].
  const requested = typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : undefined;
  const ceilingS = UNATTENDED ? TASK_WAIT_S : Math.max(TASK_WAIT_S, 3600);
  const maxWaitS = Math.min(21600, Math.max(10, requested ?? ceilingS));
  const deadline = Date.now() + maxWaitS * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const r = await fetch(`${AOS_URL}/api/ask-agent/${id}`, { headers: H() });
    const d = (await r.json()) as { status?: string; answer?: string };
    if (d.status === 'answered') return `${agent} answered:\n\n${d.answer || '(no answer text)'}`;
    if (d.status === 'failed') return `${agent} finished without returning an answer (it may have hit an error or ended early). Try re-asking, rephrasing, or a different agent — or proceed with your best judgement.`;
  }
  return `${agent} hasn't answered within ${maxWaitS}s — it's still working in the background. Call ask_agent again to keep waiting, or move on and proceed with your best judgement.`;
}

// An ask_agent delegate returns its answer to the caller (exposed only when ASK_ANSWER=1). The server
// resolves WHICH ask from this session, so we send only the answer text.
async function answer(args: Record<string, unknown>): Promise<string> {
  const text = String(args.answer ?? '').trim();
  if (!text) return 'Nothing to return (answer is required).';
  const res = await fetch(AOS_URL + '/api/agent/answer', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, answer: text }),
  });
  const d = (await res.json()) as { ok?: boolean; error?: string };
  return d.ok
    ? 'Answer delivered to the agent that asked you. You can end this run now.'
    : `Could not deliver the answer: ${d.error ?? 'unknown error'}`;
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

async function imageGenerate(args: Record<string, unknown>): Promise<string> {
  const prompt = String(args.prompt ?? '').trim();
  if (!prompt) return 'A prompt is required.';
  const body: Record<string, unknown> = { session: SESSION, prompt };
  if (typeof args.model === 'string' && args.model.trim()) body.model = args.model.trim();
  if (typeof args.size === 'string' && args.size.trim()) body.size = args.size.trim();
  if (args.n !== undefined) body.n = Number(args.n);
  const res = await fetch(AOS_URL + '/api/agent/image/generate', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const d = (await res.json()) as { ok?: boolean; error?: string; vendor?: string; retryable?: boolean; artifacts?: { id: string; filename: string }[]; model?: string; costUsd?: number; warning?: string };
  if (!d.ok) return `image_generate error: ${mediaErrorHint(d)}`;
  const list = (d.artifacts ?? []).map((a) => `${a.id} (${a.filename})`).join(', ');
  const cost = typeof d.costUsd === 'number' ? ` · ~$${d.costUsd.toFixed(3)}` : '';
  const warn = d.warning ? ` ⚠ ${d.warning}` : '';
  return `Generated ${d.artifacts?.length ?? 0} image(s) with ${d.model ?? 'the default model'}${cost}. Saved to the Library: ${list}.${warn}`;
}

/** A consistent failure suffix for a media call — names the vendor and says whether a plain retry is
 *  worthwhile, so the agent acts on it (retry the transient ones, fix the input on the terminal ones)
 *  instead of blindly re-calling. */
function mediaErrorHint(d: { error?: string; vendor?: string; retryable?: boolean }): string {
  const vendor = d.vendor ? ` [${d.vendor}]` : '';
  const advice = d.retryable === true ? ' — transient, so you may retry once or twice'
    : d.retryable === false ? ' — not transient; do NOT just retry, fix the input/model or surface it'
    : '';
  return `${d.error ?? 'unknown error'}${vendor}${advice}`;
}

async function imageEdit(args: Record<string, unknown>): Promise<string> {
  const image = String(args.image ?? '').trim();
  if (!image) return 'An input `image` is required (a Library artifact id, a working-folder file path, or an image URL).';
  const operation = args.operation === 'remove-background' ? 'remove-background' : undefined;
  const scale = args.scale !== undefined ? Number(args.scale) : undefined;
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!operation && !(scale && scale > 1) && !prompt) return 'Describe the edit in `prompt`, pass `scale` (2 or 4) to upscale, or set `operation` (e.g. "remove-background").';
  const body: Record<string, unknown> = { session: SESSION, image };
  if (operation) body.operation = operation;
  if (prompt) body.prompt = prompt;
  if (scale !== undefined) body.scale = scale;
  if (typeof args.model === 'string' && args.model.trim()) body.model = args.model.trim();
  const res = await fetch(AOS_URL + '/api/agent/image/edit', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const d = (await res.json()) as { ok?: boolean; error?: string; vendor?: string; retryable?: boolean; artifacts?: { id: string; filename: string }[]; model?: string; costUsd?: number; warning?: string };
  if (!d.ok) return `image_edit error: ${mediaErrorHint(d)}`;
  const list = (d.artifacts ?? []).map((a) => `${a.id} (${a.filename})`).join(', ');
  const cost = typeof d.costUsd === 'number' ? ` · ~$${d.costUsd.toFixed(3)}` : '';
  const what = operation === 'remove-background' ? 'Removed background' : scale && scale > 1 ? `Upscaled ${scale}×` : 'Edited';
  const warn = d.warning ? ` ⚠ ${d.warning}` : '';
  return `${what} with ${d.model ?? 'the default model'}${cost}. New image saved to the Library: ${list}.${warn}`;
}

async function videoGenerate(args: Record<string, unknown>): Promise<string> {
  const prompt = String(args.prompt ?? '').trim();
  if (!prompt) return 'A prompt is required.';
  const body: Record<string, unknown> = { session: SESSION, prompt };
  if (typeof args.model === 'string' && args.model.trim()) body.model = args.model.trim();
  if (args.durationSec !== undefined) body.durationSec = Number(args.durationSec);
  if (typeof args.image === 'string' && args.image.trim()) body.image = args.image.trim();
  const res = await fetch(AOS_URL + '/api/agent/video/generate', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const d = (await res.json()) as { ok?: boolean; error?: string; vendor?: string; retryable?: boolean; status?: string; jobId?: string; artifact?: { id: string; filename: string }; model?: string; costUsd?: number };
  if (!d.ok) return `video_generate error: ${mediaErrorHint(d)}`;
  const cost = typeof d.costUsd === 'number' ? ` · ~$${d.costUsd.toFixed(3)}` : '';
  if (d.status === 'done' && d.artifact) {
    return `Video ready with ${d.model ?? 'the default model'}${cost}. Saved to the Library: ${d.artifact.id} (${d.artifact.filename}).`;
  }
  return `Video is rendering with ${d.model ?? 'the default model'}${cost} (job ${d.jobId ?? '?'}). It'll appear in the Library and post an inbox card when done — no need to wait; let the user know it's on the way.`;
}

async function videoUnderstand(args: Record<string, unknown>): Promise<string> {
  const video = String(args.video ?? '').trim();
  if (!video) return 'A `video` is required (a Library artifact id, a working-folder file path, or a video URL).';
  const body: Record<string, unknown> = { session: SESSION, video };
  if (typeof args.prompt === 'string' && args.prompt.trim()) body.prompt = args.prompt.trim();
  if (args.kind === 'image') body.kind = 'image';
  if (typeof args.model === 'string' && args.model.trim()) body.model = args.model.trim();
  const res = await fetch(AOS_URL + '/api/agent/video/understand', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const d = (await res.json()) as { ok?: boolean; error?: string; text?: string; model?: string; costUsd?: number };
  if (!d.ok) return `Could not analyse the video: ${d.error ?? 'unknown error'}`;
  const cost = typeof d.costUsd === 'number' ? ` · ~$${d.costUsd.toFixed(3)}` : '';
  return `${d.text ?? '(no answer)'}\n\n— via ${d.model ?? 'a multimodal model'}${cost}`;
}

async function slackSend(args: Record<string, unknown>): Promise<string> {
  const channel = String(args.channel ?? '').trim();
  const text = String(args.text ?? '').trim();
  if (!channel) return 'A channel (id or name) is required.';
  if (!text) return 'Nothing to post (text is required).';
  const res = await fetch(AOS_URL + '/api/agent/slack/send', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, channel, text }),
  });
  const d = (await res.json()) as { ok?: boolean; error?: string };
  return d.ok ? `Posted to Slack channel ${channel}.` : `Could not post to Slack: ${d.error ?? 'unknown error'}`;
}

async function slackDm(args: Record<string, unknown>): Promise<string> {
  const to = String(args.to ?? '').trim();
  const text = String(args.text ?? '').trim();
  if (!to) return 'A recipient (Slack user id or email) is required.';
  if (!text) return 'Nothing to send (text is required).';
  const res = await fetch(AOS_URL + '/api/agent/slack/dm', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, to, text }),
  });
  const d = (await res.json()) as { ok?: boolean; error?: string };
  return d.ok ? `DM sent to ${to}.` : `Could not DM on Slack: ${d.error ?? 'unknown error'}`;
}

async function discordSend(args: Record<string, unknown>): Promise<string> {
  const channel = String(args.channel ?? '').trim();
  const text = String(args.text ?? '').trim();
  if (!channel) return 'A channel id is required.';
  if (!text) return 'Nothing to post (text is required).';
  const res = await fetch(AOS_URL + '/api/agent/discord/send', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, channel, text }),
  });
  const d = (await res.json()) as { ok?: boolean; error?: string };
  return d.ok ? `Posted to Discord channel ${channel}.` : `Could not post to Discord: ${d.error ?? 'unknown error'}`;
}

async function discordDm(args: Record<string, unknown>): Promise<string> {
  const to = String(args.to ?? '').trim();
  const text = String(args.text ?? '').trim();
  if (!to) return 'A recipient Discord user id is required.';
  if (!text) return 'Nothing to send (text is required).';
  const res = await fetch(AOS_URL + '/api/agent/discord/dm', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, to, text }),
  });
  const d = (await res.json()) as { ok?: boolean; error?: string };
  return d.ok ? `DM sent to ${to}.` : `Could not DM on Discord: ${d.error ?? 'unknown error'}`;
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

async function skillPropose(args: Record<string, unknown>): Promise<string> {
  const name = String(args.name ?? '').trim();
  const description = String(args.description ?? '').trim();
  const body = String(args.body ?? '').trim();
  if (!name || !description || !body) return 'skill_propose needs name, description, and body.';
  const res = await fetch(AOS_URL + '/api/skills/propose', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, agent: AGENT, name, description, body, rationale: args.rationale ? String(args.rationale) : undefined }),
  });
  const d = (await res.json()) as { ok?: boolean; skill?: string; error?: string };
  return d.ok
    ? `Proposed skill "${d.skill ?? name}" — it's a draft in the inbox for an owner/admin to review and publish. It won't be active until then.`
    : `Could not propose skill: ${d.error ?? 'unknown error'}`;
}

async function hostPropose(args: Record<string, unknown>): Promise<string> {
  const name = String(args.name ?? '').trim();
  const match = String(args.match ?? '').trim();
  if (!name || !match) return 'host_propose needs a name and a match (hostname, CIDR, or host:port).';
  const res = await fetch(AOS_URL + '/api/hosts/propose', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      session: SESSION, agent: AGENT, name, match,
      protocol: args.protocol ? String(args.protocol) : undefined,
      posture: args.posture ? String(args.posture) : undefined,
      rationale: args.rationale ? String(args.rationale) : undefined,
    }),
  });
  const d = (await res.json()) as { ok?: boolean; host?: string; error?: string };
  return d.ok
    ? `Proposed host "${name}" (${match}) — it's a draft in the inbox for an owner/admin to review and publish. It grants no access until then.`
    : `Could not propose host: ${d.error ?? 'unknown error'}`;
}

async function skillFind(args: Record<string, unknown>): Promise<string> {
  const u = new URL(AOS_URL + '/api/skills/discover');
  u.searchParams.set('session', SESSION);
  const query = String(args.query ?? '').trim();
  if (query) u.searchParams.set('q', query);
  const res = await fetch(u, { headers: H() });
  const d = (await res.json()) as {
    installed?: Array<{ name: string; description: string; active: boolean }>;
    catalog?: Array<{ name: string; description: string; installed: boolean }>;
    remote?: Array<{ name: string; source: string; installs: number; installed: boolean }>;
    error?: string;
  };
  if (d.error) return `Could not list skills: ${d.error}`;
  const active = (d.installed ?? []).filter((s) => s.active);
  const requestable = (d.catalog ?? []).filter((s) => !s.installed);
  const remote = (d.remote ?? []).filter((s) => !s.installed);
  const lines: string[] = [];
  lines.push(active.length ? `Active for you (${active.length}):` : 'No skills are active for you yet.');
  for (const s of active) lines.push(`  • ${s.name} — ${s.description}`);
  if (requestable.length) {
    lines.push('', `Installable from the catalog — ask with skill_request({name}) (${requestable.length}):`);
    for (const s of requestable) lines.push(`  • ${s.name} — ${s.description}`);
  } else {
    lines.push('', 'Nothing new in the catalog to request — everything is already installed.');
  }
  if (query) {
    if (remote.length) {
      lines.push('', `Community skills matching "${query}" — ask with skill_request({name, source}) (${remote.length}):`);
      for (const s of remote) lines.push(`  • ${s.name} — source: ${s.source}${s.installs ? ` (${s.installs} installs)` : ''}`);
    } else {
      lines.push('', `No community (skills.sh) skills matched "${query}".`);
    }
  }
  return lines.join('\n');
}

async function skillRequest(args: Record<string, unknown>): Promise<string> {
  const name = String(args.name ?? '').trim();
  const source = String(args.source ?? '').trim();
  if (!name) return 'skill_request needs the name of a skill (see skill_find).';
  const res = await fetch(AOS_URL + '/api/skills/request', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, agent: AGENT, name, source: source || undefined, rationale: args.rationale ? String(args.rationale) : undefined }),
  });
  const d = (await res.json()) as { ok?: boolean; status?: string; error?: string };
  if (!d.ok) return `Could not request skill: ${d.error ?? 'unknown error'}`;
  const label = source ? `"${name}" (from ${source})` : `"${name}"`;
  if (d.status === 'installed') return `"${name}" is already installed and available to you.`;
  if (d.status === 'duplicate') return `A request for ${label} is already awaiting review.`;
  return `Requested ${label} — an owner/admin will review and install it. It'll be available to you on your next session (not this one).`;
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

async function notify(args: Record<string, unknown>): Promise<string> {
  const to = String(args.to ?? '').trim();
  const message = String(args.message ?? '').trim();
  if (!to) return 'Who should I notify? (`to` is required — a teammate name or email.)';
  if (!message) return 'Nothing to send (message is required).';
  const res = await fetch(AOS_URL + '/api/notify', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, to, message, important: args.important === true }),
  });
  const d = (await res.json()) as { ok?: boolean; to?: string; error?: string };
  return d.ok ? `Notified ${d.to ?? to} (inbox + DM).` : `Could not notify: ${d.error ?? 'unknown error'}`;
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
      folder: args.folder ? String(args.folder) : undefined,
    }),
  });
  const d = (await res.json()) as { ok?: boolean; id?: string; error?: string };
  const where = args.folder ? ` under "${String(args.folder)}"` : '';
  return d.ok
    ? `Published "${filePath}" to the Library${where} (id ${d.id}). The operator has been notified.\nView it: ${consoleLink('artifacts', d.id)}`
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
  const data = (await res.json()) as { pages?: KbPageLite[]; sections?: string[] };
  const pages = data.pages ?? [];
  // Always surface the existing folder tree so a new page lands in the established structure rather
  // than an inconsistent new folder (e.g. reuse `engineering/backend`, don't invent `eng`).
  const folders = data.sections?.length ? `\n\nExisting folders (reuse one when filing a new page): ${data.sections.join(', ')}` : '';
  if (!pages.length) return `No knowledge-base pages found.${folders}`;
  return pages
    .map((p) => `- ${p.section}/${p.slug} — ${p.title}${p.tags?.length ? ` [${p.tags.join(', ')}]` : ''}  ${kbLink(p.section, p.slug)}`)
    .join('\n') + '\n(Use kb_read with a section + slug to open a page.)' + folders;
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
  return `# ${p.title}  (${p.section}/${p.slug}, rev ${p.rev})\n${kbLink(p.section, p.slug)}\n${p.tags?.length ? `tags: ${p.tags.join(', ')}\n` : ''}\n${p.body ?? ''}`;
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
  return `Saved ${data.section}/${data.slug} (rev ${data.rev}). The change is versioned — any edit is revertable.\nOpen it: ${kbLink(data.section!, data.slug!)}`;
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

interface ArtifactLite { title: string; description?: string; folder?: string; kind: string; filename: string; bytes: number; createdAt: number }

async function artifactsList(args: Record<string, unknown>): Promise<string> {
  const u = new URL(AOS_URL + '/api/agent/artifacts');
  u.searchParams.set('session', SESSION);
  u.searchParams.set('limit', String(typeof args.limit === 'number' ? args.limit : 20));
  const res = await fetch(u, { headers: H() });
  const data = (await res.json()) as { artifacts?: ArtifactLite[]; folders?: string[]; enabled?: boolean };
  if (data.enabled === false) return 'The Library is disabled in this workspace.';
  const arts = data.artifacts ?? [];
  // The Library's existing folders (all agents) so a `publish` files into the established tree rather
  // than inventing a new folder. Shown even when you personally have nothing published yet.
  const folders = data.folders?.length ? `\n\nLibrary folders (pass one as \`folder\` to publish): ${data.folders.join(', ')}` : '';
  const browse = `\n\nBrowse the Library: ${consoleLink('artifacts')}`;
  if (!arts.length) return `You have not published any deliverables yet.${folders}${browse}`;
  return arts
    .map((a) => `- ${a.title}${a.description ? ` — ${a.description}` : ''} (${a.kind}, ${a.filename}${a.folder ? `, in ${a.folder}/` : ''})`)
    .join('\n') + folders + browse;
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
      resume: args.resume === undefined ? undefined : args.resume !== false,
    }),
  });
  const d = (await res.json()) as { ok?: boolean; id?: string; runAt?: number; resume?: boolean; error?: string };
  if (!d.ok) return `Could not schedule: ${d.error ?? 'unknown error'}`;
  const when = d.runAt ? new Date(d.runAt).toISOString() : 'the scheduled time';
  const how = d.resume ? 'resuming this conversation' : 'a fresh session';
  return `Scheduled (id ${d.id}) — will run it at ${when} (${how}). Cancel with unschedule "${d.id}".`;
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

async function stop(args: Record<string, unknown>): Promise<string> {
  const reason = String(args.reason ?? '').trim();
  const res = await fetch(AOS_URL + '/api/agent/stop', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, reason: reason || undefined }),
  });
  const d = (await res.json()) as { ok?: boolean; error?: string };
  if (!d.ok) return `Could not stop: ${d.error ?? 'unknown error'}`;
  // The server halts this session ~150ms after acking, so this line is the last thing the run does.
  return 'Ending this session now.';
}

// ── Tasks: the shared work queue ──────────────────────────────────────────────
interface TaskLite { id: string; title: string; status: string; priority: number; assignee?: string; labels?: string[]; body?: string; goalId?: string; criteria?: string; dependsOn?: string[] }
interface TaskEventLite { kind: string; body?: string; author: string; createdAt: number }
interface TaskAttachmentLite { id: string; filename: string; mime: string; bytes: number; uploadedBy: string }

/** Parse an agent-supplied `due` (ISO date/datetime) → epoch ms. '' / null → null (clear). undefined → undefined (leave). */
function parseDue(due: unknown): number | null | undefined {
  if (due === undefined) return undefined;
  if (due === null || (typeof due === 'string' && !due.trim())) return null;
  const ms = Date.parse(String(due));
  return Number.isFinite(ms) ? ms : undefined;
}

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
      goalId: args.goalId !== undefined ? String(args.goalId) : undefined,
      // `goal` is the ergonomic alias for `criteria` (the /goal convergence condition); either sets it.
      criteria: args.criteria !== undefined ? String(args.criteria) : (args.goal !== undefined ? String(args.goal) : undefined),
      dependsOn: Array.isArray(args.dependsOn) ? args.dependsOn.map(String) : undefined,
      // `wait` (block) and `poke_on_done` (async wake) both imply autoDispatch — you can't await/be-woken
      // by work that never starts.
      autoDispatch: args.autoDispatch === true || args.wait === true || args.poke_on_done === true,
      pokeOnDone: args.poke_on_done === true,
      mode: args.mode === 'interactive' ? 'interactive' : undefined,
      dueAt: parseDue(args.due),
    }),
  });
  const d = (await res.json()) as { ok?: boolean; id?: string; error?: string };
  if (!d.ok) return `Could not create the task: ${d.error ?? 'unknown error'}`;
  const who = args.assignee ? ` (assigned to ${String(args.assignee)})` : ' (open — anyone can claim it)';
  // wait:true → delegate synchronously: file it, then block until the delegate closes the loop.
  if (args.wait === true) {
    const outcome = await taskWait({ id: d.id, timeoutSeconds: args.timeoutSeconds });
    return `Filed task ${d.id}: "${title}"${who}.\n${outcome}`;
  }
  // poke_on_done → fire-and-forget async: don't poll or wait. End your turn; you'll be resumed with the
  // result the moment the delegate finishes (or blocks).
  if (args.poke_on_done === true) {
    return `Filed task ${d.id}: "${title}"${who}. You'll be woken with the result when it finishes — you can end your turn now; no need to poll.`;
  }
  return `Filed task ${d.id}: "${title}"${who}. Track it with task_get "${d.id}".`;
}

// Block until a handed-off task reaches a terminal state, driving its dispatch/retry via /api/tasks/wait.
// The caller's session stays alive on this pending tool call and resumes with the result — same shape as
// `ask`, but waiting on another agent's task rather than a human's answer.
async function taskWait(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id ?? '').trim();
  if (!id) return 'Which task? (id is required).';
  const requested = typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : undefined;
  // Interactive callers can afford a long block (a human can steer); unattended runs park sooner so a stuck
  // child can't strand them. An explicit timeoutSeconds always wins. Clamped to [10s, 6h].
  const ceilingS = UNATTENDED ? TASK_WAIT_S : Math.max(TASK_WAIT_S, 3600);
  const maxWaitS = Math.min(21600, Math.max(10, requested ?? ceilingS));
  const deadline = Date.now() + maxWaitS * 1000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const res = await fetch(AOS_URL + '/api/tasks/wait', {
      method: 'POST',
      headers: H({ 'content-type': 'application/json' }),
      body: JSON.stringify({ session: SESSION, id }),
    });
    const d = (await res.json()) as { ok?: boolean; error?: string; status?: string; terminal?: boolean; note?: string | null };
    if (!d.ok) return `Could not wait on task ${id}: ${d.error ?? 'unknown error'}`;
    lastStatus = d.status ?? lastStatus;
    // done/cancelled are terminal; blocked won't finish on its own, so stop waiting and surface it too.
    if (d.terminal || d.status === 'blocked') {
      const note = d.note ? ` — ${d.note}` : '';
      if (d.status === 'done') return `Task ${id} completed${note}. You can continue.`;
      if (d.status === 'cancelled') return `Task ${id} was cancelled${note}.`;
      return `Task ${id} is blocked and needs attention${note}. It won't finish on its own — read task_get "${id}" and decide how to proceed.`;
    }
    await sleep(3000);
  }
  const where = lastStatus ? ` (currently "${lastStatus}")` : '';
  return `Task ${id} hasn't finished within ${maxWaitS}s${where}. It's still running in the background — call task_wait or task_get "${id}" again to keep watching, or move on and check back later.`;
}

// ── Goals: read the strategic layer + propose a new one ───────────────────────
async function goalList(args: Record<string, unknown>): Promise<string> {
  const u = new URL(AOS_URL + '/api/goals/list');
  u.searchParams.set('session', SESSION);
  if (args.status) u.searchParams.set('status', String(args.status));
  if (args.query) u.searchParams.set('q', String(args.query));
  if (typeof args.limit === 'number') u.searchParams.set('limit', String(args.limit));
  const res = await fetch(u, { headers: H() });
  const data = (await res.json()) as { goals?: Array<{ id: string; title: string; status: string; target?: string }> };
  const goals = data.goals ?? [];
  if (!goals.length) return 'No goals match. If you see a direction worth making explicit, suggest one with goal_propose.';
  return goals
    .map((g) => `- [${g.status}] ${g.id} — ${g.title}${g.target ? ` (target: ${g.target})` : ''}`)
    .join('\n') + '\n(Use goal_get <id> for detail.)';
}

async function goalGet(args: Record<string, unknown>): Promise<string> {
  const u = new URL(AOS_URL + '/api/goals/get');
  u.searchParams.set('session', SESSION);
  u.searchParams.set('id', String(args.id ?? ''));
  const res = await fetch(u, { headers: H() });
  if (!res.ok) return 'Goal not found.';
  const d = (await res.json()) as {
    goal?: { id: string; title: string; body?: string; status: string; target?: string };
    events?: Array<{ kind: string; body?: string; author: string }>;
    tasks?: Array<{ id: string; title: string; status: string }>;
    progress?: { total: number; done: number; percent: number };
  };
  if (!d.goal) return 'Goal not found.';
  const g = d.goal;
  const timeline = (d.events ?? []).map((e) => `  · ${e.kind}${e.body ? `: ${e.body}` : ''} — ${e.author}`).join('\n');
  const p = d.progress;
  const progressLine = p && p.total ? `\nProgress: ${p.percent}% (${p.done}/${p.total} linked tasks done)` : '\nProgress: no tasks linked yet — link work with task_create/task_update({ goalId: "' + g.id + '" }).';
  const taskLines = (d.tasks ?? []).map((t) => `  · [${t.status}] ${t.id} — ${t.title}`).join('\n');
  const tasksSection = d.tasks?.length ? `\n\nLinked tasks:\n${taskLines}` : '';
  return `${g.id} · [${g.status}]${g.target ? ` · target: ${g.target}` : ''}${progressLine}\n# ${g.title}\n${g.body ?? ''}\n\nActivity:\n${timeline || '  (none)'}${tasksSection}`;
}

async function goalPropose(args: Record<string, unknown>): Promise<string> {
  const title = String(args.title ?? '').trim();
  if (!title) return 'A goal needs a title.';
  const res = await fetch(AOS_URL + '/api/goals/propose', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      session: SESSION, title,
      body: args.body !== undefined ? String(args.body) : undefined,
      target: args.target !== undefined ? String(args.target) : undefined,
      labels: Array.isArray(args.labels) ? args.labels.map(String) : undefined,
    }),
  });
  const d = (await res.json()) as { ok?: boolean; id?: string; error?: string };
  return d.ok
    ? `Proposed goal ${d.id}: "${title}" — it's a draft in the inbox for an owner/admin to review and activate. It won't steer the fleet until then.`
    : `Could not propose goal: ${d.error ?? 'unknown error'}`;
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
  return `Created agent "${d.id}". It's live in the console now (grouped under ${args.category ? String(args.category) : 'Uncategorized'}); a human can run or assign it, and refine it from its console page. (agent_update only edits your own listing, not other agents.)`;
}

async function agentUpdate(args: Record<string, unknown>): Promise<string> {
  // Self-only: an agent refines its OWN listing. Default the target to this session's agent; the server
  // rejects any other id. Every change is snapshotted (see agent_history / agent_revert) so it's reversible.
  const id = String(args.id ?? AGENT).trim().toLowerCase();
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
  const d = (await res.json()) as { ok?: boolean; id?: string; rev?: number | null; error?: string };
  if (!d.ok) return `Could not update the agent: ${d.error ?? 'unknown error'}`;
  return `Updated your listing "${id}"${d.rev ? ` (saved as rev ${d.rev} — revert with agent_revert)` : ''}. The next session you run will use it.`;
}

async function agentHistory(): Promise<string> {
  const res = await fetch(AOS_URL + '/api/agents/history', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION }),
  });
  const d = (await res.json()) as { ok?: boolean; revisions?: Array<{ rev: number; author: string; summary: string | null; createdAt: number; description: string; claudeChars: number }>; error?: string };
  if (!d.ok) return `Could not read history: ${d.error ?? 'unknown error'}`;
  if (!d.revisions?.length) return 'No revisions yet — your listing has not been edited.';
  return 'Your listing revisions (newest first):\n' + d.revisions
    .map((r) => `  rev ${r.rev} · ${new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ')} · ${r.author}${r.summary ? ` — ${r.summary}` : ''}`)
    .join('\n') + '\n\nUse agent_revert { rev } to roll back to one.';
}

async function agentRevert(args: Record<string, unknown>): Promise<string> {
  const rev = Number(args.rev);
  if (!Number.isInteger(rev) || rev < 1) return 'Which revision? Pass rev (a positive integer from agent_history).';
  const res = await fetch(AOS_URL + '/api/agents/revert', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, rev }),
  });
  const d = (await res.json()) as { ok?: boolean; toRev?: number; rev?: number | null; error?: string };
  if (!d.ok) return `Could not revert: ${d.error ?? 'unknown error'}`;
  return `Reverted your listing to rev ${d.toRev}${d.rev ? ` (recorded as rev ${d.rev})` : ''}. The next session you run will use it.`;
}

// ── Apps: build hosted apps (proposed → a human publishes) ────────────────────────────────────────
async function appCreate(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id ?? '').trim().toLowerCase();
  const name = String(args.name ?? '').trim();
  if (!id) return 'A new app needs an id (a DNS-safe slug, e.g. "mini-crm").';
  if (!name) return 'A new app needs a name.';
  const res = await fetch(AOS_URL + '/api/apps/create', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      session: SESSION, id, name,
      serverJs: args.serverJs !== undefined ? String(args.serverJs) : undefined,
      icon: args.icon !== undefined ? String(args.icon) : undefined,
      capabilities: args.capabilities,
    }),
  });
  const d = (await res.json()) as { ok?: boolean; id?: string; error?: string };
  if (!d.ok) return `Could not create the app: ${d.error ?? 'unknown error'}`;
  return `Built app "${name}" (\`${id}\`) — it's PROPOSED. An owner/admin can review its code + capabilities and publish it; once published it's live at /apps/${id}. Edit it with app_update.`;
}

async function appList(): Promise<string> {
  const res = await fetch(AOS_URL + `/api/apps/list?session=${encodeURIComponent(SESSION)}`, { headers: H() });
  const d = (await res.json()) as { ok?: boolean; apps?: Array<{ id: string; name: string; published: boolean; status: string; createdBy?: string }>; error?: string };
  if (!d.ok) return `Could not list apps: ${d.error ?? 'unknown error'}`;
  if (!d.apps?.length) return 'No hosted apps yet. Build one with app_create.';
  return 'Hosted apps:\n' + d.apps
    .map((a) => `  ${a.id} · ${a.name} · ${a.published ? `published (${a.status})` : 'proposed'}${a.createdBy ? ` · by ${a.createdBy}` : ''}`)
    .join('\n');
}

async function appUpdate(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id ?? '').trim().toLowerCase();
  if (!id) return 'Which app? Pass its id.';
  const body: Record<string, unknown> = { session: SESSION, id };
  for (const k of ['name', 'icon', 'lifecycle', 'serverJs'] as const) if (args[k] !== undefined) body[k] = String(args[k]);
  if (args.capabilities !== undefined) body.capabilities = args.capabilities;
  const res = await fetch(AOS_URL + '/api/apps/update', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const d = (await res.json()) as { ok?: boolean; id?: string; unpublished?: boolean; error?: string };
  if (!d.ok) return `Could not update the app: ${d.error ?? 'unknown error'}`;
  return `Updated app "${id}".${d.unpublished ? ' It was LIVE, so it was unpublished for re-review — an owner/admin re-publishes to push the change live.' : ''}`;
}

// ── Secrets vault: shared credential handoff (value stays out of every durable plane) ─────────────
async function secretPut(args: Record<string, unknown>): Promise<string> {
  const key = String(args.key ?? '').trim();
  const value = args.value != null ? String(args.value) : '';
  if (!key) return 'A secret needs a key (the handle other agents fetch by, e.g. PROD_DB_URL).';
  if (!value) return 'A secret needs a value to store.';
  const res = await fetch(AOS_URL + '/api/agent/secret/put', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, key, value, reasoning: args.reasoning != null ? String(args.reasoning) : undefined }),
  });
  const d = (await res.json()) as { status?: string; detail?: string; error?: string };
  if (d.error) return `Could not store the secret: ${d.error}`;
  if (d.status === 'stored') return `Stored secret "${key}" in the shared vault. Hand it off by NAME — tell the other agent to secret_get "${key}". Never paste the value into a message, memory, or report.`;
  if (d.status === 'denied') return `Storing "${key}" was not approved${d.detail ? `: ${d.detail}` : ''}.`;
  return `Could not store the secret${d.detail ? `: ${d.detail}` : ''}.`;
}

async function secretGet(args: Record<string, unknown>): Promise<string> {
  const key = String(args.key ?? '').trim();
  if (!key) return 'Which secret? Pass its key/handle, e.g. secret_get "PROD_DB_URL".';
  const res = await fetch(AOS_URL + '/api/agent/secret/get', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, key }),
  });
  const d = (await res.json()) as { status?: string; value?: string; detail?: string; error?: string };
  if (d.error) return `Could not read the secret: ${d.error}`;
  if (d.status === 'ok') return `${d.value}\n\n(Use this value directly — do not store or echo it into a memory, report, task, or the knowledge base.)`;
  if (d.status === 'denied') return `Reading "${key}" is not allowed${d.detail ? `: ${d.detail}` : ''}.`;
  return `No secret named "${key}" is in the vault. Check secret_list, or ask the agent/human who has it to secret_put it.`;
}

async function secretList(): Promise<string> {
  const u = new URL(AOS_URL + '/api/agent/secret/list');
  u.searchParams.set('session', SESSION);
  const res = await fetch(u, { headers: H() });
  const d = (await res.json()) as { secrets?: Array<{ key: string; updatedAt: number; updatedBy?: string }>; error?: string };
  if (d.error) return `Could not list secrets: ${d.error}`;
  const rows = d.secrets ?? [];
  if (!rows.length) return 'The shared vault has no secrets yet. Use secret_put to add one the team can share.';
  return 'Shared vault keys (metadata only — use secret_get to fetch a value):\n' +
    rows.map((s) => `• ${s.key}${s.updatedBy ? ` — set by ${s.updatedBy}` : ''}`).join('\n');
}

async function secretRequest(args: Record<string, unknown>): Promise<string> {
  const key = String(args.key ?? '').trim();
  if (!key) return 'secret_request needs the key name of the credential you need, e.g. secret_request({ key: "STRIPE_API_KEY" }).';
  const res = await fetch(AOS_URL + '/api/agent/secret/request', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, key, reasoning: args.reasoning != null ? String(args.reasoning) : undefined }),
  });
  const d = (await res.json()) as { ok?: boolean; status?: string; mode?: string; error?: string };
  if (!d.ok) return `Could not request the secret: ${d.error ?? 'unknown error'}`;
  if (d.status === 'exists') return `"${key}" is already in the vault and available to you — secret_get "${key}".`;
  if (d.status === 'duplicate') return `A request for "${key}" is already awaiting review.`;
  if (d.mode === 'access') return `Requested ACCESS to "${key}" — it's already in the vault but scoped away from you. An owner/admin will grant you access (the existing value is re-scoped to you; no one re-types it). Once granted, secret_get "${key}", or it'll be a shell env var on your next session if they inject it.`;
  return `Requested "${key}" — an owner/admin will provide it into the vault (they type the value, you never see it pasted here). Once fulfilled, secret_get "${key}", or it'll be a shell env var on your next session if they inject it.`;
}

// ── Per-member GitHub token refresh: recover a live run whose ~8h GH_TOKEN went bad mid-flight ──────
async function githubRefresh(): Promise<string> {
  const res = await fetch(AOS_URL + '/api/agent/github/refresh', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION }),
  });
  const d = (await res.json()) as { status?: string; token?: string; login?: string; refreshed?: boolean; detail?: string; error?: string };
  if (d.error) return `Could not refresh the GitHub token: ${d.error}`;
  switch (d.status) {
    case 'ok':
      // The env var can't be mutated from outside this process, so hand the new token back for the agent
      // to re-export. The git credential helper + gh both read $GH_TOKEN at call time.
      return (
        `${d.refreshed ? 'Refreshed' : 'Current'} GitHub token for ${d.login ?? 'you'} is ready. Run this in your shell, then retry your git/gh command:\n\n` +
        `export GH_TOKEN=${d.token} GITHUB_TOKEN=${d.token}\n\n` +
        '(This is your own identity — do not store or echo it into a memory, report, task, or the knowledge base.)'
      );
    case 'no_member':
      return 'This run has no linked GitHub identity to refresh — it acts under the company/bot credential. If git/gh is failing, ask a human to check the bot token in Settings → Integrations.';
    case 'not_connected':
      return 'You (the human you run as) have not linked a GitHub account, so there is no token to refresh. Ask them to connect GitHub in Settings, then retry.';
    case 'no_refresh_token':
      return 'Your GitHub token expired and cannot be auto-refreshed — no refresh token is stored (the GitHub App likely does not issue them). The human you run as must RE-LINK GitHub in Settings. Stop retrying git/gh until they do.';
    case 'not_configured':
      return 'GitHub is not configured for this workspace (no OAuth client id/secret), so the token cannot be refreshed. Ask an admin to set it up in Settings → Integrations.';
    case 'failed':
      return `The GitHub refresh was rejected${d.detail ? `: ${d.detail}` : ''}. The token may have been revoked — the human you run as should re-link GitHub in Settings. Stop retrying until they do.`;
    default:
      return `Could not refresh the GitHub token${d.detail ? `: ${d.detail}` : ''}.`;
  }
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
  const d = (await res.json()) as { task?: TaskLite; events?: TaskEventLite[]; attachments?: TaskAttachmentLite[]; dependents?: string[] };
  if (!d.task) return 'Task not found.';
  const t = d.task;
  const timeline = (d.events ?? [])
    .map((e) => `  · ${e.kind}${e.body ? `: ${e.body}` : ''} — ${e.author}`)
    .join('\n');
  const files = (d.attachments ?? [])
    .map((a) => `  · ${a.filename} (${a.mime}, ${a.bytes} bytes) — ${a.uploadedBy}`)
    .join('\n');
  const attachSection = d.attachments?.length ? `\n\nAttachments:\n${files}` : '';
  // Dependencies: what this task waits on (it won't dispatch until they're done) and what it unblocks.
  const depLines: string[] = [];
  if (t.dependsOn?.length) depLines.push(`Depends on (won't run until these finish): ${t.dependsOn.join(', ')}`);
  if (d.dependents?.length) depLines.push(`Blocks (waiting on this): ${d.dependents.join(', ')}`);
  const depSection = depLines.length ? `\n${depLines.join('\n')}` : '';
  return `${t.id} · [${t.status}] · P${t.priority}${t.assignee ? ` · ${t.assignee}` : ''}${depSection}\n# ${t.title}\n${t.body ?? ''}\n\nActivity:\n${timeline || '  (none)'}${attachSection}`;
}

async function taskAttach(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id ?? '').trim();
  const filePath = String(args.path ?? '').trim();
  if (!id || !filePath) return 'Both id and path are required.';
  const res = await fetch(AOS_URL + '/api/tasks/attach', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, id, path: filePath }),
  });
  const d = (await res.json()) as { ok?: boolean; filename?: string; error?: string };
  if (!d.ok) return `Could not attach: ${d.error ?? 'unknown error'}`;
  return `Attached ${d.filename} to task ${id}. It's now visible on the task (task_get "${id}").`;
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
      goalId: args.goalId === null ? null : (args.goalId !== undefined ? String(args.goalId) : undefined),
      criteria: args.criteria === null ? null : (args.criteria !== undefined ? String(args.criteria) : undefined),
      dependsOn: Array.isArray(args.dependsOn) ? args.dependsOn.map(String) : undefined,
      dueAt: parseDue(args.due),
    }),
  });
  const d = (await res.json()) as { ok?: boolean; task?: TaskLite; error?: string };
  if (!d.ok || !d.task) return `Could not update: ${d.error ?? 'unknown error'}`;
  return `Updated ${d.task.id} → [${d.task.status}].`;
}

async function taskDispatch(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id ?? '').trim();
  if (!id) return 'Which task? (id is required).';
  const res = await fetch(AOS_URL + '/api/tasks/dispatch', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ session: SESSION, id }),
  });
  const d = (await res.json()) as { ok?: boolean; sessionId?: string; error?: string };
  if (!d.ok) return `Could not dispatch task ${id}: ${d.error ?? 'unknown error'}.`;
  return `Dispatched task ${id} — a session is now working it. Track progress with task_get "${id}".`;
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

async function listAgents(): Promise<string> {
  const u = new URL(AOS_URL + '/api/agent/roster');
  u.searchParams.set('session', SESSION);
  const res = await fetch(u, { headers: H() });
  const data = (await res.json()) as { agents?: Array<{ id: string; description: string; category?: string }>; error?: string };
  if (data.error) return `Could not list agents: ${data.error}`;
  const agents = data.agents ?? [];
  if (!agents.length) return 'No other agents are available to delegate to.';
  return (
    'Fleet roster — delegate with task_create({ assignee: "agent:<id>", autoDispatch: true }):\n' +
    agents.map((a) => `- agent:${a.id}${a.category ? ` (${a.category})` : ''} — ${a.description}`).join('\n')
  );
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
    send({ jsonrpc: '2.0', id, result: { tools: [
      ...TOOLS,
      ...(SLACK_REPLY ? [SLACK_REPLY_TOOL] : []),
      ...(DISCORD_REPLY ? [DISCORD_REPLY_TOOL] : []),
      ...(ASK_ANSWER ? [ANSWER_TOOL] : []),
      ...(SLACK_EGRESS ? [SLACK_SEND_TOOL, SLACK_DM_TOOL] : []),
      ...(DISCORD_EGRESS ? [DISCORD_SEND_TOOL, DISCORD_DM_TOOL] : []),
      ...(IMAGE_GEN ? [IMAGE_GENERATE_TOOL, IMAGE_EDIT_TOOL] : []),
      ...(VIDEO_GEN ? [VIDEO_GENERATE_TOOL] : []),
      ...(VIDEO_UNDERSTAND ? [VIDEO_UNDERSTAND_TOOL] : []),
    ] } });
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
        : name === 'ask_human' || name === 'ask' ? await ask(args)
        : name === 'ask_agent' ? await askAgent(args)
        : name === 'answer' ? await answer(args)
        : name === 'report' ? await report(args)
        : name === 'update' ? await update(args)
        : name === 'notify' ? await notify(args)
        : name === 'publish' ? await publish(args)
        : name === 'skill_propose' ? await skillPropose(args)
        : name === 'host_propose' ? await hostPropose(args)
        : name === 'skill_find' ? await skillFind(args)
        : name === 'skill_request' ? await skillRequest(args)
        : name === 'slack_reply' ? await slackReply(args)
        : name === 'discord_reply' ? await discordReply(args)
        : name === 'slack_send' ? await slackSend(args)
        : name === 'slack_dm' ? await slackDm(args)
        : name === 'discord_send' ? await discordSend(args)
        : name === 'discord_dm' ? await discordDm(args)
        : name === 'image_generate' ? await imageGenerate(args)
        : name === 'image_edit' ? await imageEdit(args)
        : name === 'video_generate' ? await videoGenerate(args)
        : name === 'video_understand' ? await videoUnderstand(args)
        : name === 'list_capabilities' ? await listCapabilities()
        : name === 'policy_check' ? await policyCheck(args)
        : name === 'directory_lookup' ? await directoryLookup(args)
        : name === 'list_agents' ? await listAgents()
        : name === 'check_inbox' ? await checkInbox(args)
        : name === 'library_list' ? await artifactsList(args)
        : name === 'schedule' ? await schedule(args)
        : name === 'unschedule' ? await unschedule(args)
        : name === 'stop' ? await stop(args)
        : name === 'task_create' ? await taskCreate(args)
        : name === 'task_list' ? await taskList(args)
        : name === 'task_get' ? await taskGet(args)
        : name === 'task_claim' ? await taskClaim(args)
        : name === 'task_update' ? await taskUpdate(args)
        : name === 'task_wait' ? await taskWait(args)
        : name === 'task_attach' ? await taskAttach(args)
        : name === 'task_dispatch' ? await taskDispatch(args)
        : name === 'goal_list' ? await goalList(args)
        : name === 'goal_get' ? await goalGet(args)
        : name === 'goal_propose' ? await goalPropose(args)
        : name === 'agent_create' ? await agentCreate(args)
        : name === 'agent_update' ? await agentUpdate(args)
        : name === 'agent_history' ? await agentHistory()
        : name === 'agent_revert' ? await agentRevert(args)
        : name === 'app_create' ? await appCreate(args)
        : name === 'app_list' ? await appList()
        : name === 'app_update' ? await appUpdate(args)
        : name === 'secret_put' ? await secretPut(args)
        : name === 'secret_get' ? await secretGet(args)
        : name === 'secret_list' ? await secretList()
        : name === 'secret_request' ? await secretRequest(args)
        : name === 'github_refresh' ? await githubRefresh()
        : `unknown tool: ${name}`;
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (e) {
      // Name the tool that actually failed — not every tool is "memory" (an image/video generation network
      // error was reporting itself as a memory failure, sending the agent to the wrong subsystem).
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `${name ?? 'tool'} error: ${e instanceof Error ? e.message : String(e)}` }], isError: true } });
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
