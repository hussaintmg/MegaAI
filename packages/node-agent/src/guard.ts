/**
 * How hard the laptop is allowed to work right now.
 *
 * This is the part of the system that decides whether MegaAI is useful or
 * unbearable. The rule it is built around: **the machine is yours**. Every
 * ambiguous case resolves towards leaving you alone — an unreadable
 * temperature is not a cool machine, and not knowing whether you are at the
 * keyboard is treated as "you are", because assuming you had walked away when
 * you had not is exactly what makes a background agent something people
 * uninstall.
 *
 * Three gears, as promised in the plan:
 *
 *   full   — you are away. Everything runs, several at a time.
 *   gentle — you are here. Urgent work only, one at a time.
 *   stop   — too hot, nearly out of battery, or nearly out of memory. Nothing.
 */

import type { Gear } from '@megaai/mesh';
import { type Clock, systemClock } from '@megaai/utils';
import type { MachineSample } from './machine.js';

export interface GuardThresholds {
  /** Stop above this package temperature. */
  hotC: number;
  /** …and do not start again until it has come back down to this. */
  coolC: number;
  /**
   * If the temperature reading disappears while the machine is still hot, wait
   * this long before carrying on regardless. A probe that dies must not leave
   * the agent paused forever, and must not be taken as good news either.
   */
  blindCoolMs: number;
  /** Stop below this battery level when unplugged. */
  lowBatteryPct: number;
  /** You count as away after this long with no keyboard or mouse. */
  idleAfterSeconds: number;
  /** Memory this full means another build would make the machine unusable. */
  memStopPct: number;
  /** The machine is already loaded — take it easy even if you are away. */
  busyCpu: number;
  /**
   * Below this the machine does not look like it is being used.
   *
   * Only consulted where idle time cannot be read at all. See `evaluate`.
   */
  quietCpu: number;
  /** How many tasks at once in each gear. */
  fullConcurrency: number;
  gentleConcurrency: number;
  /** Do not change gear more often than this, so it cannot flap. */
  minHoldMs: number;
}

export const DEFAULT_THRESHOLDS: GuardThresholds = {
  hotC: 82,
  coolC: 72,
  blindCoolMs: 5 * 60_000,
  lowBatteryPct: 20,
  idleAfterSeconds: 180,
  memStopPct: 0.94,
  busyCpu: 0.85,
  quietCpu: 0.12,
  fullConcurrency: 3,
  gentleConcurrency: 1,
  minHoldMs: 20_000,
};

export interface GuardDecision {
  gear: Gear;
  concurrency: number;
  /** Plain words, shown on the dashboard — never a code you have to look up. */
  reason: string;
  at: number;
}

export interface ResourceGuardOptions {
  thresholds?: Partial<GuardThresholds>;
  clock?: Clock;
}

export class ResourceGuard {
  readonly thresholds: GuardThresholds;
  private readonly clock: Clock;
  private decision: GuardDecision | undefined;
  /** Set while stopped for heat, so leaving `stop` needs a real cool-down. */
  private coolingDown = false;
  private lastHotAt: number | undefined;
  /** Since when the machine has looked unused, where idle time is unreadable. */
  private quietSince: number | undefined;

  constructor(options: ResourceGuardOptions = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
    this.clock = options.clock ?? systemClock;
  }

  get last(): GuardDecision | undefined {
    return this.decision ? { ...this.decision } : undefined;
  }

  decide(sample: MachineSample): GuardDecision {
    const wanted = this.evaluate(sample);
    const previous = this.decision;
    const now = this.clock.now();

    // Stopping is always immediate: a hot machine will not wait for a timer.
    // Relaxing is held back, so a single quiet second does not restart three
    // builds in your face.
    const holding =
      previous !== undefined &&
      wanted.gear !== 'stop' &&
      rank(wanted.gear) > rank(previous.gear) &&
      now - previous.at < this.thresholds.minHoldMs;

    const settled: GuardDecision = holding
      ? { ...previous, at: previous.at }
      : { ...wanted, at: now };
    this.decision = settled;
    return { ...settled };
  }

