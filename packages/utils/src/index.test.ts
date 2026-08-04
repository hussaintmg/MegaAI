import test from 'node:test';
import assert from 'node:assert/strict';
import { contentImageCount, contentText, deepMerge, extractJsonObject, ManualClock, retry, Semaphore, slugify } from './index.js';

test('retry succeeds after transient failures without real waiting', async () => {
  let calls = 0;
  const result = await retry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('flaky');
      return 'ok';
    },
    { attempts: 5, wait: async () => {} },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('retry rethrows when attempts are exhausted', async () => {
  await assert.rejects(
    retry(async () => Promise.reject(new Error('always')), { attempts: 2, wait: async () => {} }),
    /always/,
  );
});

test('extractJsonObject reads fenced and embedded JSON', () => {
  const fenced = extractJsonObject('prose\n```json\n{"a": 1}\n```\nmore');
  assert.deepEqual(fenced, { a: 1 });
  const embedded = extractJsonObject('The result is {"nested": {"b": "with } brace in string"}} trailing');
  assert.deepEqual(embedded, { nested: { b: 'with } brace in string' } });
  assert.equal(extractJsonObject('no json here'), undefined);
});

test('deepMerge merges objects and replaces scalars/arrays', () => {
  const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] } as Record<string, unknown>, {
    a: { c: 3 },
    list: [9],
  });
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9] });
});

test('contentText extracts text and contentImageCount counts images', () => {
  assert.equal(contentText('plain string'), 'plain string');
  assert.equal(contentImageCount('plain string'), 0);

  const multimodal = [
    { type: 'text' as const, text: 'look at this' },
    { type: 'image' as const, mimeType: 'image/png', data: 'YWJj' },
    { type: 'text' as const, text: ' and this' },
    { type: 'image' as const, mimeType: 'image/png', data: 'ZGVm' },
  ];
  assert.equal(contentText(multimodal), 'look at this and this');
  assert.equal(contentImageCount(multimodal), 2);
});

test('slugify produces safe names', () => {
  assert.equal(slugify('Build: an E-commerce Store!!'), 'build-an-e-commerce-store');
  assert.equal(slugify('***'), 'untitled');
});

test('Semaphore caps concurrency', async () => {
  const semaphore = new Semaphore(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      semaphore.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
      }),
    ),
  );
  assert.equal(peak, 2);
});

test('ManualClock advances deterministically', () => {
  const clock = new ManualClock(100);
  assert.equal(clock.now(), 100);
  clock.advance(50);
  assert.equal(clock.now(), 150);
});
