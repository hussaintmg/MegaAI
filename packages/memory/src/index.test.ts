import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '@megaai/utils';
import { MemoryDatabase } from '@megaai/database';
import { cosine, embed, KnowledgeBase, MemoryEngine } from './index.js';

test('embeddings put similar texts closer than unrelated ones', () => {
  const checkout = embed('checkout flow with cart and payments');
  const similar = embed('payment and cart checkout implementation');
  const unrelated = embed('quantum entanglement in superconductors');
  assert.ok(cosine(checkout, similar) > cosine(checkout, unrelated));
});

test('search returns the most relevant memory first', async () => {
  const memory = new MemoryEngine(new MemoryDatabase());
  await memory.remember({ scope: 'project', refId: 'p1', text: 'Implemented the checkout flow with cart totals' });
  await memory.remember({ scope: 'project', refId: 'p1', text: 'Marketing copy drafted for launch day' });
  await memory.remember({ scope: 'project', refId: 'p2', text: 'Checkout in another project' });

  const hits = await memory.search('cart checkout', { refId: 'p1' });
  assert.ok(hits.length >= 1);
  assert.match(hits[0]!.record.text, /checkout flow/);
  for (const hit of hits) assert.equal(hit.record.refId, 'p1');
});

test('recall filters by scope, ref and tag, newest first', async () => {
  const clock = new ManualClock(1_000);
  const memory = new MemoryEngine(new MemoryDatabase(), undefined, clock);
  await memory.remember({ scope: 'agent', refId: 'a1', text: 'first', tags: ['x'] });
  clock.advance(10);
  await memory.remember({ scope: 'agent', refId: 'a1', text: 'second', tags: ['y'] });
  const all = await memory.recall({ scope: 'agent', refId: 'a1' });
  assert.deepEqual(
    all.map((record) => record.text),
    ['second', 'first'],
  );
  const tagged = await memory.recall({ tag: 'x' });
  assert.equal(tagged.length, 1);
  assert.equal(await memory.count('agent'), 2);
});

test('knowledge base stores and finds documents', async () => {
  const memory = new MemoryEngine(new MemoryDatabase());
  const knowledge = new KnowledgeBase(memory);
  await knowledge.addDocument('Deployment policy', 'Deployments require approval and a rollback plan');
  const hits = await knowledge.search('rollback approval deployments');
  assert.ok(hits.length >= 1);
  assert.match(hits[0]!.record.text, /Deployment policy/);
});
