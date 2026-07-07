/**
 * The memory plane — pluggable persistent recall for agents.
 *
 *   sqlite  (default) — zero-infra, ships in the box; FTS5 bm25 ranking in the workspace DB. Add
 *                       `sqlite.embeddings` for hybrid bm25 + in-JS cosine recall — still zero-dep.
 *   libsql  (opt-in)  — local libSQL file with native vector search; hybrid bm25 + cosine recall
 *                       (embeddings via OpenAI-compatible API or local Ollama). One file, no container.
 *   automem (opt-in)  — REST client to an automem deployment (FalkorDB graph + Qdrant vectors).
 *
 * Pick the backend in `agent-os.config.json` → `memory`. The rest of the OS only knows the
 * `MemoryProvider` interface (in types.ts), so switching backends touches nothing else.
 */
import { Db } from '../state/db';
import { MemoryConfig, MemoryProvider } from '../types';
import { Embedder } from './embedding';
import { SqliteMemoryProvider } from './sqlite-provider';
import { AutomemMemoryProvider } from './automem-provider';
import { LibsqlMemoryProvider } from './libsql-provider';
import { MirroredMemoryProvider } from './mirror';

export { SqliteMemoryProvider } from './sqlite-provider';
export { AutomemMemoryProvider } from './automem-provider';
export { LibsqlMemoryProvider } from './libsql-provider';
export { MirroredMemoryProvider } from './mirror';

/**
 * Build the recall backend for a config. SQLite is the local `memories` table itself; libsql/automem
 * are EXTERNAL stores, so they're wrapped in a `MirroredMemoryProvider` that keeps a copy of every
 * write in the local table — otherwise the OS's SQL-level readers (Dreaming / consolidation / the
 * Memory-hub overview counts) would see nothing. See mirror.ts. The rest of the OS only ever touches
 * the returned `MemoryProvider`.
 */
export function createMemoryProvider(cfg: MemoryConfig, db: Db): MemoryProvider {
  const backend = buildBackend(cfg, db);
  if (cfg.backend === 'sqlite') return backend; // the provider IS the local table — no mirror needed
  return new MirroredMemoryProvider(backend, new SqliteMemoryProvider(db));
}

function buildBackend(cfg: MemoryConfig, db: Db): MemoryProvider {
  if (cfg.backend === 'automem') {
    if (!cfg.automem?.endpoint || !cfg.automem?.token) {
      throw new Error('memory.backend=automem requires memory.automem.endpoint and .token');
    }
    return new AutomemMemoryProvider(cfg.automem);
  }
  if (cfg.backend === 'libsql') {
    if (!cfg.libsql?.url) throw new Error('memory.backend=libsql requires memory.libsql.url');
    return new LibsqlMemoryProvider(cfg.libsql, cfg.ranking);
  }
  const embeddings = cfg.sqlite?.embeddings;
  return new SqliteMemoryProvider(db, embeddings ? new Embedder(embeddings) : undefined, cfg.ranking);
}
