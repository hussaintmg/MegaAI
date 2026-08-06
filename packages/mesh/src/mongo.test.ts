import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '@megaai/utils';
import { Mesh, type MeshTask } from './index.js';
import {
  MongoMeshStore,
  OPTIONAL_TASK_FIELDS,
  watchTasks,
  type MinimalChangeStream,
  type MinimalCollection,
  type NodeDoc,
  type TaskDoc,
} from './mongo.js';

/** Just enough Mongo to be wrong in the same ways a real one would be. */
class FakeCollection<T extends { _id: string }> implements MinimalCollection<T> {
  readonly docs = new Map<string, T>();
  readonly indexes: Array<Record<string, unknown>> = [];
  changeStream: FakeChangeStream<T> | undefined;

  constructor(readonly canWatch = false) {}

  async findOne(filter: Record<string, unknown>): Promise<T | null> {
    return [...this.docs.values()].find((doc) => matches(doc, filter)) ?? null;
  }

  find(filter: Record<string, unknown>, options: Record<string, unknown> = {}) {
    return {
      toArray: async (): Promise<T[]> => {
        let found = [...this.docs.values()].filter((doc) => matches(doc, filter));
        const sort = options['sort'] as Record<string, number> | undefined;
        const by = sort ? Object.entries(sort)[0] : undefined;
        if (by) {
          const [key, direction] = by;
          found.sort((a, b) => (Number(a[key as keyof T] ?? 0) - Number(b[key as keyof T] ?? 0)) * Number(direction));
        }
        const limit = options['limit'] as number | undefined;
        if (limit !== undefined) found = found.slice(0, limit);
        return found.map((doc) => ({ ...doc }));
      },
    };
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ): Promise<unknown> {
    const existing = [...this.docs.values()].find((doc) => matches(doc, filter));
    if (!existing) {
      if (!options['upsert']) return { matchedCount: 0 };
      const created = { _id: filter['_id'] as string } as T;
      this.docs.set(created._id, apply(created, update));
      return { upsertedCount: 1 };
    }
    this.docs.set(existing._id, apply(existing, update));
    return { matchedCount: 1 };
  }

  async findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<T | null> {
    const existing = [...this.docs.values()].find((doc) => matches(doc, filter));
    if (!existing) return null;
    const next = apply(existing, update);
    this.docs.set(existing._id, next);
    return { ...next };
  }

  async createIndex(spec: Record<string, unknown>): Promise<string> {
    this.indexes.push(spec);
    return Object.keys(spec).join('_');
  }

  watch(): MinimalChangeStream<T> {
    if (!this.canWatch) throw new Error('The $changeStream stage is only supported on replica sets');
    this.changeStream = new FakeChangeStream<T>();
    return this.changeStream;
  }
}

class FakeChangeStream<T> implements MinimalChangeStream<T> {
  private readonly listeners = new Map<string, Array<(payload: never) => void>>();
  closed = false;

  on(event: 'change' | 'error', listener: (payload: never) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  emit(event: 'change' | 'error', payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (p: unknown) => void)(payload);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = doc[key];
    if (expected && typeof expected === 'object' && '$in' in (expected as Record<string, unknown>)) {
      return ((expected as { $in: unknown[] }).$in ?? []).includes(actual);
    }
    return actual === expected;
  });
}

function apply<T extends { _id: string }>(doc: T, update: Record<string, unknown>): T {
  const next = { ...doc } as Record<string, unknown>;
  for (const [key, value] of Object.entries((update['$set'] as Record<string, unknown>) ?? {})) next[key] = value;
  for (const key of Object.keys((update['$unset'] as Record<string, unknown>) ?? {})) delete next[key];
  return next as T;
}

function store(canWatch = false) {
  const nodes = new FakeCollection<NodeDoc>(canWatch);
  const tasks = new FakeCollection<TaskDoc>(canWatch);
  return { nodes, tasks, s: new MongoMeshStore({ nodes, tasks }) };
}

/* ---------------- writing ---------------- */

test('a released task really loses its holder — $set alone would not', async () => {
  // The bug this defends against: the queue *deletes* claimedBy when it hands
  // a task back. A plain {$set: task} writes the fields that are there and
  // leaves the deleted ones exactly where they were, so the task keeps looking
  // claimed by a laptop that shut down hours ago and is never run again.
  const { s, tasks } = store();
  const claimed: MeshTask = {
    id: 'task-1',
    title: 'build',
    payload: {},
    state: 'claimed',
    requires: ['shell'],
    urgent: false,
    priority: 0,
    createdAt: 1,
    updatedAt: 1,
    rev: 2,
    attempts: 1,
    maxAttempts: 3,
    claimedBy: 'laptop',
    leaseUntil: 999,
    checkpoint: { step: 'installed' },
  };
  await s.putTask(claimed);
  assert.equal(tasks.docs.get('task-1')?.claimedBy, 'laptop');

  const released: MeshTask = { ...claimed, state: 'pending', rev: 3 };
  delete released.claimedBy;
  delete released.leaseUntil;
  await s.putTask(released);

  const doc = tasks.docs.get('task-1');
  assert.equal(doc?.claimedBy, undefined);
  assert.equal(doc?.leaseUntil, undefined);
  assert.deepEqual(doc?.checkpoint, { step: 'installed' }, 'but progress is still not thrown away');
  assert.equal((await s.getTask('task-1'))?.state, 'pending');
});

