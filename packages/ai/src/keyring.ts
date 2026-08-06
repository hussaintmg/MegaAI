/**
 * Several keys for the same provider, used one after another.
 *
 * One free Gemini key gives you a handful of requests a minute. Three give you
 * three times that, and the difference between "MegaAI stopped at 2am" and
 * "MegaAI finished" is often exactly that. But it only helps if a key hitting
 * its limit costs a *key*, not the provider: writing Gemini off because its
 * first key is spent, while two more sit unused, is the failure this exists to
 * stop.
 *
 * So a rate-limited key is parked until it comes back and the next one takes
 * over inside the same request. The provider only reports a rate limit upwards
 * when every key it has is spent — and then it says when the first returns, so
 * the caller can wait rather than give up.
 *
 * A key rejected as *invalid* is different and is parked for good: retrying a
 * typo every minute for a week is noise, and the person who pasted it needs to
 * be told, not protected from the news.
 */

import type { Timestamp } from '@megaai/types';
import { type Clock, systemClock } from '@megaai/utils';

export interface KeyState {
  index: number;
  /** What to call it on screen — never the key itself. */
  label: string;
  /** Set while it is unusable. Absent means ready. */
  parkedUntil?: Timestamp;
  /** Permanently out: the provider said this key is not valid. */
  rejected?: boolean;
  reason?: string;
  uses: number;
}

export interface KeyRingOptions {
  clock?: Clock;
  /** How long to park a key that reported a limit without saying when. */
  blindCooldownMs?: number;
  labels?: string[];
}

/** The last four characters, which is all anyone needs to tell keys apart. */
export function labelForKey(key: string, index: number): string {
  const tail = key.trim().slice(-4);
  return tail.length === 4 ? `key ${index + 1} (…${tail})` : `key ${index + 1}`;
}

export class KeyRing {
  private readonly keys: string[];
  private readonly states: KeyState[];
  private readonly clock: Clock;
  private readonly blindCooldownMs: number;

  constructor(keys: readonly string[], options: KeyRingOptions = {}) {
    this.keys = keys.map((key) => key.trim()).filter(Boolean);
    this.clock = options.clock ?? systemClock;
    this.blindCooldownMs = options.blindCooldownMs ?? 60_000;
    this.states = this.keys.map((key, index) => ({
      index,
      label: options.labels?.[index] ?? labelForKey(key, index),
      uses: 0,
    }));
  }

  get size(): number {
    return this.keys.length;
  }

  /** The key to use right now, or nothing if every one is spent. */
  current(): { key: string; index: number } | undefined {
    const now = this.clock.now();
    const ready = this.states.find((state) => !state.rejected && (state.parkedUntil ?? 0) <= now);
    if (!ready) return undefined;
    const key = this.keys[ready.index];
    return key ? { key, index: ready.index } : undefined;
  }

  /** Count it as used, so the load spreads rather than hammering the first. */
  recordUse(index: number): void {
    const state = this.states[index];
    if (state) state.uses += 1;
  }

  /**
   * This key is out for now. `until` comes from the provider when it says so.
   */
  park(index: number, reason: string, until?: Timestamp): void {
    const state = this.states[index];
    if (!state) return;
    state.parkedUntil = until ?? this.clock.now() + this.blindCooldownMs;
    state.reason = reason;
  }

  /** This key is wrong — a typo, a revoked key. Retrying it helps nobody. */
  reject(index: number, reason: string): void {
    const state = this.states[index];
    if (!state) return;
    state.rejected = true;
    state.reason = reason;
  }

  /** Is there another usable key to try after this one? */
  hasAnother(afterIndex: number): boolean {
    const now = this.clock.now();
    return this.states.some(
      (state) => state.index !== afterIndex && !state.rejected && (state.parkedUntil ?? 0) <= now,
    );
  }

  /**
   * When the first parked key comes back, if waiting would help at all.
   *
   * `undefined` when nothing is merely waiting — either a key is ready now, or
   * every key has been rejected and no amount of waiting will change that.
   */
  readyAt(): Timestamp | undefined {
    if (this.current()) return undefined;
    const waiting = this.states.filter((state) => !state.rejected && state.parkedUntil !== undefined);
    if (waiting.length === 0) return undefined;
    return waiting.reduce<Timestamp>(
      (soonest, state) => Math.min(soonest, state.parkedUntil ?? Infinity),
      Infinity,
    );
  }

  /** For the dashboard: which keys are in play, and why any are not. */
  snapshot(): KeyState[] {
    return this.states.map((state) => ({ ...state }));
  }

  /** A sentence for the error the caller finally sees. */
  explain(): string {
    if (this.size === 0) return 'no API key is configured';
    const rejected = this.states.filter((state) => state.rejected);
    const parked = this.states.filter((state) => !state.rejected && (state.parkedUntil ?? 0) > this.clock.now());
    const parts: string[] = [];
    if (parked.length > 0) {
      parts.push(
        `${parked.length} of ${this.size} key(s) rate limited (${parked
          .map((state) => `${state.label} until ${new Date(state.parkedUntil ?? 0).toISOString()}`)
          .join(', ')})`,
      );
    }
    if (rejected.length > 0) {
      parts.push(`${rejected.map((state) => `${state.label} was rejected: ${state.reason ?? 'invalid'}`).join('; ')}`);
    }
    return parts.join('. ') || 'no key is available';
  }
}

/** Every key configured for a provider, however it was given. */
export function collectKeys(options: { apiKey?: string; apiKeys?: readonly string[] }): string[] {
  const all = [...(options.apiKeys ?? []), ...(options.apiKey ? [options.apiKey] : [])]
    .map((key) => key.trim())
    .filter(Boolean);
  // The same key pasted twice is not two keys, and treating it as two would
  // make the ring report headroom that does not exist.
  return [...new Set(all)];
}
