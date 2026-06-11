/**
 * State & knowledge plane — THREE different stores with three lifecycles. Do not merge.
 *   - Tasks:     operational state. What work exists and its status. (churns)
 *   - Memory:    episodic. What happened in past runs. (accretes)
 *   - Knowledge: semantic. SOPs, brand voice, customer facts. (curated)
 *
 * In-memory reference impls; swap for Postgres / a vector store / a doc store in prod.
 */

export interface Task {
  id: string;
  tenant: string;
  title: string;
  status: 'open' | 'in_progress' | 'blocked' | 'done';
  data?: Record<string, unknown>;
}

export interface TaskStore {
  upsert(task: Task): void;
  get(id: string): Task | undefined;
  byStatus(tenant: string, status: Task['status']): Task[];
}

export class InMemoryTaskStore implements TaskStore {
  private tasks = new Map<string, Task>();
  upsert(task: Task): void {
    this.tasks.set(task.id, task);
  }
  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }
  byStatus(tenant: string, status: Task['status']): Task[] {
    return [...this.tasks.values()].filter((t) => t.tenant === tenant && t.status === status);
  }
}

/** Episodic memory — what happened, per agent. Append + recent recall. */
export interface Episode {
  tenant: string;
  agentId: string;
  runId: string;
  summary: string;
  outcome: string;
  ts: number;
}

export interface MemoryStore {
  record(ep: Episode): void;
  recent(tenant: string, agentId: string, limit?: number): Episode[];
}

export class InMemoryMemoryStore implements MemoryStore {
  private episodes: Episode[] = [];
  record(ep: Episode): void {
    this.episodes.push(ep);
  }
  recent(tenant: string, agentId: string, limit = 20): Episode[] {
    return this.episodes
      .filter((e) => e.tenant === tenant && e.agentId === agentId)
      .slice(-limit)
      .reverse();
  }
}

/** Semantic knowledge — curated facts/SOPs. Naive substring retrieval here; use a
 *  vector store in prod. */
export interface KnowledgeDoc {
  tenant: string;
  id: string;
  title: string;
  body: string;
  tags?: string[];
}

export interface KnowledgeStore {
  put(doc: KnowledgeDoc): void;
  search(tenant: string, query: string, limit?: number): KnowledgeDoc[];
}

export class InMemoryKnowledgeStore implements KnowledgeStore {
  private docs: KnowledgeDoc[] = [];
  put(doc: KnowledgeDoc): void {
    this.docs.push(doc);
  }
  search(tenant: string, query: string, limit = 5): KnowledgeDoc[] {
    const q = query.toLowerCase();
    return this.docs
      .filter((d) => d.tenant === tenant && (d.title.toLowerCase().includes(q) || d.body.toLowerCase().includes(q)))
      .slice(0, limit);
  }
}
