/**
 * AgentRuntime — spawns, supervises, heartbeats, recovers and kills agent
 * instances. Implementations declare *what* an agent does; the runtime owns
 * *that it keeps doing it*: concurrency limits, restart-on-failure and
 * lifecycle events for the dashboard.
 */

import type { AgentInstanceInfo, AgentRunResult, AgentState, TaskRecord } from '@megaai/types';
import { Events, MegaError } from '@megaai/types';
import { type Clock, Deferred, newId, Semaphore, systemClock } from '@megaai/utils';
import type { AgentContext, AgentImplementation } from '@megaai/contracts';
import type { EventBus } from '@megaai/events';
import type { Logger } from '@megaai/logger';

export interface PreparedContext {
  ctx: AgentContext;
  dispose(): void | Promise<void>;
}

/** Factory the orchestrator injects: wires sessions, tools, memory, prompts. */
export type CreateAgentContext = (
  task: TaskRecord,
  implementation: AgentImplementation,
  instance: AgentInstanceInfo,
  signal: AbortSignal,
) => Promise<PreparedContext>;

export interface AgentRuntimeOptions {
  createContext: CreateAgentContext;
  bus?: EventBus;
  logger?: Logger;
  clock?: Clock;
  heartbeatIntervalMs?: number;
  /** How many times a failed run is retried with a fresh context. */
  maxRestarts?: number;
  maxConcurrent?: number;
}

interface ManagedInstance {
  info: AgentInstanceInfo;
  abort: AbortController;
  pauseGate?: Deferred<void>;
}

const MAX_KEPT_INSTANCES = 200;

export class AgentRuntime {
  readonly name = 'agents';
  private readonly implementations = new Map<string, AgentImplementation>();
  private readonly instances = new Map<string, ManagedInstance>();
  private readonly semaphore: Semaphore;
  private readonly options: AgentRuntimeOptions;
  private readonly clock: Clock;

  constructor(options: AgentRuntimeOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.semaphore = new Semaphore(options.maxConcurrent ?? 4);
  }

  register(implementation: AgentImplementation): void {
    const kind = implementation.descriptor.kind;
    if (this.implementations.has(kind)) {
      throw new MegaError('ALREADY_EXISTS', `Agent kind "${kind}" already registered`);
    }
    this.implementations.set(kind, implementation);
  }

  kinds(): string[] {
    return [...this.implementations.keys()];
  }

  implementationFor(kind: string): AgentImplementation | undefined {
    return this.implementations.get(kind);
  }

  list(): AgentInstanceInfo[] {
    return [...this.instances.values()].map((managed) => ({ ...managed.info }));
  }

  private setState(managed: ManagedInstance, state: AgentState): void {
    managed.info.state = state;
    this.options.bus?.emit(
      Events.AgentStateChanged,
      { instanceId: managed.info.id, kind: managed.info.kind, state },
      'agents',
    );
  }

  pause(instanceId: string): void {
    const managed = this.instances.get(instanceId);
    if (!managed || managed.info.state !== 'running') return;
    managed.pauseGate = new Deferred<void>();
    this.setState(managed, 'paused');
  }

  resume(instanceId: string): void {
    const managed = this.instances.get(instanceId);
    if (!managed || managed.info.state !== 'paused') return;
    this.setState(managed, 'running');
    managed.pauseGate?.resolve();
    managed.pauseGate = undefined;
  }

  kill(instanceId: string): void {
    const managed = this.instances.get(instanceId);
    if (!managed) return;
    managed.abort.abort();
    managed.pauseGate?.resolve();
    this.setState(managed, 'killed');
  }

  private prune(): void {
    if (this.instances.size <= MAX_KEPT_INSTANCES) return;
    const finished = [...this.instances.entries()].filter(
      ([, managed]) => managed.info.state === 'completed' || managed.info.state === 'failed' || managed.info.state === 'killed',
    );
    for (const [id] of finished.slice(0, this.instances.size - MAX_KEPT_INSTANCES)) {
      this.instances.delete(id);
    }
  }

  /** Run one task with the agent registered for its kind. */
  async runTask(task: TaskRecord): Promise<AgentRunResult> {
    const implementation = this.implementations.get(task.agentKind);
    if (!implementation) {
      throw new MegaError('NOT_FOUND', `No agent registered for kind "${task.agentKind}"`, {
        available: this.kinds(),
      });
    }

    return this.semaphore.run(async () => {
      const now = this.clock.now();
      const managed: ManagedInstance = {
        info: {
          id: newId('agt'),
          kind: task.agentKind,
          state: 'spawned',
          taskId: task.id,
          spawnedAt: now,
          lastHeartbeatAt: now,
          restarts: 0,
        },
        abort: new AbortController(),
      };
      this.instances.set(managed.info.id, managed);
      this.prune();
      this.options.bus?.emit(Events.AgentSpawned, { instance: { ...managed.info } }, 'agents');
      this.options.logger?.debug('agent spawned', { kind: task.agentKind, task: task.title });

      const heartbeat = setInterval(() => {
        managed.info.lastHeartbeatAt = this.clock.now();
        this.options.bus?.emit(
          Events.AgentHeartbeat,
          { instanceId: managed.info.id, kind: managed.info.kind, at: managed.info.lastHeartbeatAt },
          'agents',
        );
      }, this.options.heartbeatIntervalMs ?? 1_000);
      heartbeat.unref?.();

      const maxRestarts = this.options.maxRestarts ?? 1;
      let lastResult: AgentRunResult | undefined;
      let lastError: string | undefined;

      try {
        this.setState(managed, 'running');
        for (let attempt = 0; attempt <= maxRestarts; attempt += 1) {
          if (managed.abort.signal.aborted) break;
          if (managed.pauseGate) await managed.pauseGate.promise;
          if (attempt > 0) {
            managed.info.restarts += 1;
            this.options.bus?.emit(
              Events.AgentRecovered,
              { instanceId: managed.info.id, kind: managed.info.kind, attempt },
              'agents',
            );
            this.options.logger?.info('agent restarting after failure', {
              kind: managed.info.kind,
              attempt,
              lastError: lastError ?? null,
            });
          }
          try {
            const prepared = await this.options.createContext(
              task,
              implementation,
              managed.info,
              managed.abort.signal,
            );
            try {
              const result = await implementation.run(task, prepared.ctx);
              lastResult = result;
              if (result.ok) {
                this.setState(managed, 'completed');
                return result;
              }
              lastError = result.error ?? 'agent reported failure';
            } finally {
              await prepared.dispose();
            }
          } catch (err) {
            lastError = MegaError.from(err).message;
          }
        }
        this.setState(managed, managed.abort.signal.aborted ? 'killed' : 'failed');
        return (
          lastResult ?? {
            ok: false,
            summary: `Agent "${task.agentKind}" failed: ${lastError ?? 'unknown error'}`,
            actions: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            error: lastError,
          }
        );
      } finally {
        clearInterval(heartbeat);
      }
    });
  }
}
