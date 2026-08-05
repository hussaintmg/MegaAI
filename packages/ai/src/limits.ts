/**
 * LimitTracker — accounts for what each provider is still allowed to do:
 * requests per minute, tokens per day, and temporary "exhausted" states set
 * when a provider returns a rate-limit error.
 */

import type { ProviderKind, ProviderLimits, ProviderUsageSummary, TokenUsage } from '@megaai/types';
import { type Clock, systemClock } from '@megaai/utils';

interface ProviderLedger {
  limits: ProviderLimits;
  requestTimestamps: number[];
  dayStart: number;
  tokensToday: number;
  exhaustedUntil?: number;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * 60_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface LimitCheck {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

export class LimitTracker {
  private readonly ledgers = new Map<ProviderKind, ProviderLedger>();
  /** One queue per provider, so concurrent agents take turns instead of bursting. */
  private readonly queues = new Map<ProviderKind, Promise<unknown>>();

  constructor(private readonly clock: Clock = systemClock) {}

  /**
   * Wait for a request slot, then take it.
   *
   * `check()` only ever answers "not right now", and every caller treated that
   * as "use someone else" — so a single key at 10 requests/minute sent the
   * eleventh task to whatever was next in the chain, which is the offline
   * mock. Free-tier limits are a queue to stand in, not a provider outage.
   *
   * Calls are serialised per provider: without that, four agents all pass the
   * check in the same millisecond and burst straight through the limit.
   */
  async reserve(
    provider: ProviderKind,
    estimatedTokens = 0,
    maxWaitMs = 0,
    sleep: (ms: number) => Promise<void> = defaultSleep,
  ): Promise<LimitCheck & { waitedMs: number }> {
    const previous = this.queues.get(provider) ?? Promise.resolve();
    let release!: () => void;
    this.queues.set(
      provider,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await previous.catch(() => undefined);

    try {
      let waitedMs = 0;
      for (;;) {
        const check = this.check(provider, estimatedTokens);
        if (check.allowed) {
          // Take the slot now. Recording only after the response would let
          // every queued caller pass the check before any of them counted.
          this.ledger(provider).requestTimestamps.push(this.clock.now());
          return { ...check, waitedMs };
        }
        // Only the per-minute window is worth standing in line for. A daily
        // token cap will not clear today, and "exhausted" is set after a
        // provider has already had its retries — waiting again just doubles it.
        if (check.reason !== 'requests-per-minute') return { ...check, waitedMs };
        // +50ms so the window has genuinely rolled past when we re-check.
        const wait = (check.retryAfterMs ?? 1_000) + 50;
        // Budget against time we have actually spent, not against the clock:
        // an injected clock does not advance, and this loop must still end.
        if (waitedMs + wait > maxWaitMs) return { ...check, waitedMs };
        await sleep(wait);
        waitedMs += wait;
      }
    } finally {
      release();
    }
  }

  /** Tokens only — the request slot was already taken by `reserve`. */
  recordTokens(provider: ProviderKind, usage?: TokenUsage): void {
    if (!usage) return;
    const ledger = this.ledger(provider);
    this.rollDay(ledger, this.clock.now());
    ledger.tokensToday += usage.inputTokens + usage.outputTokens;
  }

  configure(provider: ProviderKind, limits: ProviderLimits): void {
    const ledger = this.ledger(provider);
    ledger.limits = limits;
  }

  private ledger(provider: ProviderKind): ProviderLedger {
    let ledger = this.ledgers.get(provider);
    if (!ledger) {
      ledger = { limits: {}, requestTimestamps: [], dayStart: this.clock.now(), tokensToday: 0 };
      this.ledgers.set(provider, ledger);
    }
    return ledger;
  }

  private rollDay(ledger: ProviderLedger, now: number): void {
    if (now - ledger.dayStart >= DAY) {
      ledger.dayStart = now;
      ledger.tokensToday = 0;
    }
  }

  /** Would one more request (of ~`estimatedTokens`) fit right now? */
  check(provider: ProviderKind, estimatedTokens = 0): LimitCheck {
    const now = this.clock.now();
    const ledger = this.ledger(provider);
    this.rollDay(ledger, now);

    if (ledger.exhaustedUntil !== undefined) {
      if (now < ledger.exhaustedUntil) {
        return { allowed: false, reason: 'exhausted', retryAfterMs: ledger.exhaustedUntil - now };
      }
      ledger.exhaustedUntil = undefined;
    }

    const rpm = ledger.limits.requestsPerMinute;
    if (rpm !== undefined) {
      ledger.requestTimestamps = ledger.requestTimestamps.filter((ts) => ts > now - MINUTE);
      if (ledger.requestTimestamps.length >= rpm) {
        const oldest = ledger.requestTimestamps[0] ?? now;
        return { allowed: false, reason: 'requests-per-minute', retryAfterMs: oldest + MINUTE - now };
      }
    }

    const tpd = ledger.limits.tokensPerDay;
    if (tpd !== undefined && ledger.tokensToday + estimatedTokens > tpd) {
      return { allowed: false, reason: 'tokens-per-day', retryAfterMs: ledger.dayStart + DAY - now };
    }

    return { allowed: true };
  }

  /** Record a request that went through. */
  recordRequest(provider: ProviderKind, usage?: TokenUsage): void {
    const now = this.clock.now();
    const ledger = this.ledger(provider);
    this.rollDay(ledger, now);
    ledger.requestTimestamps.push(now);
    if (usage) ledger.tokensToday += usage.inputTokens + usage.outputTokens;
  }

  /** Mark a provider unusable until `now + cooldownMs` (rate-limit response). */
  markExhausted(provider: ProviderKind, cooldownMs: number): void {
    const ledger = this.ledger(provider);
    ledger.exhaustedUntil = this.clock.now() + cooldownMs;
  }

  clearExhausted(provider: ProviderKind): void {
    this.ledger(provider).exhaustedUntil = undefined;
  }

  isExhausted(provider: ProviderKind): boolean {
    const ledger = this.ledgers.get(provider);
    if (!ledger?.exhaustedUntil) return false;
    return this.clock.now() < ledger.exhaustedUntil;
  }

  summary(): ProviderUsageSummary[] {
    const now = this.clock.now();
    return [...this.ledgers.entries()].map(([provider, ledger]) => ({
      provider,
      requestsInWindow: ledger.requestTimestamps.filter((ts) => ts > now - MINUTE).length,
      tokensToday: ledger.tokensToday,
      exhaustedUntil: ledger.exhaustedUntil !== undefined && ledger.exhaustedUntil > now ? ledger.exhaustedUntil : undefined,
    }));
  }
}
