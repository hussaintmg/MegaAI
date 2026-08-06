/**
 * The agent that lives on the laptop.
 *
 * It does four things, in this order, forever: look at the machine, tell the
 * mesh how much it can take, take that much, and keep the lease alive while it
 * works. Everything else in this file exists to make those four survive real
 * conditions — the lid closing, the machine getting hot, a reboot, two tasks
 * wanting the same folder, every coding agent running out of quota at 2am.
 *
 * The behaviour worth naming:
 *
 *   - **Nothing is ever abandoned.** A task interrupted by heat, a reboot or a
 *     quota wall goes back to `pending` with its progress and a sentence
 *     saying what it is waiting for. `park` hands back the attempt it took, so
 *     waiting never uses up a task's retries.
 *   - **The same node comes back.** Its id is on disk, so after a restart it
 *     re-registers as itself and releases the claims its dead process was
 *     holding, instead of leaving them stranded until the lease lapses.
 *   - **Two agents never share a file.** Several pieces of one project run at
 *     the same time — that is the point — but each declares the files it owns,
 *     and a task whose files are already held waits. A task that declares
 *     nothing owns the whole folder, because guessing is how two coding agents
 *     silently undo each other.
 */

import type { JsonObject, Timestamp } from '@megaai/types';
import type { Capability, Gear, Mesh, MeshTask, NodeKind, NodeRecord } from '@megaai/mesh';
import { type Clock, systemClock } from '@megaai/utils';
import type { GuardDecision, ResourceGuard } from './guard.js';
import type { MachineSample } from './machine.js';
import type { StateFile } from './state.js';

export interface TaskContext {
  task: MeshTask;
  /** Aborted when the machine has to stop, or the agent is shutting down. */
  signal: AbortSignal;
  /** Write progress down. Also renews the lease. */
  checkpoint(patch: JsonObject): Promise<void>;
  log(message: string): void;
}

export type TaskOutcome =
  | { kind: 'done'; result?: JsonObject }
  | { kind: 'failed'; error: string }
  /** Not done, not broken — waiting. Costs no attempt. */
  | { kind: 'parked'; until: Timestamp; reason: string };

export type TaskHandler = (context: TaskContext) => Promise<TaskOutcome>;

export interface NodeAgentOptions {
  mesh: Mesh;
  name: string;
  kind?: NodeKind;
  capabilities: Capability[];
  guard: ResourceGuard;
  sample: () => MachineSample | Promise<MachineSample>;
  /** By `payload.kind`; `'*'` catches anything unmatched. */
  handlers: Record<string, TaskHandler>;
  state?: StateFile;
  nodeId?: string;
  clock?: Clock;
  log?: (line: string) => void;
  /**
   * What a task must hold exclusively while it runs — the project folder, or
   * the individual files it owns. Tasks whose keys collide never overlap.
   */
  lockKeyFor?: (task: MeshTask) => string | string[] | undefined;
  /**
   * Whether a held key and a wanted key mean the same place.
   *
   * Exact equality by default. Path-shaped keys need more than that: a task
   * holding `app/api` and one wanting `app/api/cars/route.ts` are in the same
   * file, and only the caller knows its keys are paths.
   */
  lockConflict?: (held: string, wanted: string) => boolean;
  /**
   * A task that does not use the machine, so it never waits for a slot.
   *
   * The supervisor is the case this exists for: it reads the queue, writes
   * some tasks and parks, in well under a second. Making it queue behind two
   * six-hour builds means nothing new is ever handed out while the machine is
   * busy — which is exactly when handing work out matters.
   */
  lightweight?: (task: MeshTask) => boolean;
  /**
   * How many tasks this machine can really run, beyond what heat and CPU say.
   *
   * The coding agents are the real limit: three installed, two out of quota
   * and one broken means one, whatever the guard thinks of the temperature.
   */
  capacity?: () => number | undefined;
  /** Gap between rounds when `start()` is driving. */
  tickMs?: number;
  /** Lease renewal interval while a task runs. 0 disables it (tests). */
  renewMs?: number;
  /** How long something set aside by heat or a busy folder waits. */
  retryLaterMs?: number;
  priority?: number;
}

interface RunningTask {
  task: MeshTask;
  controller: AbortController;
  lockKeys: string[];
  /** Does not count against the machine's concurrency. */
  light: boolean;
  renew: NodeJS.Timeout | undefined;
  finished: Promise<void>;
}

export class NodeAgent {
  private readonly mesh: Mesh;
  private readonly clock: Clock;
  private readonly log: (line: string) => void;
  private readonly running = new Map<string, RunningTask>();
  private readonly locks: string[] = [];
  private readonly tickMs: number;
  private readonly renewMs: number;
  private readonly retryLaterMs: number;
  private id = '';
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private lastGear: Gear | undefined;

