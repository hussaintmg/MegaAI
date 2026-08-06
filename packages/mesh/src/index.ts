/**
 * @megaai/mesh — one queue across every machine you own.
 *
 * A node is your laptop, your phone or the cloud. They run the same engine and
 * differ only in what they can do and how much they are preferred. Work is
 * offered to the best node that is awake and able; when none is, it waits.
 *
 * Two rules the rest of the system leans on:
 *
 *   1. **Absence is never failure.** A task whose only capable node is asleep
 *      is `pending`, not `failed`. "The laptop is off" is a status, not an
 *      error, and the work runs the moment the laptop comes back.
 *
 *   2. **Ownership expires.** A node claims a task with a *lease* it must keep
 *      renewing. Close the lid, kill Termux, hit a serverless timeout — the
 *      lease lapses and the task returns to the queue with its progress kept.
 *      Nothing has to notice the crash for recovery to happen.
 *
 * The store is an interface so this is testable without a database; MongoDB is
 * one adapter, and its change streams are what make the mesh live rather than
 * polled.
 */

import type { JsonObject, Timestamp } from '@megaai/types';
import { MegaError } from '@megaai/types';
import { type Clock, newId, systemClock } from '@megaai/utils';

/* ------------------------------------------------------------------ *
 * Nodes
 * ------------------------------------------------------------------ */

/** What a node can do. Tasks ask for these; routing matches them. */
export type Capability =
  | 'shell'
  | 'browser'
  | 'gpu'
  | 'always-on'
  | 'sms'
  | 'whatsapp'
  | 'camera'
  | 'location'
  | 'email';

export type NodeKind = 'laptop' | 'phone' | 'cloud';

/** How busy a node is willing to be right now. */
export type Gear = 'full' | 'gentle' | 'stop';

export interface NodeRecord {
  id: string;
  name: string;
  kind: NodeKind;
  capabilities: Capability[];
  /** Higher wins. Laptop 100, phone 40, cloud 10 by default. */
  priority: number;
  gear: Gear;
  /** How many tasks it will run at once in its current gear. */
  concurrency: number;
  lastSeen: Timestamp;
  /** Live vitals, for the dashboard and for the resource guard. */
  health?: { cpuLoad?: number; memUsedPct?: number; temperatureC?: number; batteryPct?: number; charging?: boolean };
  meta?: JsonObject;
}

export const DEFAULT_PRIORITY: Record<NodeKind, number> = { laptop: 100, phone: 40, cloud: 10 };

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

export type MeshTaskState = 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface MeshTask {
  id: string;
  /** What to do — a goal, or a step of one. */
  title: string;
  payload: JsonObject;
  state: MeshTaskState;
  /** Every one of these must be present on the node that runs it. */
  requires: Capability[];
  /** Urgent work interrupts you; normal work waits until you are idle. */
  urgent: boolean;
  priority: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /**
   * Bumped on every write, and what a claim is checked against.
   *
   * `updatedAt` cannot do this job: two nodes reaching for the same task in
   * the same millisecond both read the same timestamp and both write it back,
   * so the compare-and-set passes twice and the task runs twice. A counter
   * cannot collide.
   */
  rev: number;
  /** Not offered to anyone before this — the backoff after a failure. */
  notBefore?: Timestamp;
  /** Who holds it, and until when. */
  claimedBy?: string;
  leaseUntil?: Timestamp;
  attempts: number;
  maxAttempts: number;
  /**
   * Progress kept across crashes, so resuming does not redo finished work.
   * The agent decides what goes in here; the queue only preserves it.
   */
  checkpoint?: JsonObject;
  result?: JsonObject;
  error?: string;
  /** Why it is still waiting, when it is — never left to be guessed. */
  waitingFor?: string;
}

export interface EnqueueOptions {
  title: string;
  payload?: JsonObject;
  requires?: Capability[];
  urgent?: boolean;
  priority?: number;
  maxAttempts?: number;
  notBefore?: Timestamp;
}

/* ------------------------------------------------------------------ *
 * Storage seam
 * ------------------------------------------------------------------ */

export interface MeshStore {
  putNode(node: NodeRecord): Promise<void>;
  getNode(id: string): Promise<NodeRecord | undefined>;
  listNodes(): Promise<NodeRecord[]>;
  putTask(task: MeshTask): Promise<void>;
  getTask(id: string): Promise<MeshTask | undefined>;
  listTasks(): Promise<MeshTask[]>;
  /**
   * Take the task only if nobody has touched it since we read it.
   * Two nodes reaching for the same task is the normal case, not the rare one;
   * without this one of them silently does the other's work.
   */
  claim(taskId: string, expectRev: number, next: MeshTask): Promise<boolean>;
}

