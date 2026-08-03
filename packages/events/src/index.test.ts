import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus } from './index.js';

test('exact, wildcard and prefix subscriptions all fire', () => {
  const bus = createEventBus();
  const seen: string[] = [];
  bus.on('workflow.step.started', () => seen.push('exact'));
  bus.on('workflow.*', () => seen.push('prefix'));
  bus.on('*', () => seen.push('all'));
  bus.emit('workflow.step.started', { step: 'x' });
  assert.deepEqual(seen.sort(), ['all', 'exact', 'prefix']);
});

test('once unsubscribes after the first event', () => {
  const bus = createEventBus();
  let count = 0;
  bus.once('tick', () => {
    count += 1;
  });
  bus.emit('tick', {});
  bus.emit('tick', {});
  assert.equal(count, 1);
});

test('handler errors are isolated from other subscribers', () => {
  const errors: string[] = [];
  const bus = createEventBus({ onHandlerError: (err) => errors.push(String(err)) });
  let delivered = false;
  bus.on('boom', () => {
    throw new Error('bad handler');
  });
  bus.on('boom', () => {
    delivered = true;
  });
  bus.emit('boom', {});
  assert.equal(delivered, true);
  assert.equal(errors.length, 1);
});

test('history keeps recent events and supports pattern filters', () => {
  const bus = createEventBus({ historyLimit: 3 });
  bus.emit('a.one', 1);
  bus.emit('b.two', 2);
  bus.emit('a.three', 3);
  bus.emit('a.four', 4);
  assert.equal(bus.history().length, 3);
  assert.deepEqual(
    bus.history('a.*').map((event) => event.type),
    ['a.three', 'a.four'],
  );
});

test('waitFor resolves on match and times out otherwise', async () => {
  const bus = createEventBus();
  const waiting = bus.waitFor<{ n: number }>('data.*', { predicate: (event) => event.payload.n > 1 });
  bus.emit('data.point', { n: 1 });
  bus.emit('data.point', { n: 2 });
  const event = await waiting;
  assert.equal(event.payload.n, 2);
  await assert.rejects(bus.waitFor('never', { timeoutMs: 20 }), /Timed out/);
});
