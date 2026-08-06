/**
 * The mesh on MongoDB — the store your laptop, your phone and Vercel all
 * share, and the live channel between them.
 *
 * Two things in here are less obvious than they look.
 *
 * **`$set` alone loses nothing, and that is the problem.** When the queue
 * hands a task back it *deletes* `claimedBy` and `leaseUntil`. A naive
 * `updateOne({$set: task})` writes every field the object still has and leaves
 * the ones it dropped exactly where they were — so a released task keeps
 * looking claimed by a laptop that shut down hours ago, and nothing ever runs
 * it again. Every write therefore builds an explicit `$unset` for the optional
 * fields that are absent.
 *
 * **The socket you asked for is a change stream.** Mongo pushes the change
 * down an already-open TCP connection the instant it is written — no polling,
 * no server of our own, and it resumes from a stored token after a network
 * drop, which is the "carry on where it left off" behaviour the whole system
 * is built around. Where change streams are not available — a plain
 * `mongod` with no replica set, which is what a local install gives you —
 * this falls back to polling and *says so*, rather than going quiet.
 *
 * The driver is not imported. Only the handful of methods actually used are
 * described here, and a real `Collection` satisfies them, so this package
 * stays dependency-free and testable without a database.
 */

import type { JsonObject } from '@megaai/types';
import {
  LIVE_STATES,
  type MeshStore,
  type MeshTask,
  type MeshTaskState,
  type NodeRecord,
  type TaskFilter,
} from './index.js';

/* ------------------------------------------------------------------ *
 * The little of MongoDB that is used
 * ------------------------------------------------------------------ */

export interface MinimalCursor<T> {
  toArray(): Promise<T[]>;
}

export interface MinimalChangeStream<T> {
  on(event: 'change', listener: (change: { fullDocument?: T; _id?: unknown }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  close(): Promise<void>;
}

export interface MinimalCollection<T> {
  findOne(filter: Record<string, unknown>): Promise<T | null>;
  find(filter: Record<string, unknown>, options?: Record<string, unknown>): MinimalCursor<T>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<T | null>;
  createIndex?(spec: Record<string, unknown>, options?: Record<string, unknown>): Promise<string>;
  watch?(pipeline?: unknown[], options?: Record<string, unknown>): MinimalChangeStream<T>;
}

export type NodeDoc = Omit<NodeRecord, 'id'> & { _id: string };
export type TaskDoc = Omit<MeshTask, 'id'> & { _id: string };

export interface MeshCollections {
  nodes: MinimalCollection<NodeDoc>;
  tasks: MinimalCollection<TaskDoc>;
}

/* ------------------------------------------------------------------ *
 * Writing without leaving stale fields behind
 * ------------------------------------------------------------------ */

/**
 * The fields a task may legitimately not have.
 *
 * Every one of these is *removed* somewhere in the queue's logic, and every
 * one of them would break something if it survived the removal: a lingering
 * `claimedBy` strands the task, a lingering `notBefore` keeps it waiting, a
 * lingering `error` reports a failure that has since been retried.
 */
export const OPTIONAL_TASK_FIELDS = [
  'notBefore',
  'claimedBy',
  'leaseUntil',
  'checkpoint',
  'result',
  'error',
  'waitingFor',
] as const;

const OPTIONAL_NODE_FIELDS = ['health', 'meta'] as const;

function buildUpdate<T extends Record<string, unknown>>(
  document: T,
  optionalFields: readonly string[],
): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === '_id') continue;
    if (value !== undefined) set[key] = value;
  }
  const unset: Record<string, ''> = {};
  for (const field of optionalFields) {
    if (document[field] === undefined) unset[field] = '';
  }
  return {
    $set: set,
    ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
  };
}

function taskFromDoc(doc: TaskDoc): MeshTask {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest } as MeshTask;
}

function nodeFromDoc(doc: NodeDoc): NodeRecord {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest } as NodeRecord;
}

function taskToDoc(task: MeshTask): TaskDoc {
  const { id, ...rest } = task;
  return { _id: id, ...rest } as TaskDoc;
}

function nodeToDoc(node: NodeRecord): NodeDoc {
  const { id, ...rest } = node;
  return { _id: id, ...rest } as NodeDoc;
}

/* ------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------ */

export class MongoMeshStore implements MeshStore {
  constructor(private readonly collections: MeshCollections) {}

  async putNode(node: NodeRecord): Promise<void> {
    await this.collections.nodes.updateOne(
      { _id: node.id },
      buildUpdate(nodeToDoc(node) as unknown as Record<string, unknown>, OPTIONAL_NODE_FIELDS),
      { upsert: true },
    );
  }

  async getNode(id: string): Promise<NodeRecord | undefined> {
    const doc = await this.collections.nodes.findOne({ _id: id });
    return doc ? nodeFromDoc(doc) : undefined;
  }

  async listNodes(): Promise<NodeRecord[]> {
    return (await this.collections.nodes.find({}).toArray()).map(nodeFromDoc);
  }

  async putTask(task: MeshTask): Promise<void> {
    await this.collections.tasks.updateOne(
      { _id: task.id },
      buildUpdate(taskToDoc(task) as unknown as Record<string, unknown>, OPTIONAL_TASK_FIELDS),
      { upsert: true },
    );
  }