  private evaluate(sample: MachineSample): Omit<GuardDecision, 'at'> {
    const t = this.thresholds;
    const stop = (reason: string): Omit<GuardDecision, 'at'> => ({ gear: 'stop', concurrency: 0, reason });
    const gentle = (reason: string): Omit<GuardDecision, 'at'> => ({
      gear: 'gentle',
      concurrency: t.gentleConcurrency,
      reason,
    });

    if (sample.temperatureC !== undefined) {
      if (sample.temperatureC >= t.hotC) {
        this.coolingDown = true;
        this.lastHotAt = this.clock.now();
        return stop(`the CPU is at ${round(sample.temperatureC)}°C — paused until it comes back under ${t.coolC}°C`);
      }
      if (this.coolingDown && sample.temperatureC > t.coolC) {
        return stop(`still cooling — ${round(sample.temperatureC)}°C, waiting for ${t.coolC}°C`);
      }
      this.coolingDown = false;
    } else if (this.coolingDown) {
      // The reading vanished while it was hot. Silence is not cool.
      const since = this.clock.now() - (this.lastHotAt ?? 0);
      if (since < t.blindCoolMs) {
        return stop('the temperature reading stopped coming while the machine was hot — waiting rather than assuming');
      }
      this.coolingDown = false;
      return gentle('the temperature is no longer readable — working slowly, one thing at a time, to stay safe');
    }

    if (sample.batteryPct !== undefined && sample.charging === false && sample.batteryPct <= t.lowBatteryPct) {
      return stop(`battery is at ${Math.round(sample.batteryPct)}% and unplugged — background work is not worth the last of it`);
    }

    if (sample.memUsedPct >= t.memStopPct) {
      return stop(
        `memory is ${Math.round(sample.memUsedPct * 100)}% full — starting anything else would make the machine crawl`,
      );
    }

    if (sample.idleSeconds === undefined) {
      return this.withoutIdleTime(sample);
    }
    this.quietSince = undefined;

    if (sample.idleSeconds < t.idleAfterSeconds) {
      return gentle(`you used the machine ${describeIdle(sample.idleSeconds)} ago — staying out of the way`);
    }

    if (sample.cpuLoad >= t.busyCpu) {
      return gentle(
        `you are away, but the CPU is already ${Math.round(sample.cpuLoad * 100)}% busy — running one thing at a time`,
      );
    }

    return {
      gear: 'full',
      concurrency: t.fullConcurrency,
      reason: `you have been away ${describeIdle(sample.idleSeconds)} — running everything that is waiting`,
    };
  }

  /**
   * What to do when the machine cannot say whether you are at the keyboard.
   *
   * The first version of this simply stayed in `gentle` forever, which was
   * safe and useless: on any machine without an idle-time reading — a Linux
   * box, a Windows install where the probe cannot start — the entire backlog
   * would be deferred until the end of time, quietly, which is the exact
   * failure this whole system is supposed to stop.
   *
   * So load stands in for the keyboard. Someone using a laptop keeps it above
   * a few percent; a machine that has sat under `quietCpu` for as long as we
   * would otherwise wait for the keyboard is not being used. It is a weaker
   * signal, so it has to hold for the whole period rather than one sample, and
   * the reason says which signal it acted on.
   */
  private withoutIdleTime(sample: MachineSample): Omit<GuardDecision, 'at'> {
    const t = this.thresholds;
    const now = this.clock.now();

    if (sample.cpuLoad > t.quietCpu) {
      this.quietSince = undefined;
      return {
        gear: 'gentle',
        concurrency: t.gentleConcurrency,
        reason: `this machine cannot report idle time, and it is ${Math.round(sample.cpuLoad * 100)}% busy — assuming you are using it`,
      };
    }

    this.quietSince ??= now;
    const quietFor = (now - this.quietSince) / 1000;
    if (quietFor < t.idleAfterSeconds) {
      return {
        gear: 'gentle',
        concurrency: t.gentleConcurrency,
        reason: `this machine cannot report idle time; it has only been quiet ${describeIdle(quietFor)} — urgent work only for now`,
      };
    }

    return {
      gear: 'full',
      concurrency: t.fullConcurrency,
      reason: `no idle-time reading on this machine, but it has been quiet for ${describeIdle(quietFor)} — treating you as away`,
    };
  }
}

function rank(gear: Gear): number {
  return gear === 'stop' ? 0 : gear === 'gentle' ? 1 : 2;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function describeIdle(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}
