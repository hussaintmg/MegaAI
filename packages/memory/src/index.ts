/**
 * @megaai/memory — what MegaAI remembers.
 *
 * Scoped memories (conversation, project, agent, knowledge, long-term…)
 * persisted through the database layer, plus a deliberately simple local
 * vector index (hashed bag-of-words + cosine) so `search()` does semantic-ish
 * retrieval with zero external services. The embedding function is a single
 * seam to swap for a real embedding model later.
 */

import type { JsonObject, MemoryRecord, MemoryScope, MemorySearchHit } from '@megaai/types';
import { type Clock, newId, systemClock } from '@megaai/utils';
import type { Database, Collection } from '@megaai/database';
import type { EventBus } from '@megaai/events';

const DIMS = 256;

/** Hashed bag-of-words embedding — deterministic and offline. */
export function embed(text: string): Float64Array {
  const vector = new Float64Array(DIMS);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const word of words) {
    let hash = 5381;
    for (let i = 0; i < word.length; i += 1) hash = ((hash << 5) + hash + word.charCodeAt(i)) | 0;
    const slot = ((hash % DIMS) + DIMS) % DIMS;
    vector[slot] = (vector[slot] as number) + 1;
  }
  let norm = 0;
  for (let i = 0; i < DIMS; i += 1) norm += (vector[i] as number) ** 2;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIMS; i += 1) vector[i] = (vector[i] as number) / norm;
  return vector;
}

export function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  for (let i = 0; i < DIMS; i += 1) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

export interface RememberInput {
  scope: MemoryScope;
  text: string;
  refId?: string;
  tags?: string[];
  meta?: JsonObject;
}

export interface RecallFilter {
  scope?: MemoryScope;
  refId?: string;
  tag?: string;
  limit?: number;
}

export class MemoryEngine {
  readonly name = 'memory';
  private readonly collection: Collection<MemoryRecord>;
  private readonly index = new Map<string, Float64Array>();
  private indexed = false;

  constructor(
    database: Database,
    private readonly bus?: EventBus,
    private readonly clock: Clock = systemClock,
  ) {
    this.collection = database.collection<MemoryRecord>('memories');
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexed) return;
    for (const record of await this.collection.all()) {
      this.index.set(record.id, embed(record.text));
    }
    this.indexed = true;
  }

  async remember(input: RememberInput): Promise<MemoryRecord> {
    const record: MemoryRecord = {
      id: newId('mem'),
      scope: input.scope,
      refId: input.refId,
      text: input.text,
      tags: input.tags ?? [],
      createdAt: this.clock.now(),
      meta: input.meta ?? {},
    };
    await this.collection.put(record);
    await this.ensureIndex();
    this.index.set(record.id, embed(record.text));
    this.bus?.emit('memory.recorded', { id: record.id, scope: record.scope }, 'memory');
    return record;
  }

  /** Most recent memories matching the filter (no semantic ranking). */
  async recall(filter: RecallFilter = {}): Promise<MemoryRecord[]> {
    const all = await this.collection.all();
    return all
      .filter((record) => !filter.scope || record.scope === filter.scope)
      .filter((record) => !filter.refId || record.refId === filter.refId)
      .filter((record) => !filter.tag || record.tags.includes(filter.tag))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, filter.limit ?? 20);
  }

  /** Semantic-ish search over stored memories. */
  async search(query: string, filter: RecallFilter = {}): Promise<MemorySearchHit[]> {
    await this.ensureIndex();
    const queryVector = embed(query);
    const all = await this.collection.all();
    const hits: MemorySearchHit[] = [];
    for (const record of all) {
      if (filter.scope && record.scope !== filter.scope) continue;
      if (filter.refId && record.refId !== filter.refId) continue;
      if (filter.tag && !record.tags.includes(filter.tag)) continue;
      const vector = this.index.get(record.id) ?? embed(record.text);
      hits.push({ record, score: cosine(queryVector, vector) });
    }
    return hits
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, filter.limit ?? 5);
  }

  async forget(id: string): Promise<boolean> {
    this.index.delete(id);
    return this.collection.delete(id);
  }

  async count(scope?: MemoryScope): Promise<number> {
    const all = await this.collection.all();
    return scope ? all.filter((record) => record.scope === scope).length : all.length;
  }
}

/**
 * KnowledgeBase — curated reference material (docs, policies, templates,
 * examples). A thin, intent-revealing wrapper over the `knowledge` scope.
 */
export class KnowledgeBase {
  constructor(private readonly memory: MemoryEngine) {}

  async addDocument(title: string, text: string, tags: string[] = []): Promise<MemoryRecord> {
    return this.memory.remember({
      scope: 'knowledge',
      text: `# ${title}\n\n${text}`,
      tags: ['doc', ...tags],
      meta: { title },
    });
  }

  async search(query: string, limit = 3): Promise<MemorySearchHit[]> {
    return this.memory.search(query, { scope: 'knowledge', limit });
  }
}
