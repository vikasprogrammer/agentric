/**
 * VideoJobStore — the durable record of an in-flight video render.
 *
 * Unlike images (which return in seconds, so `generateImage` completes in one call), video generation
 * is ASYNC: the vendor accepts a job and the render lands minutes later. We can't hold an agent's tool
 * call open indefinitely, and a server restart mustn't lose a paid render. So every submitted job is
 * persisted here; a background poller (driven by the Automations tick) advances `rendering` jobs to
 * `done` (bytes ingested into `artifacts`) / `failed` / `expired`. `provider_ref` is an OPAQUE JSON
 * handle the vendor adapter round-trips, so this table knows nothing about any specific vendor.
 *
 * db-only (no on-disk mirror) — a job is transient control state, like TaskStore.
 */
import { randomUUID } from 'crypto';
import { Db } from './db';

export type VideoJobStatus = 'rendering' | 'done' | 'failed' | 'expired';

export interface VideoJob {
  id: string;
  sessionId: string;
  agent: string;
  source?: string;
  backend: string;
  model: string;
  prompt: string;
  providerRef: string;
  status: VideoJobStatus;
  costUsd?: number;
  artifactId?: string;
  error?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface VideoJobRow {
  id: string;
  session_id: string;
  agent: string;
  source: string | null;
  backend: string;
  model: string;
  prompt: string;
  provider_ref: string;
  status: string;
  cost_usd: number | null;
  artifact_id: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export class VideoJobStore {
  constructor(private readonly db: Db) {}

  create(input: {
    sessionId: string;
    agent: string;
    source?: string;
    backend: string;
    model: string;
    prompt: string;
    providerRef: string;
    costUsd?: number;
    ttlMs: number;
  }): VideoJob {
    const now = Date.now();
    const row: VideoJobRow = {
      id: randomUUID().slice(0, 8),
      session_id: input.sessionId,
      agent: input.agent,
      source: input.source ?? null,
      backend: input.backend,
      model: input.model,
      prompt: input.prompt,
      provider_ref: input.providerRef,
      status: 'rendering',
      cost_usd: typeof input.costUsd === 'number' ? input.costUsd : null,
      artifact_id: null,
      error: null,
      attempts: 0,
      created_at: now,
      updated_at: now,
      expires_at: now + input.ttlMs,
    };
    this.db
      .prepare(
        `INSERT INTO video_jobs (id, session_id, agent, source, backend, model, prompt, provider_ref, status, cost_usd, artifact_id, error, attempts, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.session_id, row.agent, row.source, row.backend, row.model, row.prompt,
        row.provider_ref, row.status, row.cost_usd, row.artifact_id, row.error, row.attempts,
        row.created_at, row.updated_at, row.expires_at,
      );
    return toJob(row);
  }

  get(id: string): VideoJob | undefined {
    const r = this.db.prepare('SELECT * FROM video_jobs WHERE id = ?').get<VideoJobRow>(id);
    return r ? toJob(r) : undefined;
  }

  /** Still-rendering jobs (oldest first), for the background poller to advance. */
  pending(): VideoJob[] {
    return this.db
      .prepare("SELECT * FROM video_jobs WHERE status = 'rendering' ORDER BY created_at ASC")
      .all<VideoJobRow>()
      .map(toJob);
  }

  /** Record another poll attempt (bounds runaway polling). */
  bumpAttempt(id: string): void {
    this.db.prepare('UPDATE video_jobs SET attempts = attempts + 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  markDone(id: string, artifactId: string, costUsd?: number): void {
    this.db
      .prepare("UPDATE video_jobs SET status = 'done', artifact_id = ?, cost_usd = COALESCE(?, cost_usd), updated_at = ? WHERE id = ?")
      .run(artifactId, typeof costUsd === 'number' ? costUsd : null, Date.now(), id);
  }

  markFailed(id: string, error: string): void {
    this.db.prepare("UPDATE video_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error.slice(0, 500), Date.now(), id);
  }

  markExpired(id: string): void {
    this.db.prepare("UPDATE video_jobs SET status = 'expired', updated_at = ? WHERE id = ?").run(Date.now(), id);
  }
}

function toJob(r: VideoJobRow): VideoJob {
  return {
    id: r.id,
    sessionId: r.session_id,
    agent: r.agent,
    source: r.source ?? undefined,
    backend: r.backend,
    model: r.model,
    prompt: r.prompt,
    providerRef: r.provider_ref,
    status: r.status as VideoJobStatus,
    costUsd: r.cost_usd ?? undefined,
    artifactId: r.artifact_id ?? undefined,
    error: r.error ?? undefined,
    attempts: r.attempts,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
  };
}
