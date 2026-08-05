import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '@megaai/utils';
import { MegaError, type CompletionResponse, type ModelCard, type ProviderKind } from '@megaai/types';
import type { Provider } from '@megaai/contracts';
import { LimitTracker } from './limits.js';
import { AiSessionManager, ProviderRegistry } from './sessions.js';
import { MockProvider } from './providers/mock.js';
import { ModelRegistry } from './models.js';

const REQUEST = { messages: [{ role: 'user' as const, content: 'hello' }] };

// The manager now waits out rate limits with real timers. Tests inject an
// instant sleep so a 429 case does not spend 15 seconds sitting still.
const NO_WAIT = async (): Promise<void> => undefined;

/** Refuses with a 429 for its first `failures` calls, then answers. */
class FlakyProvider implements Provider {
  calls = 0;
  constructor(
    readonly kind: ProviderKind,
    private readonly failures: number,
    private readonly retryAfterMs?: number,
  ) {}
  readonly name = 'flaky';
  models(): ModelCard[] {
    return [];
  }
  isConfigured(): boolean {
    return true;
  }
  async complete(): Promise<CompletionResponse> {
    this.calls += 1;
    if (this.calls <= this.failures) {
      throw new MegaError(
        'RATE_LIMITED',
        `${this.kind} rate limited`,
        this.retryAfterMs ? { retryAfterMs: this.retryAfterMs } : {},
      );
    }
    return {
      text: 'ok',
      provider: this.kind,
      model: 'flaky-1',
      stopReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

test('limit tracker enforces rpm and daily tokens with cooldowns', () => {
  const clock = new ManualClock(0);
  const limits = new LimitTracker(clock);
  limits.configure('p', { requestsPerMinute: 2, tokensPerDay: 100 });

  assert.equal(limits.check('p').allowed, true);
  limits.recordRequest('p', { inputTokens: 10, outputTokens: 10 });
  limits.recordRequest('p', { inputTokens: 10, outputTokens: 10 });
  assert.equal(limits.check('p').allowed, false);
  clock.advance(61_000);
  assert.equal(limits.check('p').allowed, true);
  assert.equal(limits.check('p', 90).allowed, false); // 40 used today + 90 > 100

  limits.markExhausted('p', 5_000);
  assert.equal(limits.isExhausted('p'), true);
  clock.advance(6_000);
  assert.equal(limits.isExhausted('p'), false);
});

test('a rate-limited provider is retried before anyone else is asked', async () => {
  // One 429 used to end it: the provider was written off for a minute and the
  // next thing in the chain answered — which, for a single-key setup, is the
  // offline mock. A whole 14-request delivery was produced that way.
  const registry = new ProviderRegistry();
  const gemini = new FlakyProvider('gemini', 2);
  registry.register(gemini);
  registry.register(new MockProvider({ kind: 'mock' }));
  const waits: number[] = [];
  const sessions = new AiSessionManager({
    sleep: async (ms) => {
      waits.push(ms);
    },
    providers: registry,
    limits: new LimitTracker(),
    fallbackChain: ['gemini', 'mock'],
  });

  const response = await sessions.completeWithFallback(REQUEST);
  assert.equal(response.provider, 'gemini', 'the real provider answered — the mock was never reached');
  assert.equal(gemini.calls, 3, 'two refusals, then the call that worked');
  assert.deepEqual(waits, [1_000, 2_000], 'backoff doubles between attempts');
  assert.equal(sessions.providerTallies()[0]?.kind, 'gemini');
});

test('the wait honours the delay the provider itself asked for', async () => {
  const registry = new ProviderRegistry();
  registry.register(new FlakyProvider('gemini', 1, 27_000));
  registry.register(new MockProvider({ kind: 'mock' }));
  const waits: number[] = [];
  const sessions = new AiSessionManager({
    sleep: async (ms) => {
      waits.push(ms);
    },
    providers: registry,
    limits: new LimitTracker(),
    fallbackChain: ['gemini', 'mock'],
  });

  const response = await sessions.completeWithFallback(REQUEST);
  assert.equal(response.provider, 'gemini');
  assert.deepEqual(waits, [27_000], 'Retry-After / RetryInfo beats the default backoff');
});

test('a wait longer than the budget falls through instead of stalling the run', async () => {
  const registry = new ProviderRegistry();
  registry.register(new FlakyProvider('gemini', 1, 600_000));
  registry.register(new MockProvider({ kind: 'mock' }));
  const sessions = new AiSessionManager({
    sleep: NO_WAIT,
    providers: registry,
    limits: new LimitTracker(),
    fallbackChain: ['gemini', 'mock'],
    rateLimitWaitMs: 60_000,
  });
  const response = await sessions.completeWithFallback(REQUEST);
  assert.equal(response.provider, 'mock', 'a ten-minute wait is not worth blocking a delivery for');
  assert.equal(sessions.limits.isExhausted('gemini'), true);
});

test('retries are bounded — a provider that never recovers still falls through', async () => {
  const registry = new ProviderRegistry();
  const gemini = new FlakyProvider('gemini', Number.POSITIVE_INFINITY);
  registry.register(gemini);
  registry.register(new MockProvider({ kind: 'mock' }));
  const sessions = new AiSessionManager({
    sleep: NO_WAIT,
    providers: registry,
    limits: new LimitTracker(),
    fallbackChain: ['gemini', 'mock'],
    rateLimitRetries: 2,
  });
  const response = await sessions.completeWithFallback(REQUEST);
  assert.equal(response.provider, 'mock');
  assert.equal(gemini.calls, 3, 'the first call plus two retries');
});

test('the offline mock is never waited for', async () => {
  // Waiting exists to protect a real delivery. Standing in a queue for the
  // simulator would only delay placeholder output.
  const registry = new ProviderRegistry();
  registry.register(new FlakyProvider('mock', 1));
  const waits: number[] = [];
  const sessions = new AiSessionManager({
    sleep: async (ms) => {
      waits.push(ms);
    },
    providers: registry,
    limits: new LimitTracker(),
    fallbackChain: ['mock'],
  });
  await assert.rejects(sessions.completeWithFallback(REQUEST), /PROVIDER_UNAVAILABLE|All providers/);
  assert.deepEqual(waits, []);
});

test('an exhausted provider is skipped, and eligible again after its cooldown', async () => {
  const clock = new ManualClock(0);
  const registry = new ProviderRegistry();
  const primary = new FlakyProvider('primary', Number.POSITIVE_INFINITY);
  registry.register(primary);
  registry.register(new MockProvider({ kind: 'backup' }));
  const sessions = new AiSessionManager({
    sleep: NO_WAIT,
    providers: registry,
    models: new ModelRegistry([
      { id: 'b-model', provider: 'backup', displayName: 'B', tier: 'balanced', contextWindow: 1, maxOutputTokens: 1, inputCostPerMTok: 0, outputCostPerMTok: 0 },
    ]),
    limits: new LimitTracker(clock),
    fallbackChain: ['primary', 'backup'],
    rateLimitRetries: 0,
    clock,
  });

  const first = await sessions.completeWithFallback(REQUEST);
  assert.equal(first.provider, 'backup');
  assert.equal(sessions.limits.isExhausted('primary'), true);

  // While exhausted the primary is not called at all.
  const before = primary.calls;
  const second = await sessions.completeWithFallback(REQUEST);
  assert.equal(second.provider, 'backup');
  assert.equal(primary.calls, before);

  // After the cooldown it is tried again, and the chain still recovers.
  clock.advance(61_000);
  const third = await sessions.completeWithFallback(REQUEST);
  assert.equal(third.provider, 'backup');
  assert.equal(primary.calls, before + 1);
});

test('refusals and hard provider failures also fall through', async () => {
  const registry = new ProviderRegistry();
  registry.register(new MockProvider({ kind: 'refuser', alwaysFail: 'PROVIDER_REFUSED' }));
  registry.register(new MockProvider({ kind: 'down', alwaysFail: 'PROVIDER_UNAVAILABLE' }));
  registry.register(new MockProvider({ kind: 'mock' }));
  const sessions = new AiSessionManager({
    sleep: NO_WAIT,
    providers: registry,
    limits: new LimitTracker(),
    fallbackChain: ['refuser', 'down', 'mock'],
  });
  const response = await sessions.completeWithFallback(REQUEST);
  assert.equal(response.provider, 'mock');
});

test('when every provider fails the error lists the attempts', async () => {
  const registry = new ProviderRegistry();
  registry.register(new MockProvider({ kind: 'only', alwaysFail: 'RATE_LIMITED' }));
  const sessions = new AiSessionManager({
    sleep: NO_WAIT,
    providers: registry,
    limits: new LimitTracker(),
    fallbackChain: ['only'],
  });
  await assert.rejects(sessions.completeWithFallback(REQUEST), (err: unknown) => {
    assert.ok(err instanceof MegaError);
    assert.equal(err.code, 'PROVIDER_UNAVAILABLE');
    assert.match(err.message, /only: RATE_LIMITED/);
    return true;
  });
});

test('sessions carry leases and record usage', async () => {
  const registry = new ProviderRegistry();
  registry.register(new MockProvider());
  const sessions = new AiSessionManager({
    sleep: NO_WAIT,
    providers: registry,
    limits: new LimitTracker(),
    fallbackChain: ['mock'],
  });
  const session = sessions.acquire({ purpose: 'test', complexity: 'trivial' });
  assert.equal(sessions.activeSessionCount(), 1);
  const response = await session.complete(REQUEST);
  assert.equal(response.provider, 'mock');
  session.release();
  assert.equal(sessions.activeSessionCount(), 0);
  assert.equal(sessions.usage().requests, 1);
  assert.ok(sessions.usage().inputTokens > 0);
});

test('the books show who answered and who refused', async () => {
  // A run that silently falls all the way through to the mock still finishes
  // every task and still reports success. The per-provider tally is the only
  // thing that can tell that delivery apart from a real one.
  const registry = new ProviderRegistry();
  registry.register(new MockProvider({ kind: 'gemini', alwaysFail: 'RATE_LIMITED' }));
  registry.register(new MockProvider({ kind: 'mock' }));
  const sessions = new AiSessionManager({
    sleep: NO_WAIT,
    providers: registry,
    limits: new LimitTracker(),
    fallbackChain: ['gemini', 'mock'],
  });

  await sessions.completeWithFallback(REQUEST);
  await sessions.completeWithFallback(REQUEST);

  const tallies = sessions.providerTallies();
  assert.equal(tallies.length, 1, 'only the provider that actually answered is tallied');
  assert.equal(tallies[0]?.kind, 'mock');
  assert.equal(tallies[0]?.requests, 2);
  assert.ok((tallies[0]?.inputTokens ?? 0) > 0);
  assert.equal(sessions.usage().requests, 2);

  const failures = sessions.providerFailures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.kind, 'gemini');
  assert.equal(failures[0]?.code, 'RATE_LIMITED');
  assert.ok(failures[0]?.message.length > 0, 'the reason is kept, so the dashboard can show it');
  // The first completion tries gemini five times (once plus four retries)
  // before giving up; the second finds it cooling down and skips it entirely.
  assert.equal(failures[0]?.count, 5, 'every refusal is counted, so a flapping key is visible');
});

test('a healthy provider leaves no failures behind', async () => {
  const registry = new ProviderRegistry();
  registry.register(new MockProvider({ kind: 'gemini' }));
  registry.register(new MockProvider({ kind: 'mock' }));
  const sessions = new AiSessionManager({
    sleep: NO_WAIT,
    providers: registry,
    limits: new LimitTracker(),
    fallbackChain: ['gemini', 'mock'],
  });
  await sessions.completeWithFallback(REQUEST);
  assert.deepEqual(sessions.providerFailures(), []);
  assert.equal(sessions.providerTallies()[0]?.kind, 'gemini');
});