  async getTask(id: string): Promise<MeshTask | undefined> {
    const doc = await this.collections.tasks.findOne({ _id: id });
    return doc ? taskFromDoc(doc) : undefined;
  }

  async listTasks(filter: TaskFilter = {}): Promise<MeshTask[]> {
    const query: Record<string, unknown> = {};
    if (filter.states) query['state'] = { $in: filter.states };
    const options: Record<string, unknown> = { sort: { createdAt: 1 } };
    if (filter.limit !== undefined) options['limit'] = filter.limit;
    return (await this.collections.tasks.find(query, options).toArray()).map(taskFromDoc);
  }

  /**
   * The compare-and-set that stops two machines running the same task.
   *
   * `rev` is in the *filter*, so the write only lands if nobody has touched
   * the task since it was read. The loser gets `null` back and moves on to the
   * next task rather than quietly doing the winner's work as well.
   */
  async claim(taskId: string, expectRev: number, next: MeshTask): Promise<boolean> {
    const result = await this.collections.tasks.findOneAndUpdate(
      { _id: taskId, rev: expectRev },
      buildUpdate(taskToDoc(next) as unknown as Record<string, unknown>, OPTIONAL_TASK_FIELDS),
      { returnDocument: 'after' },
    );
    return result !== null;
  }
}

/**
 * Indexes for the two queries that run constantly: "what is live" and "who is
 * online". Without the first, every claim scans the whole history.
 */
export async function ensureMeshIndexes(collections: MeshCollections): Promise<void> {
  await collections.tasks.createIndex?.({ state: 1, createdAt: 1 });
  await collections.tasks.createIndex?.({ state: 1, notBefore: 1 });
  await collections.nodes.createIndex?.({ lastSeen: -1 });
}

/* ------------------------------------------------------------------ *
 * Live
 * ------------------------------------------------------------------ */

export interface WatchOptions {
  /** Called with the task, however the change reached us. */
  onTask: (task: MeshTask) => void;
  /** Told when the live channel is lost or downgraded — never silent. */
  onNotice?: (message: string) => void;
  /** How often to look when change streams are not available. */
  pollMs?: number;
  /** Injected for tests. */
  setIntervalFn?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (timer: NodeJS.Timeout) => void;
}

export interface TaskWatch {
  /** `true` while a change stream is carrying the changes. */
  readonly live: boolean;
  close(): Promise<void>;
}

/**
 * Watch the queue.
 *
 * A change stream when the deployment has one, polling when it does not —
 * and the difference is reported rather than hidden, because "why is the
 * laptop taking 30 seconds to notice my task" should have an answer on screen.
 */
export function watchTasks(collections: MeshCollections, options: WatchOptions): TaskWatch {
  const setIntervalFn = options.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalFn = options.clearIntervalFn ?? ((timer) => clearInterval(timer));
  const pollMs = options.pollMs ?? 15_000;

  let stream: MinimalChangeStream<TaskDoc> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const revisions = new Map<string, number>();

  const startPolling = (why: string): void => {
    if (timer || closed) return;
    options.onNotice?.(`${why} — checking every ${Math.round(pollMs / 1000)}s instead of being told instantly`);
    timer = setIntervalFn(() => {
      void (async () => {
        const query = { state: { $in: LIVE_STATES as MeshTaskState[] } };
        for (const doc of await collections.tasks.find(query, { sort: { createdAt: 1 } }).toArray()) {
          const task = taskFromDoc(doc);
          if (revisions.get(task.id) === task.rev) continue;
          revisions.set(task.id, task.rev);
          options.onTask(task);
        }
      })().catch((error: unknown) => options.onNotice?.(`could not read the queue: ${(error as Error).message}`));
    }, pollMs);
  };

  if (typeof collections.tasks.watch !== 'function') {
    startPolling('this database cannot push changes');
  } else {
    try {
      stream = collections.tasks.watch([], { fullDocument: 'updateLookup' });
      stream.on('change', (change) => {
        if (change.fullDocument) options.onTask(taskFromDoc(change.fullDocument));
      });
      stream.on('error', (error) => {
        // A single mongod has no oplog to stream, which is exactly what a local
        // install gives you — worth continuing rather than failing to start.
        options.onNotice?.(`the live connection dropped: ${error.message}`);
        void stream?.close().catch(() => {});
        stream = undefined;
        startPolling('the live connection could not be kept');
      });
    } catch (error) {
      startPolling(`change streams are not available here (${(error as Error).message})`);
    }
  }

  return {
    get live() {
      return stream !== undefined;
    },
    async close() {
      closed = true;
      if (timer) clearIntervalFn(timer);
      timer = undefined;
      await stream?.close().catch(() => {});
      stream = undefined;
    },
  };
}

/** Build the collection pair from anything shaped like a `Db`. */
export function meshCollections(db: {
  collection<T>(name: string): MinimalCollection<T>;
}, prefix = 'mesh'): MeshCollections {
  return {
    nodes: db.collection<NodeDoc>(`${prefix}_nodes`),
    tasks: db.collection<TaskDoc>(`${prefix}_tasks`),
  };
}

/** Everything a payload needs to be storable. */
export function asPayload(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
