import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '@megaai/utils';
import { LimitTracker } from './limits.js';
import { parseRetryAfterBody, parseRetryAfterHeader, retryAfterFrom } from './retry-after.js';

const instant = async (): Promise<void> => undefined;

test('reserve takes a slot, so concurrent callers cannot all pass the same check', async () => {
  // Four agents run in parallel. Without reserving, every one of them reads
  // "0 requests used" before any of them records, and all four burst through
  // a two-per-minute limit in the same millisecond.
  const clock = new ManualClock(0);
  const limits = new LimitTracker(clock);
  limits.configure('gemini', { requestsPerMinute: 2 });

  const results = await Promise.all(
    Array.from({ length: 4 }, () => limits.reserve('gemini', 0, 0, instant)),
  );
  assert.deepEqual(
    results.map((r) => r.allowed),
    [true, true, false, false],
    'exactly the allowance gets through',
  );
});

test('reserve waits out the per-minute window rather than giving up', async () => {
  const clock = new ManualClock(0);
  const limits = new LimitTracker(clock);
  limits.configure('gemini', { requestsPerMinute: 1 });
  await limits.reserve('gemini', 0, 0, instant);

  const slept: number[] = [];
  // Standing in for real time: the sleep advances the clock, which is what
  // lets the window roll over.
  const sleep = async (ms: number) => {
    slept.push(ms);
    clock.advance(ms);
  };
  const second = await limits.reserve('gemini', 0, 120_000, sleep);
  assert.equal(second.allowed, true, 'the caller waited its turn instead of falling through');
  assert.ok(second.waitedMs > 0);
  assert.ok(slept[0] !== undefined && slept[0] > 59_000, `expected a ~60s wait, slept ${slept[0]}ms`);
});

test('reserve gives up when the wait exceeds the budget', async () => {
  const clock = new ManualClock(0);
  const limits = new LimitTracker(clock);
  limits.configure('gemini', { requestsPerMinute: 1 });
  await limits.reserve('gemini', 0, 0, instant);
  const second = await limits.reserve('gemini', 0, 5_000, instant);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'requests-per-minute');
});

test('reserve does not wait for a daily cap or a cooldown it cannot outlast', async () => {
  const clock = new ManualClock(0);
  const limits = new LimitTracker(clock);
  limits.configure('gemini', { tokensPerDay: 10 });
  const capped = await limits.reserve('gemini', 500, 120_000, instant);
  assert.equal(capped.allowed, false);
  assert.equal(capped.reason, 'tokens-per-day', 'tomorrow is not worth waiting for');

  limits.markExhausted('groq', 60_000);
  const cooling = await limits.reserve('groq', 0, 120_000, instant);
  assert.equal(cooling.allowed, false);
  assert.equal(cooling.reason, 'exhausted', 'a provider that already had its retries is skipped');
});

test('Retry-After is read in every dialect a provider might use', () => {
  const now = Date.parse('2026-08-05T16:00:00Z');
  assert.equal(parseRetryAfterHeader('30', now), 30_000);
  assert.equal(parseRetryAfterHeader('1.5', now), 1_500);
  assert.equal(parseRetryAfterHeader('Wed, 05 Aug 2026 16:00:45 GMT', now), 45_000);
  assert.equal(parseRetryAfterHeader('', now), undefined);
  assert.equal(parseRetryAfterHeader('soon', now), undefined);
  assert.equal(parseRetryAfterHeader('Wed, 05 Aug 2026 15:59:00 GMT', now), undefined, 'a past date is not a wait');
  // Clamped: a provider asking for an hour is telling us to go away.
  assert.equal(parseRetryAfterHeader('99999', now), 5 * 60_000);
});

test("Google's RetryInfo is read out of the error body", () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '27s' }],
    },
  });
  assert.equal(parseRetryAfterBody(body), 27_000);
  assert.equal(parseRetryAfterBody('{"retry_after": 12}'), 12_000);
  assert.equal(parseRetryAfterBody('{"retry_after_ms": 2500}'), 2_500);
  assert.equal(parseRetryAfterBody('not json at all'), undefined);
  assert.equal(parseRetryAfterBody(''), undefined);
});

test('the header wins over the body, and either beats nothing', () => {
  const withHeader = new Headers({ 'retry-after': '10' });
  assert.equal(retryAfterFrom(withHeader, '{"retryDelay":"27s"}'), 10_000);
  assert.equal(retryAfterFrom(new Headers(), '{"retryDelay":"27s"}'), 27_000);
  assert.equal(retryAfterFrom(new Headers(), ''), undefined);
});
