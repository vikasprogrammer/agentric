/**
 * The per-workspace database. One SQLite file per data home (`<home>/agent-os.db`), opened
 * through Node's built-in `node:sqlite` — so the OS keeps its zero-dependency stance while
 * gaining real, queryable, restart-surviving storage for everything the live console touches:
 * the team & login tables, agent assignments, connectors, terminal sessions, the inbox feed,
 * approvals, and an audit mirror.
 *
 * The DB is per home (like the tmux socket and audit dir) so multiple instances never collide.
 * It is the single connection the stores share; each store owns its own tables.
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';

export type Db = DatabaseSync;

/** Open (creating if needed) the workspace DB at `file` and run idempotent migrations. */
export function openDb(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

/** All tables, created if absent. Adding a column later = a new `ALTER TABLE … IF NOT…` here. */
function migrate(db: Db): void {
  db.exec(`
    -- People with access to this workspace.
    CREATE TABLE IF NOT EXISTS members (
      id         TEXT PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      name       TEXT NOT NULL,
      role       TEXT NOT NULL,           -- owner | admin | member
      status     TEXT NOT NULL,           -- invited | active
      created_at INTEGER NOT NULL
    );

    -- One-time magic-link tokens (invite a new member OR re-auth an existing one).
    CREATE TABLE IF NOT EXISTS invites (
      token       TEXT PRIMARY KEY,
      email       TEXT NOT NULL,
      role        TEXT NOT NULL,
      invited_by  TEXT,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      accepted_at INTEGER
    );

    -- Login sessions (the aos_sid cookie). Distinct from terminal/tmux sessions below.
    CREATE TABLE IF NOT EXISTS auth_sessions (
      sid        TEXT PRIMARY KEY,
      member_id  TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    -- Which roles / members may run a given agent. JSON-text arrays.
    CREATE TABLE IF NOT EXISTS assignments (
      agent_id        TEXT PRIMARY KEY,
      allowed_roles   TEXT NOT NULL,      -- JSON string[]
      allowed_members TEXT NOT NULL       -- JSON string[] (member ids)
    );

    -- The identity map: external accounts (Slack/Discord/email/github) a member is known by. This is
    -- the join key a chat trigger uses to run AS the right person. PRIMARY KEY (provider, external_id)
    -- guarantees one external id resolves to at most ONE member, so run-as is never ambiguous. Cleaned
    -- up when the member is removed (TeamStore.removeMember).
    CREATE TABLE IF NOT EXISTS member_identities (
      provider    TEXT NOT NULL,          -- slack | discord | email | github
      external_id TEXT NOT NULL,          -- the provider-side id/handle
      member_id   TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      created_by  TEXT,
      PRIMARY KEY (provider, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_member_identities_member ON member_identities (member_id);

    -- User-registered MCP connectors (Slack / GitHub / Composio / …) + the credentials they carry.
    -- stdio connectors use command/args/env; remote (http|sse) connectors use url/headers.
    CREATE TABLE IF NOT EXISTS connectors (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      label       TEXT NOT NULL,
      description TEXT NOT NULL,
      transport   TEXT NOT NULL DEFAULT 'stdio',  -- stdio | http | sse
      command     TEXT NOT NULL,
      args        TEXT NOT NULL,          -- JSON string[]
      url         TEXT NOT NULL DEFAULT '',       -- remote: MCP endpoint URL
      headers     TEXT NOT NULL DEFAULT '{}',     -- remote: JSON Record<string,string> (auth headers)
      env         TEXT NOT NULL,          -- JSON Record<string,string>
      enabled     INTEGER NOT NULL,       -- 0 | 1
      scope       TEXT NOT NULL DEFAULT 'org',    -- org (company-wide) | personal (one member's own)
      owner_member_id TEXT,               -- the owning member (personal scope only; NULL for org)
      created_at  INTEGER NOT NULL
    );

    -- Host connections — reachable destinations (SSH box / internal HTTP / DB) an agent may talk to,
    -- as a first-class governed thing (docs/host-connections-plan.md). Phase 2a stores them; the
    -- governance that reads them (net.connect/ssh.exec + allow-list) is Phase 2b. Mirrors connectors'
    -- org/personal/shared ownership. Column is "pattern" (match is a SQLite keyword) = destination matcher.
    CREATE TABLE IF NOT EXISTS hosts (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      pattern     TEXT NOT NULL,                 -- hostname glob | CIDR | host[:port]
      protocol    TEXT NOT NULL DEFAULT 'any',   -- ssh | http | postgres | any
      credential  TEXT NOT NULL DEFAULT '',      -- vault ref (secret:KEY); injected at launch in Phase 2c
      posture     TEXT NOT NULL DEFAULT 'ask',   -- allow | ask | never (default tier for reaching this host)
      enabled     INTEGER NOT NULL DEFAULT 1,    -- 0 | 1
      scope       TEXT NOT NULL DEFAULT 'org',   -- org (company-wide) | personal (one member's own)
      owner_member_id TEXT,                      -- the owning member (personal scope only; NULL for org)
      shared      INTEGER NOT NULL DEFAULT 0,    -- a personal host shared with the whole team
      proposed    INTEGER NOT NULL DEFAULT 0,    -- proposed by an agent (host_propose), inactive until an owner/admin publishes
      proposed_by TEXT,                          -- the proposing agent (agent:<id>)
      proposed_reason TEXT,                      -- the agent's stated reason (shown on the review card)
      created_at  INTEGER NOT NULL
    );

    -- Terminal-native agent sessions (each a tmux shell).
    CREATE TABLE IF NOT EXISTS term_sessions (
      id         TEXT PRIMARY KEY,
      agent      TEXT NOT NULL,
      title      TEXT NOT NULL,
      task       TEXT NOT NULL,
      tmux       TEXT NOT NULL,
      status     TEXT NOT NULL,           -- running | done | stopped | crashed
      spawned_by TEXT,                    -- member id
      secret     TEXT,                    -- per-session bearer for the loopback agent endpoints (0d)
      created_at INTEGER NOT NULL
    );

    -- The inbox feed: tasks · updates · approvals.
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,          -- task | update | approval
      session_id  TEXT NOT NULL,
      agent       TEXT NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      status      TEXT NOT NULL,          -- open | pending | approved | rejected
      approval_id TEXT,
      capability  TEXT,
      args        TEXT,                   -- JSON
      level       TEXT,                   -- head | owner
      created_at  INTEGER NOT NULL
    );

    -- Agent→human questions (the ask-human channel). Like approvals, the blocking promise is an
    -- in-memory waiter; status/answer derive from this row so the inbox self-heals across restarts.
    CREATE TABLE IF NOT EXISTS questions (
      id          TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL,           -- session id
      tenant      TEXT NOT NULL,
      agent       TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      status      TEXT NOT NULL,           -- pending | answered
      answer      TEXT,
      answered_by TEXT,
      created_at  INTEGER NOT NULL,
      answered_at INTEGER
    );

    -- Agent-to-agent questions (the ask-agent channel): a live agent delegates a question/task to another
    -- agent and blocks on the answer — the machine-facing sibling of the questions table. The delegate runs
    -- as a one-off governed session (delegate_run_id) that answers via the answer tool; the caller polls this
    -- row. No board/inbox surface — it's an ephemeral request/response, not a durable task.
    CREATE TABLE IF NOT EXISTS agent_asks (
      id              TEXT PRIMARY KEY,
      tenant          TEXT NOT NULL,
      caller_run_id   TEXT NOT NULL,          -- the asking agent's session id
      caller_agent    TEXT NOT NULL,
      target_agent    TEXT NOT NULL,          -- the agent asked
      question        TEXT NOT NULL,
      status          TEXT NOT NULL,          -- pending | answered | failed
      answer          TEXT,
      delegate_run_id TEXT,                   -- the spawned delegate session that answers
      run_as          TEXT,                   -- accountable human (run-as passthrough), NULL = company
      created_at      INTEGER NOT NULL,
      answered_at     INTEGER
    );

    -- Approval requests routed by policy and resolved by an owner/admin.
    CREATE TABLE IF NOT EXISTS approvals (
      id          TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL,
      tenant      TEXT NOT NULL,
      level       TEXT NOT NULL,          -- head | owner
      capability  TEXT NOT NULL,
      args        TEXT NOT NULL,          -- JSON
      reasoning   TEXT,
      reason      TEXT NOT NULL,
      status      TEXT NOT NULL,          -- pending | approved | rejected
      resolved_by TEXT,
      created_at  INTEGER NOT NULL
    );

    -- Automations: triggers that auto-invoke agent sessions (cron schedule or inbound webhook).
    CREATE TABLE IF NOT EXISTS automations (
      id              TEXT PRIMARY KEY,
      agent_id        TEXT NOT NULL,
      name            TEXT NOT NULL,
      type            TEXT NOT NULL,      -- cron | webhook | composio | slack
      schedule        TEXT,               -- 5-field cron expression (cron type)
      secret          TEXT,               -- shared key for /hooks/<id> (webhook type)
      task            TEXT NOT NULL,      -- task template for the spawned session
      enabled         INTEGER NOT NULL,   -- 0 | 1
      mode            TEXT NOT NULL DEFAULT 'interactive',  -- interactive | headless
      created_by      TEXT,               -- member id
      created_at      INTEGER NOT NULL,
      last_fired_at   INTEGER,
      last_session_id TEXT
    );

    -- Native Slack egress binding: the channel/thread a Slack-triggered session should reply into.
    -- Written when a slack automation spawns a session; read by the agentos slack_reply tool so the
    -- agent posts back to the SAME thread without ever being handed (or able to spoof) a channel id.
    CREATE TABLE IF NOT EXISTS slack_threads (
      session_id TEXT PRIMARY KEY,
      channel    TEXT NOT NULL,
      thread_ts  TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- Native Discord egress binding (the analogue of slack_threads): the channel + message a
    -- Discord-triggered session should reply into. Written when a discord automation spawns a session;
    -- read by the agentos discord_reply tool so the agent posts back to the SAME channel as a reply to
    -- the triggering message, without ever being handed (or able to spoof) a channel id.
    CREATE TABLE IF NOT EXISTS discord_threads (
      session_id TEXT PRIMARY KEY,
      channel    TEXT NOT NULL,
      message_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- Binds an ask_human question to the Slack/Discord DM we sent about it, so the human can answer by
    -- REPLYING in that DM (not just via the web Inbox). Written when the question is DM'd (one row per
    -- provider we notified); read on an inbound DM: the sender's external id → the newest still-pending
    -- bound question, which we then answer. Keyed (question_id, provider); a question drops out of the
    -- match once it's no longer pending (join on questions.status), so no cleanup is needed.
    CREATE TABLE IF NOT EXISTS question_dms (
      question_id TEXT NOT NULL,
      tenant      TEXT NOT NULL,
      provider    TEXT NOT NULL,          -- 'slack' | 'discord'
      external_id TEXT NOT NULL,          -- the recipient's Slack/Discord user id (the DM sender on reply)
      member_id   TEXT,                   -- the member we DM'd (for the answered-by attribution)
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (question_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_question_dms_lookup ON question_dms (provider, external_id, created_at);

    -- The deliverables gallery: artifacts agents explicitly publish (a PDF/Markdown/image now;
    -- a multi-file site/app later). Each row is a snapshot copied into <home>/artifacts/<id>/.
    -- Carries full provenance (session + agent + source) — the SAME shape as the messages table, so
    -- the inbox per-member visibility rule (canViewSpawn) scopes the gallery with no new logic.
    CREATE TABLE IF NOT EXISTS artifacts (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,           -- which run produced it
      agent       TEXT NOT NULL,           -- which agent
      source      TEXT,                    -- member id | automation:<id> (the session's spawned_by)
      kind        TEXT NOT NULL,           -- 'file' now; 'site'/'app' later (multi-file/interactive)
      title       TEXT NOT NULL,
      description TEXT,
      filename    TEXT NOT NULL,           -- original basename / entry file (e.g. index.html)
      rel_path    TEXT NOT NULL,           -- path under <home>/artifacts/ (<id>/<filename>)
      mime        TEXT NOT NULL,
      bytes       INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at);

    -- In-flight video renders. Video generation is ASYNC (renders take minutes), so a request can't
    -- always complete inside one call: we persist the vendor job here so a background poller (the
    -- Automations tick) can finish it — surviving the initial poll cap AND a server restart. On
    -- completion the bytes are ingested into artifacts (kind=video) and artifact_id is set.
    -- provider_ref is an OPAQUE JSON handle (request id + poll url, etc.) so the row is vendor-neutral.
    CREATE TABLE IF NOT EXISTS video_jobs (
      id           TEXT PRIMARY KEY,        -- our job id
      session_id   TEXT NOT NULL,           -- run that requested it
      agent        TEXT NOT NULL,
      source       TEXT,                    -- run_as | automation:<id> (gallery + inbox provenance)
      backend      TEXT NOT NULL,           -- 'fal' | 'atlas' | 'replicate'
      model        TEXT NOT NULL,
      prompt       TEXT NOT NULL,
      provider_ref TEXT NOT NULL,           -- opaque JSON handle the adapter uses to poll
      status       TEXT NOT NULL,           -- 'rendering' | 'done' | 'failed' | 'expired'
      cost_usd     REAL,                    -- estimate until known; actual on completion
      artifact_id  TEXT,                    -- set once the finished video is ingested
      error        TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0,  -- poll attempts (bounds the poller)
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL         -- give up (mark 'expired') after this hard cap
    );
    CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs(status);

    -- A queryable mirror of the audit event stream (JSONL remains the durable system of record).
    CREATE TABLE IF NOT EXISTS audit_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        INTEGER NOT NULL,
      run_id    TEXT NOT NULL,
      tenant    TEXT NOT NULL,
      type      TEXT NOT NULL,
      principal TEXT,
      data      TEXT NOT NULL             -- JSON
    );
    CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_events(run_id);

    -- Workspace-wide settings (key→value). Holds the Company context injected into every
    -- claude-code agent, and a home for future instance-level config.
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );

    -- The secrets vault — credentials encrypted at rest (AES-256-GCM; see src/edge/secret-crypto.ts).
    -- Namespaced by (tenant, principal, key); principal '*' = tenant-wide. Values are NEVER stored or
    -- returned in plaintext; value_enc is base64(iv ‖ tag ‖ ciphertext) under the workspace master key.
    CREATE TABLE IF NOT EXISTS secrets (
      tenant     TEXT NOT NULL,
      principal  TEXT NOT NULL,            -- agent/member principal, or '*' for tenant-wide
      key        TEXT NOT NULL,
      value_enc  TEXT NOT NULL,            -- base64(iv ‖ tag ‖ ciphertext)
      updated_at INTEGER NOT NULL,
      updated_by TEXT,                     -- the member email that set it
      PRIMARY KEY (tenant, principal, key)
    );

    -- Which agents a stored secret is INJECTED into (as a shell env var named after its key) at launch.
    -- The inverse view of an agent's manifest shellSecrets, managed from the Secrets page: assigning
    -- agent X to a secret makes the OS resolve the secret's value and export it into X's session shell,
    -- so a plain CLI authenticates without X's manifest listing it. owner is the secret's principal
    -- ((owner,key) -> which value to inject; '*' for a tenant-wide secret). No read-access change: this
    -- drives injection only, never secret_get. Rows for a since-deleted agent are harmless (never
    -- match a launch); cleaned up when the secret itself is deleted.
    CREATE TABLE IF NOT EXISTS secret_assignments (
      tenant TEXT NOT NULL,
      owner  TEXT NOT NULL,                 -- the secret's principal (its canonical location), '*' = tenant-wide
      key    TEXT NOT NULL,
      agent  TEXT NOT NULL,                 -- the agent id the secret is injected into at launch
      PRIMARY KEY (tenant, owner, key, agent)
    );

    -- Persistent agent memory (the SQLite backend of the memory plane). One row per memory,
    -- namespaced by (tenant, agent_id) so an agent only ever recalls its own.
    CREATE TABLE IF NOT EXISTS memories (
      id         TEXT PRIMARY KEY,
      tenant     TEXT NOT NULL,
      agent_id   TEXT NOT NULL,          -- the AUTHOR (provenance), even for shared rows
      content    TEXT NOT NULL,
      tags       TEXT NOT NULL,          -- JSON string[]
      type       TEXT,
      importance REAL,
      metadata   TEXT,                   -- JSON
      created_at INTEGER NOT NULL,
      scope      TEXT NOT NULL DEFAULT 'agent'  -- 'agent' (private to agent_id) | 'tenant' (shared tenant-wide)
    );
    CREATE INDEX IF NOT EXISTS idx_mem_agent ON memories(tenant, agent_id, created_at);

    -- Full-text index over content+tags for ranked (bm25) recall. External-content FTS5:
    -- the virtual table holds only the index; triggers keep it in sync with the memories table.
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, tags, content='memories', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
      INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
    END;

    -- Knowledge base: the shared, tenant-wide, LIVING wiki (vs. memory's private per-agent state).
    -- One row per current page; the body also lives on disk at rel_path. Edits are non-destructive —
    -- every version is snapshotted into kb_revisions, so any change is auditable + revertable.
    CREATE TABLE IF NOT EXISTS kb_pages (
      id         TEXT PRIMARY KEY,
      tenant     TEXT NOT NULL,
      section    TEXT NOT NULL,            -- flat folder namespace, e.g. 'engineering'
      slug       TEXT NOT NULL,            -- url-safe; unique within (tenant, section)
      title      TEXT NOT NULL,
      tags       TEXT NOT NULL,            -- JSON string[]
      body       TEXT NOT NULL,            -- current markdown (mirror of the .md file for FTS + speed)
      rel_path   TEXT NOT NULL,            -- kb/<section>/<slug>.md
      rev        INTEGER NOT NULL,         -- current revision number (starts at 1)
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL,            -- member id | agent:<id> | automation:<id>
      read_count INTEGER NOT NULL DEFAULT 0, -- times an agent has fetched the page (auto-archive signal)
      last_read_at INTEGER                 -- when an agent last fetched it (epoch ms); NULL = never
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_slug ON kb_pages(tenant, section, slug);

    -- Every prior version of a page. Append-only — the rollback + audit backbone.
    CREATE TABLE IF NOT EXISTS kb_revisions (
      id         TEXT PRIMARY KEY,
      page_id    TEXT NOT NULL,
      rev        INTEGER NOT NULL,
      title      TEXT NOT NULL,
      tags       TEXT NOT NULL,
      body       TEXT NOT NULL,            -- full snapshot (pages are small; cheap + simple)
      summary    TEXT,                     -- one-line "what changed" from the writer
      author     TEXT NOT NULL,            -- member id | agent:<id> | automation:<id>
      created_at INTEGER NOT NULL,
      UNIQUE(page_id, rev)
    );
    CREATE INDEX IF NOT EXISTS idx_kb_rev_page ON kb_revisions(page_id, rev);

    -- Agent config revision history: every prior version of an agent's "listing" (description, starter
    -- prompts, CLAUDE.md system prompt, tuning). Append-only full snapshots — the rollback + audit
    -- backbone that makes a self-editing agent safe (safety = reversibility, like the KB above).
    CREATE TABLE IF NOT EXISTS agent_revisions (
      id              TEXT PRIMARY KEY,
      tenant          TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      rev             INTEGER NOT NULL,
      description     TEXT NOT NULL,
      category        TEXT,
      icon            TEXT,
      model           TEXT,
      effort          TEXT,
      permission_mode TEXT,
      example_prompts TEXT NOT NULL,          -- JSON string[]
      shell_secrets   TEXT NOT NULL,          -- JSON string[]
      claude_md       TEXT NOT NULL,          -- full CLAUDE.md snapshot
      summary         TEXT,                   -- one-line "what changed"
      author          TEXT NOT NULL,          -- member email | agent:<id> | system
      created_at      INTEGER NOT NULL,
      UNIQUE(agent_id, rev)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_rev ON agent_revisions(agent_id, rev);

    -- FTS5 over title+tags+body for ranked search (mirrors memories_fts).
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
      title, tags, body, content='kb_pages', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS kb_ai AFTER INSERT ON kb_pages BEGIN
      INSERT INTO kb_fts(rowid, title, tags, body) VALUES (new.rowid, new.title, new.tags, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS kb_ad AFTER DELETE ON kb_pages BEGIN
      INSERT INTO kb_fts(kb_fts, rowid, title, tags, body) VALUES('delete', old.rowid, old.title, old.tags, old.body);
    END;
    -- Scoped to content columns: a read_count/last_read_at bump on fetch must NOT re-tokenize the page.
    CREATE TRIGGER IF NOT EXISTS kb_au AFTER UPDATE OF title, tags, body ON kb_pages BEGIN
      INSERT INTO kb_fts(kb_fts, rowid, title, tags, body) VALUES('delete', old.rowid, old.title, old.tags, old.body);
      INSERT INTO kb_fts(rowid, title, tags, body) VALUES (new.rowid, new.title, new.tags, new.body);
    END;

    -- Tasks: the shared, tenant-wide, durable UNIT OF WORK — the noun between "a trigger fired" and
    -- "a session ran". Humans + agents co-own one board; a task with an agent assignee + auto_dispatch
    -- spawns a governed session that works it to completion. State is structured (status machine +
    -- activity log), so — unlike KB — there's no on-disk markdown mirror; the DB is the record.
    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,               -- short uuid (8)
      tenant        TEXT NOT NULL,
      title         TEXT NOT NULL,
      body          TEXT NOT NULL DEFAULT '',       -- markdown description / acceptance criteria
      status        TEXT NOT NULL DEFAULT 'todo',   -- todo | doing | blocked | done | cancelled
      priority      INTEGER NOT NULL DEFAULT 2,     -- 0 urgent … 3 low (sort key)
      labels        TEXT NOT NULL DEFAULT '[]',     -- JSON string[]
      assignee      TEXT,                           -- NULL (unassigned) | member id | 'agent:<id>'
      owner         TEXT,                           -- member id the dispatched session runs AS (run_as); NULL = company
      parent_id     TEXT,                           -- sub-task parent (nullable)
      mode          TEXT NOT NULL DEFAULT 'headless',-- how a dispatched session runs: headless | interactive
      auto_dispatch INTEGER NOT NULL DEFAULT 0,     -- 1 = the tick may spawn a session for it
      due_at        INTEGER,                        -- optional soft deadline (epoch ms)
      attempts      INTEGER NOT NULL DEFAULT 0,     -- dispatch attempts (backoff / give-up guard)
      last_session_id TEXT,                         -- the session currently/last working it (pile-up guard)
      created_by    TEXT NOT NULL,                  -- member id | 'agent:<id>'
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      updated_by    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(tenant, status, priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(tenant, assignee);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

    -- Append-only activity log: comments, status changes, claims, dispatches, links. The Tasks analog
    -- of kb_revisions — a timeline, not full snapshots. This is the reversibility/audit backbone.
    CREATE TABLE IF NOT EXISTS task_events (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL,
      kind       TEXT NOT NULL,                     -- comment | status | claim | dispatch | assign | link
      body       TEXT,                              -- note text, or "todo→doing", or "task:<child>"
      author     TEXT NOT NULL,                     -- member id | 'agent:<id>' | 'automation:<id>' | 'system'
      session_id TEXT,                              -- the run that produced this event, when applicable
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_events ON task_events(task_id, created_at);

    -- FTS5 over title+body+labels for board search (mirrors kb_fts exactly).
    CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
      title, body, labels, content='tasks', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
      INSERT INTO tasks_fts(rowid, title, body, labels) VALUES (new.rowid, new.title, new.body, new.labels);
    END;
    CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
      INSERT INTO tasks_fts(tasks_fts, rowid, title, body, labels) VALUES('delete', old.rowid, old.title, old.body, old.labels);
    END;
    CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
      INSERT INTO tasks_fts(tasks_fts, rowid, title, body, labels) VALUES('delete', old.rowid, old.title, old.body, old.labels);
      INSERT INTO tasks_fts(rowid, title, body, labels) VALUES (new.rowid, new.title, new.body, new.labels);
    END;

    -- Files attached to a task (humans upload from the console; agents snapshot from their working
    -- folder via task_attach). Each row is a file copied into <home>/task-attachments/<task_id>/<id>-
    -- <filename> — same on-disk snapshot model as artifacts, keyed to the task instead of a session.
    CREATE TABLE IF NOT EXISTS task_attachments (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL,
      tenant      TEXT NOT NULL,
      filename    TEXT NOT NULL,           -- original basename (display + download name)
      rel_path    TEXT NOT NULL,           -- path under <home>/task-attachments/ (<task_id>/<id>-<filename>)
      mime        TEXT NOT NULL,
      bytes       INTEGER NOT NULL,
      uploaded_by TEXT NOT NULL,           -- member id | 'agent:<id>'
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_attachments ON task_attachments(task_id, created_at);

    -- Task dependencies: task_id is blocked by depends_on (both in this tenant). A task is READY to dispatch
    -- only when every depends_on is done/cancelled — the enforced-pipeline edge a strategist's plan sets.
    CREATE TABLE IF NOT EXISTS task_deps (
      task_id    TEXT NOT NULL,   -- the dependent (blocked) task
      depends_on TEXT NOT NULL,   -- the blocker it waits on
      PRIMARY KEY (task_id, depends_on)
    );
    CREATE INDEX IF NOT EXISTS idx_task_deps_on ON task_deps(depends_on);

    -- Goals — the strategic layer work ladders up to (Goal → Task → Session). Human-owned, tenant-wide,
    -- persistent. Mirrors the Tasks shape: db-only structured state + an append-only event log as the
    -- audit/rollback backbone (auto-apply + audited, no gate). Slice 2 links a task up via tasks.goal_id;
    -- v1 is the object + its own timeline. See docs/goals-plan.md.
    CREATE TABLE IF NOT EXISTS goals (
      id         TEXT PRIMARY KEY,               -- short uuid (8)
      tenant     TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL DEFAULT '',       -- markdown "what / why"
      status     TEXT NOT NULL DEFAULT 'active', -- draft | active | achieved | abandoned
      target     TEXT,                           -- free-text target caption (v1); numeric metrics later
      owner      TEXT,                           -- member id accountable for the goal
      parent_id  TEXT,                           -- hierarchy: strategy → objective → key result (nullable)
      labels     TEXT NOT NULL DEFAULT '[]',     -- JSON string[]
      due_at     INTEGER,                        -- optional soft horizon (epoch ms)
      created_by TEXT NOT NULL,                  -- member id | 'agent:<id>'
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_goals_board ON goals(tenant, status);
    CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_id);

    -- Append-only activity log for a goal (status changes, edits, comments, task links) — the Goals
    -- analog of task_events / kb_revisions. The reversibility/audit backbone.
    CREATE TABLE IF NOT EXISTS goal_events (
      id         TEXT PRIMARY KEY,
      goal_id    TEXT NOT NULL,
      kind       TEXT NOT NULL,                  -- status | comment | edit | link
      body       TEXT,                           -- note text, or "active→achieved", or "task:<id>"
      author     TEXT NOT NULL,                  -- member id | 'agent:<id>' | 'system'
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_goal_events ON goal_events(goal_id, created_at);

    -- FTS5 over title+body+labels for the Goals page search (mirrors tasks_fts exactly).
    CREATE VIRTUAL TABLE IF NOT EXISTS goals_fts USING fts5(
      title, body, labels, content='goals', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS goals_ai AFTER INSERT ON goals BEGIN
      INSERT INTO goals_fts(rowid, title, body, labels) VALUES (new.rowid, new.title, new.body, new.labels);
    END;
    CREATE TRIGGER IF NOT EXISTS goals_ad AFTER DELETE ON goals BEGIN
      INSERT INTO goals_fts(goals_fts, rowid, title, body, labels) VALUES('delete', old.rowid, old.title, old.body, old.labels);
    END;
    CREATE TRIGGER IF NOT EXISTS goals_au AFTER UPDATE ON goals BEGIN
      INSERT INTO goals_fts(goals_fts, rowid, title, body, labels) VALUES('delete', old.rowid, old.title, old.body, old.labels);
      INSERT INTO goals_fts(rowid, title, body, labels) VALUES (new.rowid, new.title, new.body, new.labels);
    END;

    -- Which agents a library skill is scoped to (the skill artifact itself stays on disk under
    -- home/skills/name). Same join-table shape as assignments (members->agents). A skill with
    -- NO rows here is materialised into EVERY claude-code agent (the default & today's behavior);
    -- rows present scope it to exactly those agent ids. Rows referencing a since-deleted agent are
    -- harmless -- they simply never match a launch. Cleaned up when the skill is removed.
    CREATE TABLE IF NOT EXISTS skill_assignments (
      skill TEXT NOT NULL,
      agent TEXT NOT NULL,
      PRIMARY KEY (skill, agent)
    );

    -- Per-member inbox state (read + dismiss). The messages feed is SHARED (every owner/admin sees the
    -- same rows), so read/dismiss can't be a single column on the message — one admin dismissing would
    -- hide it for all. This join table keys both to (message, member): each viewer has their own
    -- read-line and their own dismissed set. Legacy global messages.dismissed_at is still honored as a
    -- dismissed-for-all fallback so pre-migration dismissals don't resurface.
    CREATE TABLE IF NOT EXISTS message_state (
      message_id   TEXT NOT NULL,
      member_id    TEXT NOT NULL,
      read_at      INTEGER,
      dismissed_at INTEGER,
      PRIMARY KEY (message_id, member_id)
    );

    -- Per-member preferences (JSON blob). Today it holds notification prefs (which session events ping
    -- me, whether toasts/sound/DM fire); a single row per member keyed by member id. Absent row = the
    -- code defaults (see DEFAULT_NOTIFICATION_PREFS). Kept separate from the shared settings table
    -- because these are per-person, not workspace-wide.
    CREATE TABLE IF NOT EXISTS member_prefs (
      member_id    TEXT PRIMARY KEY,
      prefs        TEXT NOT NULL,
      updated_at   INTEGER NOT NULL
    );
  `);

  // Idempotent column additions for the inbox feed (older DBs won't have these).
  addColumn(db, 'messages', 'source', 'TEXT');        // provenance: member id | automation:<id>
  addColumn(db, 'messages', 'question_id', 'TEXT');   // links a 'question' message to its row
  addColumn(db, 'messages', 'outcome', 'TEXT');       // for 'completed' messages: success|failure|partial|unknown
  addColumn(db, 'messages', 'dismissed_at', 'INTEGER'); // when a human dismissed it from the inbox (NULL = visible)
  // Explicit recipient routing (see docs/inbox-plan.md): when set, the card's visibility is governed by
  // this Audience (member/admins/approvers/sessionOwner), NOT by its session's provenance — the path a
  // session-less card (e.g. a Tasks notification, session_id='task:<id>') reaches the right person.
  addColumn(db, 'messages', 'audience_kind', 'TEXT');  // Audience.kind | NULL = fall back to session visibility
  addColumn(db, 'messages', 'audience_id', 'TEXT');    // the audience's member id / approval level (kind-dependent)

  // Who a question is addressed to: a member id when the agent `ask`ed a SPECIFIC teammate (not the run's
  // operator). NULL = the default sessionOwner routing. Lets `canViewQuestion` grant that member the answer.
  addColumn(db, 'questions', 'audience_id', 'TEXT');

  // Execution mode for automations (older DBs predate it — default preserves their interactive behavior).
  addColumn(db, 'automations', 'mode', "TEXT NOT NULL DEFAULT 'interactive'");
  addColumn(db, 'automations', 'filter', 'TEXT'); // composio: trigger slug / slack: event type|channel to match ('' = any)
  // One-shot scheduled tasks (type 'once'): when to fire, and the run-as identity to fire it under.
  addColumn(db, 'automations', 'run_at', 'INTEGER'); // fire time for a one-shot 'once' automation (epoch ms)
  addColumn(db, 'automations', 'run_as', 'TEXT');    // member id the fired session should act as (one-shot)
  addColumn(db, 'automations', 'resume_claude_id', 'TEXT'); // claude session id a one-shot resumes (context continuity)

  // Remote-MCP transport for connectors (older DBs are all stdio: command/args/env).
  addColumn(db, 'connectors', 'transport', "TEXT NOT NULL DEFAULT 'stdio'");
  addColumn(db, 'connectors', 'url', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'connectors', 'headers', "TEXT NOT NULL DEFAULT '{}'");

  // Connector ownership (older DBs predate org/personal split — all existing rows default to org,
  // i.e. company-wide, preserving today's "shared by everyone" behavior).
  addColumn(db, 'connectors', 'scope', "TEXT NOT NULL DEFAULT 'org'");
  addColumn(db, 'connectors', 'owner_member_id', 'TEXT');

  // A personal connector the owner has SHARED with the whole team: injected into every member's
  // sessions (acting as the owner, since the stored creds are theirs), not just the owner's own.
  // Default 0 = private (today's behavior). Only meaningful for scope='personal'.
  addColumn(db, 'connectors', 'shared', 'INTEGER NOT NULL DEFAULT 0');

  // Host proposals (host_propose): an agent-drafted host, inactive until an owner/admin publishes.
  addColumn(db, 'hosts', 'proposed', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'hosts', 'proposed_by', 'TEXT');
  addColumn(db, 'hosts', 'proposed_reason', 'TEXT');

  // Presence: last time a browser request rode this auth session (throttled to ≤1 write/min in
  // TeamStore.resolveSession). A member is "online" when any of their sessions was seen recently.
  addColumn(db, 'auth_sessions', 'last_seen_at', 'INTEGER');

  // Per-session bearer secret for the loopback agent endpoints (0d). Older rows have none → the
  // server fails open for them (they predate the secret), but every new session mints one.
  addColumn(db, 'term_sessions', 'secret', 'TEXT');

  // Run-as identity (P2): the member a session ACTS AS (their connectors/Composio/inbox/isolation),
  // distinct from `spawned_by` which stays PROVENANCE (the automation/console that triggered it).
  // NULL → identity falls back to memberOf(spawned_by). Older rows predate it → NULL (no change).
  addColumn(db, 'term_sessions', 'run_as', 'TEXT');

  // The claude conversation id we pin this run to (`claude --session-id`), so a later run can RESUME
  // the SAME transcript (`claude --resume`) and keep context — the backbone of chat-thread continuity
  // (a Slack/Discord follow-up in a bound thread continues the same conversation). NULL for older rows
  // and non-claude runs → those can't be resumed and fall back to a fresh spawn.
  addColumn(db, 'term_sessions', 'claude_session_id', 'TEXT');

  // Last-touched timestamp: bumped on every status transition (report/end/stop/resume/crash) so the
  // sessions list can sort by recent activity, not just creation. Backfilled to created_at for existing
  // rows; the UPDATE is idempotent (only touches NULLs) so it's a no-op after the first boot.
  addColumn(db, 'term_sessions', 'updated_at', 'INTEGER');
  db.exec('UPDATE term_sessions SET updated_at = created_at WHERE updated_at IS NULL');

  // Resident (warm) chat session: an INTERACTIVE claude kept alive after it answers so a thread
  // follow-up is delivered by typing into it (tmux send-keys) — fast, and one session row per thread
  // instead of a fresh cold run per reply. The idle reaper kills these after the configured timeout.
  // 0 for normal one-shot runs.
  addColumn(db, 'term_sessions', 'resident', 'INTEGER NOT NULL DEFAULT 0');
  // Last time a resident session saw a turn (spawn or a delivered follow-up) — the idle-reaper clock.
  // NULL for non-resident rows (never reaped on idle).
  addColumn(db, 'term_sessions', 'last_activity', 'INTEGER');
  // Whether the run launched headless (`claude -p`, non-interactive → exits when done) vs an
  // attachable interactive TUI. Persists what was previously a launch-only argument so the console can
  // badge each session's mode. Older rows default 0 (interactive) — a cosmetic backfill only.
  addColumn(db, 'term_sessions', 'headless', 'INTEGER NOT NULL DEFAULT 0');

  // Session status vocabulary widened: running|idle → running|done|stopped|crashed. Legacy terminal
  // rows collapsed every non-running end state into 'idle'; we can't retro-classify how they actually
  // ended, so map them to the benign 'done'. Idempotent — after the first boot there are no 'idle' rows.
  db.exec("UPDATE term_sessions SET status = 'done' WHERE status = 'idle'");

  // Optional embedding for semantic recall on the (zero-dep) sqlite backend: a packed Float32
  // vector. NULL when no embedder is configured (→ keyword-only) or the row predates one.
  addColumn(db, 'memories', 'embedding', 'BLOB');

  // Usage tracking for memory maintenance (prune the never-recalled & stale; keep what's used).
  addColumn(db, 'memories', 'recall_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'memories', 'last_recalled_at', 'INTEGER');
  // Visibility scope: 'agent' (private, the default & today's behavior) | 'tenant' (shared workspace-wide).
  // The index must come AFTER addColumn — on an existing DB the column doesn't exist until now.
  addColumn(db, 'memories', 'scope', "TEXT NOT NULL DEFAULT 'agent'");
  db.exec('CREATE INDEX IF NOT EXISTS idx_mem_scope ON memories(tenant, scope, created_at)');

  // How a dispatched task session runs (headless work-to-completion vs. an attachable interactive TUI).
  // Older `tasks` rows (created before this column) default to today's behavior: headless.
  addColumn(db, 'tasks', 'mode', "TEXT NOT NULL DEFAULT 'headless'");

  // Slice 2 — link a task up to the strategic Goal it advances (nullable; older rows have none), and an
  // optional single-line acceptance `criteria` that, when set on a headless task, drives its dispatched
  // session under a Claude Code `/goal` completion condition (autonomous convergence). See goals-plan.md.
  addColumn(db, 'tasks', 'goal_id', 'TEXT');
  addColumn(db, 'tasks', 'criteria', 'TEXT');

  // Human verdict on a finished run — the ground-truth signal for the agent maturity score (a person
  // who oversaw the run says it did / didn't do what they wanted). One verdict per session, latest wins.
  // Feeds src/state/agent-stats.ts as the HIGHEST-confidence outcome layer, above the agent's own
  // self-report and even a task result.
  addColumn(db, 'term_sessions', 'rating', 'TEXT');       // 'up' | 'down' | NULL (unrated)
  addColumn(db, 'term_sessions', 'rated_by', 'TEXT');     // member id who gave the verdict
  addColumn(db, 'term_sessions', 'rated_at', 'INTEGER');  // when (epoch ms)

  // Take-over: a human "claimed" an unattended run to watch/steer it live. Setting this makes the
  // session STICKY — the turn-end (`markTurnIdle`) and idle backstop reapers never tear it down, so a
  // claimed run keeps its live TUI instead of being auto-closed when it goes idle. NULL = unclaimed
  // (the default; every existing row). See docs/attachable-sessions-plan.md.
  addColumn(db, 'term_sessions', 'claimed_by', 'TEXT');    // member id who took it over (NULL = unclaimed)
  addColumn(db, 'term_sessions', 'claimed_at', 'INTEGER'); // when (epoch ms)

  // Profile picture: a small square `data:image/…;base64,…` URL. NULL → the UI shows the member's
  // initial. Members set their own from the Team page; owners/admins may set anyone's.
  addColumn(db, 'members', 'avatar', 'TEXT');

  // KB fetch counter: every time an agent opens a page (kb_read) we bump these. A never/rarely-read
  // page is a candidate for auto-archive later. Older pages default to 0 / never-read.
  addColumn(db, 'kb_pages', 'read_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'kb_pages', 'last_read_at', 'INTEGER');
  // The bump is an UPDATE; re-scope the FTS reindex trigger to content columns only so a fetch doesn't
  // re-tokenize the body. `CREATE TRIGGER IF NOT EXISTS` above leaves an existing DB's old un-scoped
  // trigger in place, so drop + recreate it here.
  db.exec('DROP TRIGGER IF EXISTS kb_au');
  db.exec(`CREATE TRIGGER kb_au AFTER UPDATE OF title, tags, body ON kb_pages BEGIN
    INSERT INTO kb_fts(kb_fts, rowid, title, tags, body) VALUES('delete', old.rowid, old.title, old.tags, old.body);
    INSERT INTO kb_fts(rowid, title, tags, body) VALUES (new.rowid, new.title, new.tags, new.body);
  END`);

  // Artifacts folders: a '/'-separated folder path ('' = root) that groups the gallery into a
  // browsable tree. Pure organizing metadata — the on-disk <id>/<filename> layout is unchanged.
  // Existing artifacts default to '' (root).
  addColumn(db, 'artifacts', 'folder', "TEXT NOT NULL DEFAULT ''");

  // Generated-media cost: the USD a generated artifact (image/video) cost to produce, so the gallery
  // can show what each deliverable spent. NULL for published (non-generated) artifacts. Nullable REAL.
  addColumn(db, 'artifacts', 'cost_usd', 'REAL');
}

/** Add a column only if it isn't already present (SQLite has no ADD COLUMN IF NOT EXISTS). */
function addColumn(db: Db, table: string, col: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
