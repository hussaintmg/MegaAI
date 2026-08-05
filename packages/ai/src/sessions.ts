/**
 * AiSessionManager — the "Recover" pillar of MegaAI.
 *
 * A session is a lease on model capacity. Each completion walks the
 * configured fallback chain (e.g. anthropic → openai → gemini → mock),
 * skipping providers that are unconfigured, disabled, over their limits or
 * temporarily exhausted, and cools down providers that return rate-limit
 * errors. Callers never think about which vendor answered.
 */

import type {
  CompletionRequest,
  CompletionResponse,
  ProviderKind,
  SessionLease,
  TaskComplexity,
} from '@megaai/types';
import { Events, MegaError } from '@megaai/types';
import { type Clock, estimateTokens, newId, systemClock } from '@megaai/utils';
import type { AiSession, Provider } from '@megaai/contracts';
import type { EventBus } from '@megaai/events';
import type { Logger } from '@megaai/logger';
import { ModelRegistry } from './models.js';
import { LimitTracker } from './limits.js';

export class ProviderRegistry {
  private readonly providers = new Map<ProviderKind, Provider>();

  register(provider: Provider): void {
    if (this.providers.has(provider.kind)) {
      throw new MegaError('ALREADY_EXISTS', `Provider "${provider.kind}" already registered`);
    }
    this.providers.set(provider.kind, provider);
  }

  get(kind: ProviderKind): Provider | undefined {
    return this.providers.get(kind);
  }

  list(): Provider[] {
    return [...this.providers.values()];
  }
}

export interface AcquireOptions {
  purpose: string;
  complexity?: TaskComplexity;
  preferredProvider?: ProviderKind;
  preferredModel?: string;
}

export interface SessionManagerOptions {
  providers: ProviderRegistry;
  models?: ModelRegistry;
  limits?: LimitTracker;
  fallbackChain: ProviderKind[];
  disabledProviders?: ProviderKind[];
  maxTokens?: number;
  rateLimitCooldownMs?: number;
  bus?: EventBus;
  logger?: Logger;
  clock?: Clock;
}

export interface ProviderStatus {
  kind: ProviderKind;
  configured: boolean;
  enabled: boolean;
  exhausted: boolean;
}

/** Who actually answered, and who refused — the record of a fallback. */
export interface ProviderTally {
  kind: ProviderKind;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderFailure {
  kind: ProviderKind;
  code: string;
  message: string;
  count: number;
}

export class AiSessionManager {
  readonly name = 'ai-sessions';
  readonly models: ModelRegistry;
  readonly limits: LimitTracker;
  private readonly providers: ProviderRegistry;
  private readonly chain: ProviderKind[];
  private readonly disabled: Set<ProviderKind>;
  private readonly maxTokens: number;
  private readonly cooldownMs: number;
  private readonly bus?: EventBus;
  private readonly logger?: Logger;
  private readonly clock: Clock;
  private readonly activeSessions = new Map<string, SessionLease>();
  private totalUsage = { inputTokens: 0, outputTokens: 0, requests: 0, estimatedCostUsd: 0 };
  // Per-provider books. The totals alone cannot tell a real delivery from one
  // the offline mock produced after every configured key failed, and that
  // difference is the whole answer to "why is my site a placeholder?".
  private readonly tallies = new Map<ProviderKind, ProviderTally>();
  private readonly failures = new Map<ProviderKind, ProviderFailure>();

  constructor(options: SessionManagerOptions) {
    this.providers = options.providers;
    this.models = options.models ?? new ModelRegistry();
    this.limits = options.limits ?? new LimitTracker(options.clock);
    this.chain = options.fallbackChain;
    this.disabled = new Set(options.disabledProviders ?? []);
    this.maxTokens = options.maxTokens ?? 16_000;
    this.cooldownMs = options.rateLimitCooldownMs ?? 60_000;
    this.bus = options.bus;
    this.logger = options.logger;
    this.clock = options.clock ?? systemClock;
  }

  /** Providers in fallback order, starting from `preferred` when given. */
  private orderedChain(preferred?: ProviderKind): ProviderKind[] {
    if (!preferred) return this.chain;
    return [preferred, ...this.chain.filter((kind) => kind !== preferred)];
  }

  private usableProvider(kind: ProviderKind, estimatedTokens: number): Provider | undefined {
    if (this.disabled.has(kind)) return undefined;
    const provider = this.providers.get(kind);
    if (!provider || !provider.isConfigured()) return undefined;
    if (!this.limits.check(kind, estimatedTokens).allowed) return undefined;
    return provider;
  }