  constructor(private readonly options: NodeAgentOptions) {
    this.mesh = options.mesh;
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? (() => {});
    this.tickMs = options.tickMs ?? 5_000;
    this.renewMs = options.renewMs ?? 20_000;
    this.retryLaterMs = options.retryLaterMs ?? 5 * 60_000;
  }

  get nodeId(): string {
    return this.id;
  }

  get runningIds(): string[] {
    return [...this.running.keys()];
  }

  /** Tasks currently using the machine — the supervisor is not one of them. */
  private get heavyCount(): number {
    let count = 0;
    for (const running of this.running.values()) if (!running.light) count += 1;
    return count;
  }

  private conflicts(wanted: string): string | undefined {
    const collide = this.options.lockConflict ?? ((held: string, want: string) => held === want);
    return this.locks.find((held) => collide(held, wanted));
  }

  /** Join the mesh, clean up after the previous run, and start working. */
  async start(): Promise<NodeRecord> {
    const persisted = await this.options.state?.load();
    this.id = this.options.nodeId ?? persisted?.nodeId ?? `node-${this.options.name.toLowerCase().replace(/\s+/g, '-')}`;
    // Written on every start, not only when it changes. `load()` invents an id
    // when there is no file yet and does not save it, so "only write when it
    // differs" quietly meant *never* — every restart joined as a brand new
    // machine, orphaning whatever the last one was holding until its lease
    // lapsed. Costs one small write per start; buys the identity everything
    // else in this file assumes.
    await this.options.state?.save({ nodeId: this.id });

    const node = await this.mesh.register({
      id: this.id,
      name: this.options.name,
      kind: this.options.kind ?? 'laptop',
      capabilities: this.options.capabilities,
      ...(this.options.priority !== undefined ? { priority: this.options.priority } : {}),
    });

    await this.releaseStaleClaims();
    await this.tick();

    if (this.tickMs > 0) {
      // Not unref'd — this loop *is* the program. If nothing else is holding
      // the event loop open, the agent should still be running.
      this.timer = setInterval(() => {
        void this.tick().catch((error: unknown) => this.log(`round failed: ${(error as Error).message}`));
      }, this.tickMs);
    }
    return node;
  }

  /**
   * Hand back what the last run of this process was holding.
   *
   * Without this, a crash leaves tasks claimed by a node that no longer exists
   * until their leases time out — minutes of a machine sitting idle next to
   * work it is allowed to do. The lease is the safety net for a node that
   * never comes back; this is the fast path for one that does.
   */
  private async releaseStaleClaims(): Promise<void> {
    for (const task of await this.mesh.store.listTasks({ states: ['claimed', 'running'] })) {
      if (task.claimedBy !== this.id) continue;
      if (this.running.has(task.id)) continue;
      await this.mesh.park(task.id, this.id, this.clock.now(), 'picked up again after this machine restarted');
      this.log(`recovered "${task.title}" from the previous run`);
    }
  }

  /** One round: look, report, take work. */
  async tick(): Promise<GuardDecision> {
    const sample = await this.options.sample();
    const decision = this.options.guard.decide(sample);
    // Heat and CPU say how much this machine *could* take; the coding agents
    // say how much it can actually do. Whichever is smaller is the truth, and
    // reporting the larger one gets tasks claimed only to be parked again.
    const capacity = this.options.capacity?.();
    const limit = Math.max(1, Math.min(decision.concurrency, capacity ?? Number.POSITIVE_INFINITY));

    await this.mesh.heartbeat(this.id, {
      gear: decision.gear,
      concurrency: limit,
      health: healthOf(sample),
    });
    if (decision.gear !== this.lastGear) {
      this.log(`${decision.gear}: ${decision.reason}`);
      this.lastGear = decision.gear;
    }

    if (decision.gear === 'stop') {
      this.pauseRunning(decision.reason);
      return decision;
    }
    if (this.stopping) return decision;

    // Bounded, because a claim that ends in a park still costs a read and a
    // write. Eight tasks in one project folder used to be claimed and parked
    // one after another every single tick — a lot of noise and churn to
    // rediscover that the folder is busy.
    let claims = 0;
    while (this.heavyCount < limit && claims < limit * 2) {
      const task = await this.mesh.claimNext(this.id);
      if (!task) break;
      claims += 1;
      await this.begin(task);
    }

    // Full up, but the work that decides what happens next costs this machine
    // nothing to run. Left behind the queue it would only be picked up when
    // something finished — so a busy machine would stop handing out work at
    // exactly the moment there is most of it to hand out.
    const light = this.options.lightweight;
    if (light && this.heavyCount >= limit) {
      for (let taken = 0; taken < 2; taken += 1) {
        const task = await this.mesh.claimNext(this.id, light);
        if (!task) break;
        await this.begin(task);
      }
    }
    return decision;
  }