/** In-memory store — the reference implementation, and what tests run on. */
export class MemoryMeshStore implements MeshStore {
  private readonly nodes = new Map<string, NodeRecord>();
  private readonly tasks = new Map<string, MeshTask>();

  async putNode(node: NodeRecord): Promise<void> {
    this.nodes.set(node.id, { ...node });
  }
  async getNode(id: string): Promise<NodeRecord | undefined> {
    const node = this.nodes.get(id);
    return node ? { ...node } : undefined;
  }
  async listNodes(): Promise<NodeRecord[]> {
    return [...this.nodes.values()].map((node) => ({ ...node }));
  }
  async putTask(task: MeshTask): Promise<void> {
    this.tasks.set(task.id, { ...task });
  }
  async getTask(id: string): Promise<MeshTask | undefined> {
    const task = this.tasks.get(id);
    return task ? { ...task } : undefined;
  }
  async listTasks(): Promise<MeshTask[]> {
    return [...this.tasks.values()].map((task) => ({ ...task }));
  }
  async claim(taskId: string, expectRev: number, next: MeshTask): Promise<boolean> {
    const current = this.tasks.get(taskId);
    if (!current || current.rev !== expectRev) return false;
    this.tasks.set(taskId, { ...next });
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * The mesh
 * ------------------------------------------------------------------ */

export interface MeshEvent {
  at: Timestamp;
  type: string;
  nodeId?: string;
  taskId?: string;
  message: string;
}

export interface MeshOptions {
  store?: MeshStore;
  clock?: Clock;
  /** A node unheard from for this long is treated as offline. */
  offlineAfterMs?: number;
  /** How long a claim is good for before it must be renewed. */
  leaseMs?: number;
  /** Backoff before a failed task is offered again. */
  retryBackoffMs?: number;
  onEvent?: (event: MeshEvent) => void;
}

export class Mesh {
  readonly store: MeshStore;
  private readonly clock: Clock;
  private readonly offlineAfterMs: number;
  private readonly leaseMs: number;
  private readonly retryBackoffMs: number;
  private readonly onEvent?: (event: MeshEvent) => void;

  constructor(options: MeshOptions = {}) {
    this.store = options.store ?? new MemoryMeshStore();
    this.clock = options.clock ?? systemClock;
    this.offlineAfterMs = options.offlineAfterMs ?? 45_000;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.retryBackoffMs = options.retryBackoffMs ?? 30_000;
    this.onEvent = options.onEvent;
  }

  private emit(type: string, message: string, ids: { nodeId?: string; taskId?: string } = {}): void {
    this.onEvent?.({ at: this.clock.now(), type, message, ...ids });
  }

  /* ---------------- nodes ---------------- */

  /** Announce a node, or refresh what it can do. Idempotent. */
  async register(input: {
    id?: string;
    name: string;
    kind: NodeKind;
    capabilities: Capability[];
    priority?: number;
    concurrency?: number;
    meta?: JsonObject;
  }): Promise<NodeRecord> {
    const id = input.id ?? newId('node');
    const existing = await this.store.getNode(id);
    const node: NodeRecord = {
      id,
      name: input.name,
      kind: input.kind,
      capabilities: [...new Set(input.capabilities)],
      priority: input.priority ?? DEFAULT_PRIORITY[input.kind],
      gear: existing?.gear ?? 'full',
      concurrency: input.concurrency ?? (input.kind === 'laptop' ? 3 : 1),
      lastSeen: this.clock.now(),
      ...(existing?.health ? { health: existing.health } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    };
    await this.store.putNode(node);
    this.emit(existing ? 'node.updated' : 'node.joined', `${node.name} (${node.kind}) is online`, { nodeId: id });
    return node;
  }

  /**
   * Still here, and this is how loaded I am.
   *
   * The gear is the node's own decision — the laptop lowers it when you start
   * typing or when it gets hot — and the mesh simply respects it.
   */
  async heartbeat(
    nodeId: string,
    update: { gear?: Gear; concurrency?: number; health?: NodeRecord['health'] } = {},
  ): Promise<NodeRecord> {
    const node = await this.store.getNode(nodeId);
    if (!node) throw new MegaError('NOT_FOUND', `Unknown node "${nodeId}"`);
    const next: NodeRecord = {
      ...node,
      lastSeen: this.clock.now(),
      ...(update.gear ? { gear: update.gear } : {}),
      ...(update.concurrency !== undefined ? { concurrency: update.concurrency } : {}),
      ...(update.health ? { health: update.health } : {}),
    };
    await this.store.putNode(next);
    if (update.gear && update.gear !== node.gear) {
      this.emit('node.gear', `${node.name} switched to "${update.gear}"`, { nodeId });
    }
    return next;
  }

  isOnline(node: NodeRecord): boolean {
    return this.clock.now() - node.lastSeen <= this.offlineAfterMs;
  }

  async onlineNodes(): Promise<NodeRecord[]> {
    return (await this.store.listNodes()).filter((node) => this.isOnline(node));
  }

  /* ---------------- tasks ---------------- */

  async enqueue(options: EnqueueOptions): Promise<MeshTask> {
    const title = options.title.trim();
    if (!title) throw new MegaError('INVALID_INPUT', 'a task needs a title');
    const now = this.clock.now();
    const task: MeshTask = {
      id: newId('mtask'),
      title,
      payload: options.payload ?? {},
      state: 'pending',
      requires: [...new Set(options.requires ?? [])],
      urgent: options.urgent === true,
      priority: options.priority ?? 0,
      createdAt: now,
      updatedAt: now,
      rev: 1,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
      ...(options.notBefore ? { notBefore: options.notBefore } : {}),
    };
    await this.store.putTask(task);
    this.emit('task.queued', `Queued "${title}"`, { taskId: task.id });
    return task;
  }

  /** Can this node run this task at all? */
  private capable(node: NodeRecord, task: MeshTask): boolean {
    return task.requires.every((capability) => node.capabilities.includes(capability));
  }

  /**
   * Release the tasks whose holder went quiet.
   *
   * Called before every claim, so a crash never needs to be detected by
   * anything else: the next node to ask for work does the recovering.
   */
  async reclaimExpired(): Promise<MeshTask[]> {
    const now = this.clock.now();
    const reclaimed: MeshTask[] = [];
    for (const task of await this.store.listTasks()) {
      if (task.state !== 'claimed' && task.state !== 'running') continue;
      if ((task.leaseUntil ?? 0) > now) continue;
      const next: MeshTask = {
        ...task,
        state: 'pending',
        updatedAt: now,
        rev: task.rev + 1,
        waitingFor: `the lease held by ${task.claimedBy ?? 'a node'} expired — picking it up again`,
      };
      delete next.claimedBy;
      delete next.leaseUntil;
      if (await this.store.claim(task.id, task.rev, next)) {
        reclaimed.push(next);
        this.emit(
          'task.reclaimed',
          `"${task.title}" was released — its node stopped reporting. Progress is kept.`,
          { taskId: task.id },
        );
      }
    }
    return reclaimed;
  }

  /**
   * Offer a node the best task it may run, and lease it.
   *
   * A node only ever gets work it is *most* entitled to: a higher-priority node
   * being online means this one waits, which is what makes "laptop first" real
   * rather than a preference the cloud ignores because it asked first.
   */
  async claimNext(nodeId: string): Promise<MeshTask | undefined> {
    await this.reclaimExpired();
    const node = await this.store.getNode(nodeId);
    if (!node) throw new MegaError('NOT_FOUND', `Unknown node "${nodeId}"`);
    if (node.gear === 'stop') return undefined;

    const now = this.clock.now();
    const others = (await this.onlineNodes()).filter((other) => other.id !== nodeId);
    const tasks = await this.store.listTasks();

    const running = tasks.filter((task) => task.claimedBy === nodeId && (task.state === 'claimed' || task.state === 'running'));
    if (running.length >= node.concurrency) return undefined;

    const eligible = tasks
      .filter((task) => task.state === 'pending')
      .filter((task) => (task.notBefore ?? 0) <= now)
      .filter((task) => this.capable(node, task))
      // In gentle gear the node takes urgent work only — that is how the
      // laptop stops competing with you for its own CPU.
      .filter((task) => node.gear === 'full' || task.urgent)
      // Someone better is awake and can take it; leave it for them.
      .filter((task) => !others.some((other) => other.priority > node.priority && other.gear !== 'stop' && this.capable(other, task)))
      .sort(
        (a, b) =>
          Number(b.urgent) - Number(a.urgent) || b.priority - a.priority || a.createdAt - b.createdAt,
      );

    for (const task of eligible) {
      const next: MeshTask = {
        ...task,
        state: 'claimed',
        claimedBy: nodeId,
        leaseUntil: now + this.leaseMs,
        attempts: task.attempts + 1,
        updatedAt: now,
        rev: task.rev + 1,
      };
      delete next.waitingFor;
      if (await this.store.claim(task.id, task.rev, next)) {
        this.emit('task.claimed', `${node.name} took "${task.title}"`, { nodeId, taskId: task.id });
        return next;
      }
      // Someone else got there first; try the next one.
    }
    return undefined;
  }

  /** Renew the lease and record progress. Called while the work runs. */
  async progress(taskId: string, nodeId: string, checkpoint?: JsonObject): Promise<MeshTask> {
    const task = await this.requireHeld(taskId, nodeId);
    const next: MeshTask = {
      ...task,
      state: 'running',
      leaseUntil: this.clock.now() + this.leaseMs,
      updatedAt: this.clock.now(),
      rev: task.rev + 1,
      ...(checkpoint ? { checkpoint: { ...(task.checkpoint ?? {}), ...checkpoint } } : {}),
    };
    await this.store.putTask(next);
    return next;
  }

  async complete(taskId: string, nodeId: string, result?: JsonObject): Promise<MeshTask> {
    const task = await this.requireHeld(taskId, nodeId);
    const next: MeshTask = {
      ...task,
      state: 'completed',
      updatedAt: this.clock.now(),
      rev: task.rev + 1,
      ...(result ? { result } : {}),
    };
    delete next.leaseUntil;
    delete next.waitingFor;
    await this.store.putTask(next);
    this.emit('task.completed', `"${task.title}" is done`, { nodeId, taskId });
    return next;
  }

  /**
   * Report a failure — and, while attempts remain, put it back rather than
   * ending it. Panicking at the first error is what loses a night's work.
   */
  async fail(taskId: string, nodeId: string, error: string): Promise<MeshTask> {
    const task = await this.requireHeld(taskId, nodeId);
    const now = this.clock.now();
    const exhausted = task.attempts >= task.maxAttempts;
    const next: MeshTask = {
      ...task,
      state: exhausted ? 'failed' : 'pending',
      error,
      updatedAt: now,
      rev: task.rev + 1,
      ...(exhausted ? {} : { notBefore: now + this.retryBackoffMs * task.attempts, waitingFor: `retrying after: ${error}` }),
    };
    delete next.claimedBy;
    delete next.leaseUntil;
    await this.store.putTask(next);
    this.emit(
      exhausted ? 'task.failed' : 'task.retry',
      exhausted
        ? `"${task.title}" failed after ${task.attempts} attempt(s): ${error}`
        : `"${task.title}" will be retried (attempt ${task.attempts} of ${task.maxAttempts}): ${error}`,
      { nodeId, taskId },
    );
    return next;
  }

  private async requireHeld(taskId: string, nodeId: string): Promise<MeshTask> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new MegaError('NOT_FOUND', `Unknown task "${taskId}"`);
    if (task.claimedBy !== nodeId) {
      throw new MegaError('PERMISSION_DENIED', `"${task.title}" is not held by ${nodeId}`);
    }
    return task;
  }

  /* ---------------- visibility ---------------- */

  /**
   * Why a pending task has not run yet, in words.
   *
   * The point of the whole design is that waiting is normal — but silent
   * waiting is indistinguishable from being broken, so it is always explained.
   */
  async explainWait(taskId: string): Promise<string | undefined> {
    const task = await this.store.getTask(taskId);
    if (!task || task.state !== 'pending') return undefined;
    const now = this.clock.now();
    if ((task.notBefore ?? 0) > now) {
      return `retrying in ${Math.ceil(((task.notBefore ?? now) - now) / 1000)}s after: ${task.error ?? 'a failure'}`;
    }
    const nodes = await this.store.listNodes();
    const capable = nodes.filter((node) => this.capable(node, task));
    if (capable.length === 0) {
      return `no node can run this — it needs ${task.requires.join(', ') || 'nothing in particular'}, and none is registered with that`;
    }
    const online = capable.filter((node) => this.isOnline(node));
    if (online.length === 0) {
      const names = capable.map((node) => node.name).join(', ');
      return `waiting for ${names} to come online — this needs ${task.requires.join(', ')}`;
    }
    if (online.every((node) => node.gear === 'stop')) {
      return `every capable node is paused (${online.map((n) => n.name).join(', ')})`;
    }
    if (!task.urgent && online.every((node) => node.gear === 'gentle')) {
      return 'deferred while you are using the machine — it will run when you are idle';
    }
    return 'queued, waiting for a free slot';
  }

  /** Everything the dashboard shows at a glance. */
  async snapshot(): Promise<{
    nodes: Array<NodeRecord & { online: boolean }>;
    tasks: MeshTask[];
    counts: Record<MeshTaskState, number>;
  }> {
    const nodes = (await this.store.listNodes()).map((node) => ({ ...node, online: this.isOnline(node) }));
    const tasks = await this.store.listTasks();
    const counts: Record<MeshTaskState, number> = {
      pending: 0,
      claimed: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const task of tasks) counts[task.state] += 1;
    return { nodes, tasks, counts };
  }
}