  acquire(options: AcquireOptions): AiSession {
    const complexity = options.complexity ?? 'standard';
    const chain = this.orderedChain(options.preferredProvider);
    const firstUsable = chain.map((kind) => this.usableProvider(kind, 0)).find(Boolean);
    if (!firstUsable) {
      throw new MegaError('PROVIDER_UNAVAILABLE', 'No AI provider is currently usable', {
        chain: chain as string[],
      });
    }
    let leaseModel = options.preferredModel;
    if (!leaseModel) {
      try {
        leaseModel = this.models.pick(firstUsable.kind, complexity).id;
      } catch {
        leaseModel = firstUsable.models()[0]?.id ?? 'default';
      }
    }
    const lease: SessionLease = {
      id: newId('ses'),
      provider: firstUsable.kind,
      model: leaseModel,
      purpose: options.purpose,
      complexity,
      acquiredAt: this.clock.now(),
    };
    this.activeSessions.set(lease.id, lease);
    this.bus?.emit(Events.SessionAcquired, { lease }, 'ai');

    const manager = this;
    return {
      lease,
      async complete(request: CompletionRequest): Promise<CompletionResponse> {
        const response = await manager.completeWithFallback(request, {
          complexity,
          preferredProvider: options.preferredProvider,
          preferredModel: options.preferredModel,
        });
        // Keep the lease's provenance current for observability.
        lease.provider = response.provider;
        lease.model = response.model;
        return response;
      },
      release(): void {
        manager.activeSessions.delete(lease.id);
        manager.bus?.emit(Events.SessionReleased, { leaseId: lease.id }, 'ai');
      },
    };
  }

  /** Run one completion, walking the fallback chain until someone answers. */
  async completeWithFallback(
    request: CompletionRequest,
    options: { complexity?: TaskComplexity; preferredProvider?: ProviderKind; preferredModel?: string } = {},
  ): Promise<CompletionResponse> {
    const complexity = options.complexity ?? 'standard';
    const estimated = estimateTokens(
      `${request.system ?? ''}${request.messages.map((message) => message.content).join('')}`,
    );
    const attempts: string[] = [];

    for (const kind of this.orderedChain(options.preferredProvider)) {
      const provider = this.usableProvider(kind, estimated);
      if (!provider) {
        attempts.push(`${kind}: skipped`);
        continue;
      }
      let model = request.model ?? (kind === options.preferredProvider ? options.preferredModel : undefined);
      if (!model) {
        try {
          model = this.models.pick(kind, complexity).id;
        } catch {
          // Provider has no cards in the registry — fall back to whatever it
          // reports itself (or its own internal default).
          model = provider.models()[0]?.id;
        }
      }
      try {
        const response = await provider.complete({
          ...request,
          model,
          maxTokens: request.maxTokens ?? this.maxTokens,
        });
        this.limits.recordRequest(kind, response.usage);
        this.recordUsage(response);
        this.bus?.emit(Events.CompletionFinished, {
          provider: kind,
          model: response.model,
          usage: response.usage,
        }, 'ai');
        return response;
      } catch (err) {
        const error = MegaError.from(err);
        attempts.push(`${kind}: ${error.code}`);
        this.recordFailure(kind, error);
        if (error.code === 'RATE_LIMITED') {
          this.limits.markExhausted(kind, this.cooldownMs);
          this.bus?.emit(Events.ProviderExhausted, { provider: kind, cooldownMs: this.cooldownMs }, 'ai');
        }
        const canFallThrough =
          error.retryable || error.code === 'PROVIDER_REFUSED' || error.code === 'INTERNAL';
        if (!canFallThrough) throw error;
        this.logger?.warn('provider failed, falling through chain', {
          provider: kind,
          code: error.code,
          message: error.message,
        });
      }
    }

    throw new MegaError('PROVIDER_UNAVAILABLE', `All providers failed or were skipped (${attempts.join('; ')})`, {
      attempts,
    });
  }

  private recordUsage(response: CompletionResponse): void {
    this.totalUsage.requests += 1;
    this.totalUsage.inputTokens += response.usage.inputTokens;
    this.totalUsage.outputTokens += response.usage.outputTokens;
    this.totalUsage.estimatedCostUsd += this.models.costOf(
      response.model,
      response.usage.inputTokens,
      response.usage.outputTokens,
    );
    const tally = this.tallies.get(response.provider) ?? {
      kind: response.provider,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    tally.requests += 1;
    tally.inputTokens += response.usage.inputTokens;
    tally.outputTokens += response.usage.outputTokens;
    this.tallies.set(response.provider, tally);
  }

  private recordFailure(kind: ProviderKind, error: MegaError): void {
    const previous = this.failures.get(kind);
    this.failures.set(kind, {
      kind,
      code: error.code,
      message: error.message,
      count: (previous?.count ?? 0) + 1,
    });
  }

  usage(): typeof this.totalUsage {
    return { ...this.totalUsage };
  }

  /** Completions each provider actually served, busiest first. */
  providerTallies(): ProviderTally[] {
    return [...this.tallies.values()].sort((a, b) => b.requests - a.requests).map((tally) => ({ ...tally }));
  }

  /** The last error from every provider that was tried and refused. */
  providerFailures(): ProviderFailure[] {
    return [...this.failures.values()].map((failure) => ({ ...failure }));
  }

  activeSessionCount(): number {
    return this.activeSessions.size;
  }

  providerStatus(): ProviderStatus[] {
    return this.chain.map((kind) => {
      const provider = this.providers.get(kind);
      return {
        kind,
        configured: provider?.isConfigured() ?? false,
        enabled: !this.disabled.has(kind) && Boolean(provider),
        exhausted: this.limits.isExhausted(kind),
      };
    });
  }
}