  /** Stop what is in flight; the queue keeps it. */
  private pauseRunning(reason: string): void {
    for (const running of this.running.values()) {
      if (!running.controller.signal.aborted) {
        this.log(`pausing "${running.task.title}": ${reason}`);
        running.controller.abort(new Error(reason));
      }
    }
  }

  private async begin(task: MeshTask): Promise<void> {
    const kind = typeof task.payload['kind'] === 'string' ? task.payload['kind'] : '';
    const handler = this.options.handlers[kind] ?? this.options.handlers['*'];
    if (!handler) {
      await this.mesh.fail(
        task.id,
        this.id,
        `this machine has no handler for "${kind || 'a task with no kind'}" — it needs one registered before it can run`,
      );
      return;
    }

    const wanted = this.options.lockKeyFor?.(task);
    const lockKeys = wanted === undefined ? [] : Array.isArray(wanted) ? wanted : [wanted];
    const taken = lockKeys.map((key) => this.conflicts(key)).find((held): held is string => held !== undefined);
    if (taken !== undefined) {
      await this.mesh.park(
        task.id,
        this.id,
        this.clock.now() + Math.min(this.retryLaterMs, 60_000),
        `another task is already working in ${taken} — two agents in one file undo each other`,
      );
      return;
    }
    this.locks.push(...lockKeys);

    const controller = new AbortController();
    const running: RunningTask = {
      task,
      controller,
      lockKeys,
      light: this.options.lightweight?.(task) === true,
      renew: undefined,
      finished: Promise.resolve(),
    };
    if (this.renewMs > 0) {
      running.renew = setInterval(() => {
        void this.mesh.progress(task.id, this.id).catch(() => {});
      }, this.renewMs);
    }
    this.running.set(task.id, running);
    running.finished = this.execute(handler, running);
  }

  private async execute(handler: TaskHandler, running: RunningTask): Promise<void> {
    const { task, controller } = running;
    const context: TaskContext = {
      task,
      signal: controller.signal,
      checkpoint: async (patch) => {
        await this.mesh.progress(task.id, this.id, patch);
      },
      log: (message) => this.log(`[${task.title}] ${message}`),
    };

    let outcome: TaskOutcome;
    try {
      outcome = await handler(context);
    } catch (error) {
      const message = (error as Error).message || String(error);
      outcome = controller.signal.aborted
        ? { kind: 'parked', until: this.clock.now() + this.retryLaterMs, reason: abortReason(controller, message) }
        : { kind: 'failed', error: message };
    }

    // A handler that returns normally after being aborted was still cut short;
    // recording that as success would be a lie the next run pays for.
    if (controller.signal.aborted && outcome.kind === 'done') {
      outcome = {
        kind: 'parked',
        until: this.clock.now() + this.retryLaterMs,
        reason: abortReason(controller, 'the machine had to stop'),
      };
    }

    try {
      if (outcome.kind === 'done') {
        await this.mesh.complete(task.id, this.id, outcome.result ?? {});
      } else if (outcome.kind === 'parked') {
        await this.mesh.park(task.id, this.id, outcome.until, outcome.reason);
      } else {
        await this.mesh.fail(task.id, this.id, outcome.error);
      }
    } catch (error) {
      // Losing the task (a lapsed lease, a reclaim) is not worth crashing over
      // — the queue has already moved it on.
      this.log(`could not report on "${task.title}": ${(error as Error).message}`);
    } finally {
      if (running.renew) clearInterval(running.renew);
      for (const key of running.lockKeys) {
        // Only one occurrence: two tasks may legitimately hold the same key
        // when the conflict rule is looser than equality.
        const at = this.locks.indexOf(key);
        if (at >= 0) this.locks.splice(at, 1);
      }
      this.running.delete(task.id);
    }
  }

  /** Wait for everything in flight. */
  async drain(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running.values()].map((running) => running.finished));
    }
  }

  /** Shut down cleanly: stop taking work, put back what is in flight. */
  async stop(reason = 'this machine is shutting down'): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.pauseRunning(reason);
    await this.drain();
  }
}

function abortReason(controller: AbortController, fallback: string): string {
  const cause = controller.signal.reason as unknown;
  if (cause instanceof Error && cause.message) return cause.message;
  return fallback;
}

function healthOf(sample: MachineSample): NonNullable<NodeRecord['health']> {
  return {
    cpuLoad: sample.cpuLoad,
    memUsedPct: sample.memUsedPct,
    ...(sample.temperatureC !== undefined ? { temperatureC: sample.temperatureC } : {}),
    ...(sample.batteryPct !== undefined ? { batteryPct: sample.batteryPct } : {}),
    ...(sample.charging !== undefined ? { charging: sample.charging } : {}),
  };
}
