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

export interface LimitCheck {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

export class LimitTracker {
  private readonly ledgers = new Map<ProviderKind, ProviderLedger>();

  constructor(private readonly clock: Clock = systemClock) {}

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
