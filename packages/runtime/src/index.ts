/**
 * @megaai/runtime — MegaAI's operating system kernel.
 *
 * A service container (dependency injection + ordered lifecycle), health
 * monitoring, a metrics registry and a lightweight interval scheduler. Every
 * long-lived module registers here so the whole system starts, stops and
 * reports as one organism.
 */

import type { HealthReport, HealthStatus, ServiceState } from '@megaai/types';
import { Events, MegaError } from '@megaai/types';
import { type Clock, systemClock } from '@megaai/utils';
import type { Logger } from '@megaai/logger';
import type { EventBus } from '@megaai/events';

export interface Service {
  readonly name: string;
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
  health?(): Promise<HealthStatus> | HealthStatus;
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

export interface TimerStats {
  count: number;
  totalMs: number;
  maxMs: number;
  avgMs: number;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  timers: Record<string, TimerStats>;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly timers = new Map<string, { count: number; totalMs: number; maxMs: number }>();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  observe(name: string, ms: number): void {
    const entry = this.timers.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    entry.count += 1;
    entry.totalMs += ms;
    entry.maxMs = Math.max(entry.maxMs, ms);
    this.timers.set(name, entry);
  }

  /** Time an async function under `name`. */
  async time<T>(name: string, fn: () => Promise<T>, clock: Clock = systemClock): Promise<T> {
    const start = clock.now();
    try {
      return await fn();
    } finally {
      this.observe(name, clock.now() - start);
    }
  }

  snapshot(): MetricsSnapshot {
    const timers: Record<string, TimerStats> = {};
    for (const [name, t] of this.timers) {
      timers[name] = { ...t, avgMs: t.count > 0 ? Math.round(t.totalMs / t.count) : 0 };
    }
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      timers,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Scheduler
 * ------------------------------------------------------------------ */

export interface ScheduledJob {
  name: string;
  intervalMs: number;
  stop(): void;
  /** Run the job body immediately (also used by tests). */
  trigger(): Promise<void>;
}

export class Scheduler {
  private readonly jobs = new Map<string, { job: ScheduledJob; timer: NodeJS.Timeout }>();

  constructor(private readonly logger?: Logger) {}

  every(name: string, intervalMs: number, fn: () => Promise<void> | void): ScheduledJob {
    if (this.jobs.has(name)) throw new MegaError('ALREADY_EXISTS', `Job "${name}" already scheduled`);
    const run = async () => {
      try {
        await fn();
      } catch (err) {
        this.logger?.warn(`scheduled job "${name}" failed`, { error: String(err) });
      }
    };
    const timer = setInterval(run, intervalMs);
    timer.unref?.();
    const job: ScheduledJob = {
      name,
      intervalMs,
      stop: () => {
        clearInterval(timer);
        this.jobs.delete(name);
      },
      trigger: run,
    };
    this.jobs.set(name, { job, timer });
    return job;
  }

  list(): string[] {
    return [...this.jobs.keys()];
  }

  stopAll(): void {
    for (const { timer } of this.jobs.values()) clearInterval(timer);
    this.jobs.clear();
  }
}

/* ------------------------------------------------------------------ *
 * Service container
 * ------------------------------------------------------------------ */

type Factory<T> = (container: ServiceContainer) => T;

export class ServiceContainer {
  private readonly factories = new Map<string, Factory<unknown>>();
  private readonly instances = new Map<string, unknown>();
  private readonly resolving = new Set<string>();
  private readonly services: Service[] = [];
  private readonly serviceStates = new Map<string, ServiceState>();

  constructor(
    private readonly bus?: EventBus,
    private readonly logger?: Logger,
  ) {}

  /** Register a lazily-constructed singleton. */
  register<T>(name: string, factory: Factory<T>): void {
    if (this.factories.has(name) || this.instances.has(name)) {
      throw new MegaError('ALREADY_EXISTS', `Component "${name}" already registered`);
    }
    this.factories.set(name, factory);
  }

  /** Register an existing instance. */
  set<T>(name: string, instance: T): void {
    if (this.factories.has(name) || this.instances.has(name)) {
      throw new MegaError('ALREADY_EXISTS', `Component "${name}" already registered`);
    }
    this.instances.set(name, instance);
  }

  get<T>(name: string): T {
    if (this.instances.has(name)) return this.instances.get(name) as T;
    const factory = this.factories.get(name);
    if (!factory) throw new MegaError('NOT_FOUND', `Component "${name}" is not registered`);
    if (this.resolving.has(name)) {
      throw new MegaError('INTERNAL', `Circular dependency while resolving "${name}"`);
    }
    this.resolving.add(name);
    try {
      const instance = factory(this);
      this.instances.set(name, instance);
      return instance as T;
    } finally {
      this.resolving.delete(name);
    }
  }

  has(name: string): boolean {
    return this.factories.has(name) || this.instances.has(name);
  }

  /** Add a lifecycle-managed service. Start order = registration order. */
  addService(service: Service): void {
    if (this.services.some((s) => s.name === service.name)) {
      throw new MegaError('ALREADY_EXISTS', `Service "${service.name}" already added`);
    }
    this.services.push(service);
    this.serviceStates.set(service.name, 'created');
  }

  serviceStateOf(name: string): ServiceState | undefined {
    return this.serviceStates.get(name);
  }

  states(): Record<string, ServiceState> {
    return Object.fromEntries(this.serviceStates);
  }

  async startAll(): Promise<void> {
    const started: Service[] = [];
    for (const service of this.services) {
      this.serviceStates.set(service.name, 'starting');
      try {
        await service.start?.();
        this.serviceStates.set(service.name, 'running');
        started.push(service);
        this.logger?.debug(`service started`, { service: service.name });
        this.bus?.emit(Events.ServiceStarted, { service: service.name }, 'runtime');
      } catch (err) {
        this.serviceStates.set(service.name, 'failed');
        this.bus?.emit(Events.ServiceFailed, { service: service.name, error: String(err) }, 'runtime');
        // Unwind whatever already started, in reverse order.
        for (const done of started.reverse()) {
          try {
            await done.stop?.();
            this.serviceStates.set(done.name, 'stopped');
          } catch {
            /* best effort during unwind */
          }
        }
        throw new MegaError('INTERNAL', `Service "${service.name}" failed to start: ${String(err)}`);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const service of [...this.services].reverse()) {
      if (this.serviceStates.get(service.name) !== 'running') continue;
      this.serviceStates.set(service.name, 'stopping');
      try {
        await service.stop?.();
        this.serviceStates.set(service.name, 'stopped');
        this.bus?.emit(Events.ServiceStopped, { service: service.name }, 'runtime');
      } catch (err) {
        this.serviceStates.set(service.name, 'failed');
        this.logger?.warn(`service failed to stop cleanly`, { service: service.name, error: String(err) });
      }
    }
  }

  async healthAll(clock: Clock = systemClock): Promise<HealthReport[]> {
    const reports: HealthReport[] = [];
    for (const service of this.services) {
      const state = this.serviceStates.get(service.name);
      let status: HealthStatus;
      let detail: string | undefined;
      if (state !== 'running') {
        status = 'unhealthy';
        detail = `state=${state}`;
      } else if (service.health) {
        try {
          status = await service.health();
        } catch (err) {
          status = 'unhealthy';
          detail = String(err);
        }
      } else {
        status = 'healthy';
      }
      reports.push({ service: service.name, status, detail, checkedAt: clock.now() });
    }
    return reports;
  }
}
