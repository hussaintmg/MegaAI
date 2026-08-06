import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '@megaai/utils';
import { KeyRing, collectKeys, labelForKey } from './keyring.js';
import { GeminiProvider } from './providers/gemini.js';

test('keys are used in order, and a rate-limited one steps aside', () => {
  const clock = new ManualClock(0);
  const ring = new KeyRing(['aaaa1111', 'bbbb2222', 'cccc3333'], { clock });

  assert.equal(ring.current()?.index, 0);
  ring.park(0, 'rate limited', clock.now() + 60_000);
  assert.equal(ring.current()?.index, 1, 'the next key takes over');

  ring.park(1, 'rate limited', clock.now() + 30_000);
  assert.equal(ring.current()?.index, 2);

  clock.advance(30_001);
  assert.equal(ring.current()?.index, 1, 'and a key comes back on its own when its window passes');
});

test('when every key is spent it says when the first one returns', () => {
  const clock = new ManualClock(0);
  const ring = new KeyRing(['a1', 'b2'], { clock });
  ring.park(0, 'limited', clock.now() + 120_000);
  ring.park(1, 'limited', clock.now() + 45_000);

  assert.equal(ring.current(), undefined);
  assert.equal(ring.readyAt(), 45_000, 'the soonest, so the caller waits the shortest time that helps');
  assert.match(ring.explain(), /2 of 2 key\(s\) rate limited/);
});

test('a key the provider rejects is out for good, not retried every minute', () => {
  // Retrying a typo once a minute for a week is noise, and the person who
  // pasted it needs to be told rather than protected from the news.
  const clock = new ManualClock(0);
  const ring = new KeyRing(['typo', 'good'], { clock });
  ring.reject(0, 'invalid api key');

  assert.equal(ring.current()?.index, 1);
  clock.advance(24 * 3_600_000);
  assert.equal(ring.current()?.index, 1, 'still not the rejected one');
  assert.match(ring.explain(), /was rejected: invalid api key/);
});

test('all keys rejected is not something waiting will fix', () => {
  const ring = new KeyRing(['a', 'b'], { clock: new ManualClock(0) });
  ring.reject(0, 'invalid');
  ring.reject(1, 'invalid');
  assert.equal(ring.current(), undefined);
  assert.equal(ring.readyAt(), undefined, 'no reset time, because no reset would help');
});

test('the same key pasted twice is one key', () => {
  // Otherwise the ring reports headroom that does not exist, and the second
  // "key" hits the limit the instant the first one did.
  assert.deepEqual(collectKeys({ apiKeys: ['same', 'same', 'other'], apiKey: 'same' }), ['same', 'other']);
  assert.deepEqual(collectKeys({ apiKey: '  spaced  ' }), ['spaced']);
  assert.deepEqual(collectKeys({}), []);
});

test('a key is labelled by its last four characters, never by its value', () => {
  const label = labelForKey('AIzaSyC-not-a-real-key-9f3K', 0);
  assert.match(label, /key 1 \(…9f3K\)/);
  assert.ok(!label.includes('AIzaSy'), 'the front of a key never appears anywhere it could be read');
});

/* ---------------- the provider actually rotating ---------------- */

/** A fetch that answers from a script and records which key was used. */
function scriptedFetch(replies: Array<{ status: number; body: string }>) {
  const keysSeen: string[] = [];
  const fetchImpl = async (_url: string, init: { headers: Record<string, string> }): Promise<Response> => {
    keysSeen.push(init.headers['x-goog-api-key'] ?? '');
    const reply = replies.shift() ?? { status: 200, body: '{}' };
    return new Response(reply.body, { status: reply.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, keysSeen };
}

test('one spent key costs a key, not the provider', async (t) => {
  // The failure this exists to stop: Gemini written off because its first key
  // is rate limited, while two more sit unused.
  const { fetchImpl, keysSeen } = scriptedFetch([
    { status: 429, body: '{"error":{"message":"quota"}}' },
    { status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] }) },
  ]);
  t.mock.method(globalThis, 'fetch', fetchImpl);

  const provider = new GeminiProvider({ apiKeys: ['first-key', 'second-key'] });
  const response = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(response.text, 'hello');
  assert.deepEqual(keysSeen, ['first-key', 'second-key'], 'the second key was tried inside the same request');
});

test('a rate limit is only reported once every key is spent, with the wait', async (t) => {
  const { fetchImpl, keysSeen } = scriptedFetch([
    { status: 429, body: '{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"30s"}]}}' },
    { status: 429, body: '{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"12s"}]}}' },
  ]);
  t.mock.method(globalThis, 'fetch', fetchImpl);

  const provider = new GeminiProvider({ apiKeys: ['one', 'two'] });
  await assert.rejects(
    provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    (error: unknown) => {
      const megaError = error as { code: string; message: string; details: Record<string, unknown> };
      assert.equal(megaError.code, 'RATE_LIMITED');
      assert.match(megaError.message, /2 of 2 key\(s\) rate limited/);
      // The shorter of the two waits, because that is when work can resume.
      assert.ok((megaError.details['retryAfterMs'] as number) <= 12_000);
      return true;
    },
  );
  assert.equal(keysSeen.length, 2, 'both were tried before giving up');
});

test('a rejected key is skipped and the good one still answers', async (t) => {
  const { fetchImpl, keysSeen } = scriptedFetch([
    { status: 401, body: '{"error":{"message":"API key not valid"}}' },
    { status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'fine' }] } }] }) },
  ]);
  t.mock.method(globalThis, 'fetch', fetchImpl);

  const provider = new GeminiProvider({ apiKeys: ['bad', 'good'] });
  assert.equal((await provider.complete({ messages: [{ role: 'user', content: 'hi' }] })).text, 'fine');
  assert.deepEqual(keysSeen, ['bad', 'good']);
  assert.equal(provider.keys.snapshot()[0]?.rejected, true, 'and the bad one is not tried again');
});

test('an ordinary error is not blamed on the key', async (t) => {
  // A 500 is the provider having a bad minute. Parking a perfectly good key
  // over it would throw away allowance for no reason.
  const { fetchImpl, keysSeen } = scriptedFetch([{ status: 500, body: 'upstream exploded' }]);
  t.mock.method(globalThis, 'fetch', fetchImpl);

  const provider = new GeminiProvider({ apiKeys: ['one', 'two'] });
  await assert.rejects(provider.complete({ messages: [{ role: 'user', content: 'hi' }] }), /Gemini error 500/);
  assert.equal(keysSeen.length, 1, 'it does not burn through the ring on a server error');
  assert.equal(provider.keys.snapshot()[0]?.parkedUntil, undefined);
});
