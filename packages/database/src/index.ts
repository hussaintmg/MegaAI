/**
 * @megaai/database — storage for MegaAI's own state.
 *
 * Two engines behind one shape: `MemoryDatabase` (tests, ephemeral runs) and
 * `JsonFileDatabase` (durable local state with atomic writes). Real database
 * adapters (Postgres, Mongo…) plug in later behind the same interface.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MegaError, type JsonValue } from '@megaai/types';

export interface KeyValueStore {
  get<T extends JsonValue>(key: string): Promise<T | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;
}

export interface Collection<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  put(doc: T): Promise<void>;
  delete(id: string): Promise<boolean>;
  all(): Promise<T[]>;
  find(predicate: (doc: T) => boolean): Promise<T[]>;
}

export interface Database {
  kv(namespace: string): KeyValueStore;
  collection<T extends { id: string }>(name: string): Collection<T>;
  flush(): Promise<void>;
}

type Persist = (() => void) | undefined;

class MapKV implements KeyValueStore {
  constructor(
    readonly data: Map<string, JsonValue>,
    private readonly persist: Persist,
  ) {}

  async get<T extends JsonValue>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async set(key: string, value: JsonValue): Promise<void> {
    this.data.set(key, value);
    this.persist?.();
  }
  async delete(key: string): Promise<boolean> {
    const existed = this.data.delete(key);
    if (existed) this.persist?.();
    return existed;
  }
  async keys(prefix?: string): Promise<string[]> {
    const all = [...this.data.keys()];
    return prefix ? all.filter((key) => key.startsWith(prefix)) : all;
  }
}

class MapCollection<T extends { id: string }> implements Collection<T> {
  constructor(
    readonly data: Map<string, T>,
    private readonly persist: Persist,
  ) {}

  async get(id: string): Promise<T | undefined> {
    const doc = this.data.get(id);
    return doc ? structuredClone(doc) : undefined;
  }
  async put(doc: T): Promise<void> {
    if (!doc.id) throw new MegaError('INVALID_INPUT', 'Document must have an id');
    this.data.set(doc.id, structuredClone(doc));
    this.persist?.();
  }
  async delete(id: string): Promise<boolean> {
    const existed = this.data.delete(id);
    if (existed) this.persist?.();
    return existed;
  }
  async all(): Promise<T[]> {
    return [...this.data.values()].map((doc) => structuredClone(doc));
  }
  async find(predicate: (doc: T) => boolean): Promise<T[]> {
    return (await this.all()).filter(predicate);
  }
}

export class MemoryDatabase implements Database {
  private readonly kvStores = new Map<string, MapKV>();
  private readonly collections = new Map<string, MapCollection<{ id: string }>>();

  kv(namespace: string): KeyValueStore {
    let store = this.kvStores.get(namespace);
    if (!store) {
      store = new MapKV(new Map(), undefined);
      this.kvStores.set(namespace, store);
    }
    return store;
  }

  collection<T extends { id: string }>(name: string): Collection<T> {
    let col = this.collections.get(name);
    if (!col) {
      col = new MapCollection(new Map(), undefined);
      this.collections.set(name, col);
    }
    return col as unknown as Collection<T>;
  }

  async flush(): Promise<void> {
    /* nothing to do — memory only */
  }
}

function safeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!cleaned) throw new MegaError('INVALID_INPUT', `Invalid store name "${name}"`);
  return cleaned;
}

/** Atomic write: write to a temp file then rename over the target. */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

/**
 * JSON files under `<dir>/`: one file per namespace/collection. Writes are
 * write-through and atomic, so a crash never leaves a half-written store.
 */
export class JsonFileDatabase implements Database {
  private readonly kvStores = new Map<string, MapKV>();
  private readonly collections = new Map<string, MapCollection<{ id: string }>>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private load(file: string): Record<string, JsonValue> {
    const path = join(this.dir, file);
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, JsonValue>;
    } catch (err) {
      throw new MegaError('INTERNAL', `Corrupt store file ${path}: ${String(err)}`);
    }
  }

  private saver(file: string, data: Map<string, unknown>): () => void {
    return () => {
      const obj: Record<string, unknown> = {};
      for (const [key, value] of data) obj[key] = value;
      atomicWrite(join(this.dir, file), JSON.stringify(obj, null, 2));
    };
  }

  kv(namespace: string): KeyValueStore {
    const name = safeName(namespace);
    let store = this.kvStores.get(name);
    if (!store) {
      const file = `kv-${name}.json`;
      const data = new Map<string, JsonValue>(Object.entries(this.load(file)));
      store = new MapKV(data, this.saver(file, data));
      this.kvStores.set(name, store);
    }
    return store;
  }

  collection<T extends { id: string }>(collectionName: string): Collection<T> {
    const name = safeName(collectionName);
    let col = this.collections.get(name);
    if (!col) {
      const file = `col-${name}.json`;
      const data = new Map<string, { id: string }>(
        Object.entries(this.load(file)) as Array<[string, { id: string }]>,
      );
      col = new MapCollection(data, this.saver(file, data));
      this.collections.set(name, col);
    }
    return col as unknown as Collection<T>;
  }

  async flush(): Promise<void> {
    // Write-through means stores are already durable; kept for interface parity.
  }
}

export function createDatabase(options: { dir?: string } = {}): Database {
  return options.dir ? new JsonFileDatabase(options.dir) : new MemoryDatabase();
}
