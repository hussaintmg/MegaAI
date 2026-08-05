import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '@megaai/utils';
import { MegaError } from '@megaai/types';
import { LimitTracker } from './limits.js';
import { AiSessionManager, ProviderRegistry } from './sessions.js';
import { MockProvider } from './providers/mock.js';
import { ModelRegistry } from './models.js';

const REQUEST = { messages: [{ role: 'user' as const, content: 'hello' }] };

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

test('session manager falls through the chain on rate limits', async () => {
  const clock = new ManualClock(0);
  const registry = new ProviderRegistry();
  const primary = new MockProvider({ kind: 'primary', rateLimitAfter: 1 });
  const backup = new MockProvider({ kind: 'backup' });
  registry.register(primary);
  registry.register(backup);

  const sessions = new AiSessionManager({
    providers: registry,
    models: new ModelRegistry([
      { id: 'p-model', provider: 'primary', displayName: 'P', tier: 'balanced', contextWindow: 1, maxOutputTokens: 1, inputCostPerMTok: 0, outputCostPerMTok: 0 },
      { id: 'b-model', provider: 'backup', displayName: 'B', tier: 'balanced', contextWindow: 1, maxOutputTokens: 1, inputCostPerMTok: 0, outputCostPerMTok: 0 },
    ]),
    limits: new LimitTracker(clock),
    fallbackChain: ['primary', 'backup'],
    clock,
  });

  const first = await sessions.completeWithFallback(REQUEST);
  assert.equal(first.provider, 'primary');

  // Second request rate-limits the primary → served by backup, primary cools down.
  const second = await sessions.completeWithFallback(REQUEST);
  assert.equal(second.provider, 'backup');
  assert.equal(sessions.limits.isExhausted('primary'), true);

  // While exhausted, requests skip the primary entirely (no attempt made).
  const attemptsBefore = primary.requestsServed();
  const third = await sessions.completeWithFallback(REQUEST);
  assert.equal(third.provider, 'backup');
  assert.equal(primary.requestsServed(), attemptsBefore);

  // After the cooldown the primary becomes eligible again: it is attempted
  // (still rate-limited in this simulation), and the chain still recovers.
  clock.advance(61_000);
  const fourth = await sessions.completeWithFallback(REQUEST);
  assert.equal(fourth.provider, 'backup');
  assert.equal(primary.requestsServed(), attemptsBefore + 1);
});

test('refusals and hard provider failures also fall through', async () => {
  const registry = new ProviderRegistry();
  registry.register(new MockProvider({ kind: 'refuser', alwaysFail: 'PROVIDER_REFUSED' }));
  registry.register(new MockProvider({ kind: 'down', alwaysFail: 'PROVIDER_UNAVAILABLE' }));
  registry.register(new MockProvider({ kind: 'mock' }));
  const sessions = new AiSessionManager({
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
  // The second attempt is skipped by the cooldown, so the count stays at 1.
  assert.equal(failures[0]?.count, 1);
});

test('a healthy provider leaves no failures behind', async () => {
  const registry = new ProviderRegistry();
  registry.register(new MockProvider({ kind: 'gemini' }));
  registry.register(new MockProvider({ kind: 'mock' }));
  const sessions = new AiSessionManager({
    providers: registry,
    limits: new LimitTracker(),
    fallbackChain: ['gemini', 'mock'],
  });
  await sessions.completeWithFallback(REQUEST);
  assert.deepEqual(sessions.providerFailures(), []);
  assert.equal(sessions.providerTallies()[0]?.kind, 'gemini');
});