test('every optional field the queue removes is one the store clears', () => {
  // If a field is ever deleted in the queue but missing from this list, it
  // silently survives in the database and nothing points at why.
  for (const field of ['notBefore', 'claimedBy', 'leaseUntil', 'checkpoint', 'result', 'error', 'waitingFor']) {
    assert.ok((OPTIONAL_TASK_FIELDS as readonly string[]).includes(field), `${field} must be cleared on write`);
  }
});

test('the id is the document key, and comes back as an id', async () => {
  const { s, tasks } = store();
  const mesh = new Mesh({ store: s, clock: new ManualClock(0) });
  const task = await mesh.enqueue({ title: 'a', requires: ['shell'] });
  assert.ok(tasks.docs.has(task.id), 'stored under _id, not a second copy of the id');
  assert.equal((await s.getTask(task.id))?.title, 'a');
});

/* ---------------- claiming ---------------- */

test('only one machine wins a claim, because the revision is in the filter', async () => {
  const { s } = store();
  const mesh = new Mesh({ store: s, clock: new ManualClock(0) });
  await mesh.register({ id: 'laptop', name: 'Laptop', kind: 'laptop', capabilities: ['shell'] });
  await mesh.register({ id: 'cloud', name: 'Cloud', kind: 'cloud', capabilities: ['shell'], priority: 100 });
  const task = await mesh.enqueue({ title: 'only once', requires: ['shell'] });

  const read = (await s.getTask(task.id))!;
  const first = await s.claim(task.id, read.rev, { ...read, state: 'claimed', claimedBy: 'laptop', rev: read.rev + 1 });
  const second = await s.claim(task.id, read.rev, { ...read, state: 'claimed', claimedBy: 'cloud', rev: read.rev + 1 });

  assert.equal(first, true);
  assert.equal(second, false, 'the loser is told, rather than quietly doing the same work');
  assert.equal((await s.getTask(task.id))?.claimedBy, 'laptop');
});

/* ---------------- reading ---------------- */

test('the queue asks for the live tasks, not the whole history', async () => {
  const { s, tasks } = store();
  const mesh = new Mesh({ store: s, clock: new ManualClock(0) });
  await mesh.register({ id: 'laptop', name: 'Laptop', kind: 'laptop', capabilities: ['shell'] });
  for (const title of ['a', 'b', 'c']) await mesh.enqueue({ title, requires: ['shell'] });
  const done = await mesh.enqueue({ title: 'old', requires: ['shell'] });
  await mesh.claimNext('laptop');
  await mesh.complete((await s.listTasks({ states: ['claimed'] }))[0]!.id, 'laptop');

  const live = await s.listTasks({ states: ['pending'] });
  assert.equal(live.length, 3);
  assert.deepEqual(live.map((task) => task.title), ['b', 'c', 'old'], 'oldest first, so nothing starves');
  assert.ok(tasks.docs.has(done.id), 'the finished one is still on record, just not in the way');
});

/* ---------------- live ---------------- */

test('a change stream delivers the task the moment it is written', () => {
  const { tasks } = store(true);
  const seen: string[] = [];
  const watch = watchTasks({ nodes: new FakeCollection<NodeDoc>(), tasks }, { onTask: (task) => seen.push(task.title) });

  assert.equal(watch.live, true);
  tasks.changeStream?.emit('change', { fullDocument: { _id: 'task-1', title: 'build the site' } });
  assert.deepEqual(seen, ['build the site']);
});

test('a database that cannot push changes is polled, and says so out loud', async () => {
  // A plain mongod with no replica set — which is what a local install gives
  // you — cannot open a change stream at all. Going quiet here would look
  // exactly like a broken queue.
  const { tasks } = store(false);
  const notices: string[] = [];
  const seen: string[] = [];
  let poll: (() => void) | undefined;

  tasks.docs.set('task-1', { _id: 'task-1', title: 'nightly', state: 'pending', rev: 1, createdAt: 1 } as TaskDoc);

  const watch = watchTasks(
    { nodes: new FakeCollection<NodeDoc>(), tasks },
    {
      onTask: (task) => seen.push(task.title),
      onNotice: (message) => notices.push(message),
      setIntervalFn: (handler) => {
        poll = handler;
        return 0 as unknown as NodeJS.Timeout;
      },
      clearIntervalFn: () => {},
    },
  );

  assert.equal(watch.live, false);
  assert.match(notices[0] ?? '', /cannot push changes|checking every/);

  poll?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['nightly']);

  // The same unchanged task is not reported over and over.
  poll?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['nightly']);
  await watch.close();
});

test('losing the live connection falls back instead of going silent', async () => {
  const { tasks } = store(true);
  const notices: string[] = [];
  const watch = watchTasks(
    { nodes: new FakeCollection<NodeDoc>(), tasks },
    {
      onTask: () => {},
      onNotice: (message) => notices.push(message),
      setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
      clearIntervalFn: () => {},
    },
  );

  tasks.changeStream?.emit('error', new Error('connection reset'));
  assert.equal(watch.live, false);
  assert.ok(notices.some((notice) => /connection reset/.test(notice)));
  assert.ok(notices.some((notice) => /checking every/.test(notice)), 'and the replacement is described, not assumed');
  await watch.close();
});
