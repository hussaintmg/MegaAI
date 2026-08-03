/**
 * @megaai/resources — knows how much machine is left.
 *
 * Samples CPU load, memory and disk; classifies pressure against
 * configurable thresholds and emits events when the level changes, so the
 * orchestrator can throttle agent concurrency before the box melts.
 */

import os from 'node:os';
import { statfsSync } from 'node:fs';
import type { ResourcePressure, ResourceSnapshot } from '@megaai/types';
import { Events } from '@megaai/types';
import { type Clock, clamp, systemClock } from '@megaai/utils';
import type { EventBus } from '@megaai/events';
import type { Logger } from '@megaai/logger';

export interface ResourceThresholds {
  memElevatedPct: number;
  memCriticalPct: number;
  /** Load average divided by core count. */
  cpuElevatedLoad: number;
  cpuCriticalLoad: number;
}

export const defaultThresholds: ResourceThresholds = {
  memElevatedPct: 80,
  memCriticalPct: 92,
  cpuElevatedLoad: 0.85,
  cpuCriticalLoad: 1.2,
};

export function sampleResources(clock: Clock = systemClock, diskPath = '.'): ResourceSnapshot {
  const cpuCount = Math.max(1, os.cpus().length);
  const [load1 = 0] = os.loadavg();
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const snapshot: ResourceSnapshot = {
    timestamp: clock.now(),
    cpuCount,
    cpuLoad: load1 / cpuCount,
    memTotalBytes: memTotal,
    memFreeBytes: memFree,
    memUsedPct: clamp(((memTotal - memFree) / memTotal) * 100, 0, 100),
  };
  try {
    const stat = statfsSync(diskPath);
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    snapshot.diskTotalBytes = total;
    snapshot.diskFreeBytes = free;
    snapshot.diskUsedPct = total > 0 ? clamp(((total - free) / total) * 100, 0, 100) : undefined;
  } catch {
    // Disk stats are best-effort (not available on every platform).
  }
  return snapshot;
}

export function classifyPressure(snapshot: ResourceSnapshot, thresholds: ResourceThresholds): ResourcePressure {
  if (snapshot.memUsedPct >= thresholds.memCriticalPct || snapshot.cpuLoad >= thresholds.cpuCriticalLoad) {
    return 'critical';
  }
  if (snapshot.memUsedPct >= thresholds.memElevatedPct || snapshot.cpuLoad >= thresholds.cpuElevatedLoad) {
    return 'elevated';
  }
  return 'ok';
}

export interface ResourceMonitorOptions {
  bus?: EventBus;
  logger?: Logger;
  clock?: Clock;
  thresholds?: Partial<ResourceThresholds>;
  sampleIntervalMs?: number;
  /** Injectable sampler for tests. */
  sampler?: (clock: Clock) => ResourceSnapshot;
}

export class ResourceMonitor {
  readonly name = 'resources';
  private readonly bus?: EventBus;
  private readonly logger?: Logger;
  private readonly clock: Clock;
  private readonly thresholds: ResourceThresholds;
  private readonly intervalMs: number;
  private readonly sampler: (clock: Clock) => ResourceSnapshot;
  private timer?: NodeJS.Timeout;
  private latestSnapshot?: ResourceSnapshot;
  private lastPressure: ResourcePressure = 'ok';

  constructor(options: ResourceMonitorOptions = {}) {
    this.bus = options.bus;
    this.logger = options.logger;
    this.clock = options.clock ?? systemClock;
    this.thresholds = { ...defaultThresholds, ...options.thresholds };
    this.intervalMs = options.sampleIntervalMs ?? 5_000;
    this.sampler = options.sampler ?? ((clock) => sampleResources(clock));
  }

  start(): void {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Take one sample now; returns the classified pressure. */
  sample(): ResourcePressure {
    const snapshot = this.sampler(this.clock);
    this.latestSnapshot = snapshot;
    const pressure = classifyPressure(snapshot, this.thresholds);
    this.bus?.emit(Events.ResourceSample, { snapshot, pressure }, 'resources');
    if (pressure !== this.lastPressure) {
      this.logger?.[pressure === 'ok' ? 'info' : 'warn']('resource pressure changed', {
        from: this.lastPressure,
        to: pressure,
        memUsedPct: Math.round(snapshot.memUsedPct),
        cpuLoad: Number(snapshot.cpuLoad.toFixed(2)),
      });
      this.bus?.emit(Events.ResourcePressure, { from: this.lastPressure, to: pressure, snapshot }, 'resources');
      this.lastPressure = pressure;
    }
    return pressure;
  }

  latest(): ResourceSnapshot | undefined {
    return this.latestSnapshot;
  }

  pressure(): ResourcePressure {
    return this.lastPressure;
  }

  /** How many concurrent heavy jobs the current pressure supports. */
  recommendedConcurrency(maxConcurrent: number): number {
    switch (this.lastPressure) {
      case 'critical':
        return 1;
      case 'elevated':
        return Math.max(1, Math.floor(maxConcurrent / 2));
      default:
        return maxConcurrent;
    }
  }
}
