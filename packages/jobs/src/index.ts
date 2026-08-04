/**
 * @megaai/jobs — recurring scheduled jobs (Phase 3).
 *
 * The "MegaAI keeps working for you" part: durable job records (nightly
 * reports, health monitors, client follow-ups) that survive restarts and run
 * on the runtime `Scheduler`. Job *kinds* are pluggable handlers registered by
 * the composition root; this package owns persistence, scheduling, run
 * bookkeeping and the `jobs.*` tools — not what any particular job does.
 */

import type { Collection, Database, EventPublisher, LogFn, Service, Tool } from '@megaai/contracts';
import type { JsonObject, JsonValue, Timestamp } from '@megaai/types';
import { MegaError } from '@megaai/types';
import { type Clock, newId, systemClock } from '@megaai/utils';
import type { Scheduler, ScheduledJob } from '@megaai/runtime';

export interface JobRecord {
  id: string;
  name: string;
  kind: string;
  intervalMs: number;
  enabled: boolean;
  runs: number;
  params?: JsonObject;
  lastRunAt?: Timestamp;
  lastStatus?: 'ok' | 'error';
  lastError?: string;
  nextRunAt?: Timestamp;
  createdAt: Timestamp;
}

export interface JobHandlerContext {
  job: JobRecord;
  clock: Clock;
  log: LogFn;
}

export type JobHandler = (ctx: JobHandlerContext) => Promise<void> | void;

export const JobEvents = {
  Scheduled: 'jobs.scheduled',
  Ran: 'jobs.job.ran',
  Cancelled: 'jobs.cancelled',
} as const;

export interface JobsEngineOptions {
  database: Database;
  scheduler: Scheduler;
  bus?: EventPublisher;
  clock?: Clock;
  logger?: LogFn;
  /** Floor on job frequency, so a bad interval can't hammer the loop. */
  minIntervalMs?: number;
}

export class JobsEngine implements Service {
  readonly name = 'jobs';
  private readonly clock: Clock;
  private readonly minIntervalMs: number;
  private readonly records: Collection<JobRecord>;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly armed = new Map<string, ScheduledJob>();
  private started = false;

  constructor(private readonly options: JobsEngineOptions) {
    this.clock = options.clock ?? systemClock;
    this.minIntervalMs = options.minIntervalMs ?? 1_000;
    this.records = options.database.collection<JobRecord>('jobs');
  }

  /** Register a job kind. Returns `this` for chaining. */
  registerHandler(kind: string, handler: JobHandler): this {
    this.handlers.set(kind, handler);
    return this;
  }

  hasHandler(kind: string): boolean {
    return this.handlers.has(kind);
  }

  kinds(): string[] {
    return [...this.handlers.keys()];
  }

  async schedule(input: { name: string; kind: string; intervalMs: number; params?: JsonObject; enabled?: boolean }): Promise<JobRecord> {
    if (!input.name?.trim()) throw new MegaError('INVALID_INPUT', 'job needs a name');
    if (!this.handlers.has(input.kind)) throw new MegaError('NOT_FOUND', `Unknown job kind "${input.kind}"`, { kinds: this.kinds() });
    const intervalMs = Math.max(Math.floor(input.intervalMs), this.minIntervalMs);
    const now = this.clock.now();
    const record: JobRecord = {
      id: newId('job'),
      name: input.name,
      kind: input.kind,
      intervalMs,
      enabled: input.enabled ?? true,
      runs: 0,
      params: input.params,
      nextRunAt: now + intervalMs,
      createdAt: now,
    };
    await this.records.put(record);
    if (this.started && record.enabled) this.arm(record);
    this.options.bus?.emit(JobEvents.Scheduled, { job: record }, 'jobs');
    return record;
  }

  private arm(record: JobRecord): void {
    if (this.armed.has(record.id)) return;
    const job = this.options.scheduler.every(`job:${record.id}`, record.intervalMs, () => this.fire(record.id));
    this.armed.set(record.id, job);
  }

  private disarm(id: string): void {
    const job = this.armed.get(id);
    if (job) {
      job.stop();
      this.armed.delete(id);
    }
  }

  /** Run one job now (used by `jobs.run` and by tests — no timer waiting). */
  async fire(id: string): Promise<void> {
    const record = await this.records.get(id);
    if (!record || !record.enabled) return;
    const handler = this.handlers.get(record.kind);
    if (!handler) return;
    try {
      await handler({ job: record, clock: this.clock, log: (m, f) => this.options.logger?.(m, f) });
      record.lastStatus = 'ok';
      record.lastError = undefined;
    } catch (err) {
      record.lastStatus = 'error';
      record.lastError = String(err);
      this.options.logger?.(`job "${record.name}" failed`, { error: String(err) });
    }
    record.runs += 1;
    record.lastRunAt = this.clock.now();
    record.nextRunAt = this.clock.now() + record.intervalMs;
    await this.records.put(record);
    this.options.bus?.emit(JobEvents.Ran, { job: record }, 'jobs');
  }

  list(): Promise<JobRecord[]> {
    return this.records.all();
  }

  get(id: string): Promise<JobRecord | undefined> {
    return this.records.get(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<JobRecord> {
    const record = await this.records.get(id);
    if (!record) throw new MegaError('NOT_FOUND', `No job "${id}"`);
    record.enabled = enabled;
    await this.records.put(record);
    if (this.started) {
      if (enabled) this.arm(record);
      else this.disarm(id);
    }
    return record;
  }

  async cancel(id: string): Promise<boolean> {
    this.disarm(id);
    const existed = await this.records.delete(id);
    if (existed) this.options.bus?.emit(JobEvents.Cancelled, { id }, 'jobs');
    return existed;
  }

  /** Service start: arm every enabled persisted job. */
  async start(): Promise<void> {
    this.started = true;
    for (const record of await this.records.all()) if (record.enabled) this.arm(record);
  }

  stop(): void {
    for (const job of this.armed.values()) job.stop();
    this.armed.clear();
    this.started = false;
  }
}

/* ------------------------------------------------------------------ *
 * Agent-facing tools (all on the `jobs` permission)
 * ------------------------------------------------------------------ */

export function createJobsTools(engine: JobsEngine): Tool[] {
  const schedule: Tool = {
    name: 'jobs.schedule',
    description: 'Schedule a recurring job. input: { name, kind, intervalMs, params? }. kind must be a registered job kind.',
    inputSchema: { name: 'string', kind: 'string (registered job kind)', intervalMs: 'number', params: 'object (optional)' },
    permissions: ['jobs'],
    async execute(input) {
      const params = input.params && typeof input.params === 'object' && !Array.isArray(input.params) ? (input.params as JsonObject) : undefined;
      return (await engine.schedule({
        name: String(input.name ?? ''),
        kind: String(input.kind ?? ''),
        intervalMs: typeof input.intervalMs === 'number' ? input.intervalMs : Number(input.intervalMs),
        params,
      })) as unknown as JsonValue;
    },
  };
  const list: Tool = {
    name: 'jobs.list',
    description: 'List scheduled jobs with their run counts and last status',
    inputSchema: {},
    permissions: ['jobs'],
    async execute() {
      return { jobs: (await engine.list()) as unknown as JsonValue, kinds: engine.kinds() };
    },
  };
  const run: Tool = {
    name: 'jobs.run',
    description: 'Run a scheduled job immediately by id',
    inputSchema: { id: 'string (job id)' },
    permissions: ['jobs'],
    async execute(input) {
      const id = String(input.id ?? '');
      if (!id) throw new MegaError('INVALID_INPUT', 'jobs.run needs an id');
      await engine.fire(id);
      return (await engine.get(id) ?? { id, note: 'no such job' }) as unknown as JsonValue;
    },
  };
  const cancel: Tool = {
    name: 'jobs.cancel',
    description: 'Cancel and delete a scheduled job by id',
    inputSchema: { id: 'string (job id)' },
    permissions: ['jobs'],
    async execute(input) {
      const cancelled = await engine.cancel(String(input.id ?? ''));
      return { cancelled };
    },
  };
  return [schedule, list, run, cancel];
}
