import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsRegistry, ServiceContainer } from './index.js';

test('container resolves lazy singletons and detects cycles', () => {
  const container = new ServiceContainer();
  let built = 0;
  container.register('config', () => {
    built += 1;
    return { port: 1 };
  });
  container.register('server', (c) => ({ config: c.get('config') }));
  assert.deepEqual(container.get('server'), { config: { port: 1 } });
  container.get('server');
  assert.equal(built, 1);

  container.register('a', (c) => c.get('b'));
  container.register('b', (c) => c.get('a'));
  assert.throws(() => container.get('a'), /Circular dependency/);
  assert.throws(() => container.get('missing'), /not registered/);
});

test('services start in order and stop in reverse', async () => {
  const container = new ServiceContainer();
  const order: string[] = [];
  for (const name of ['one', 'two', 'three']) {
    container.addService({
      name,
      start: () => {
        order.push(`start:${name}`);
      },
      stop: () => {
        order.push(`stop:${name}`);
      },
    });
  }
  await container.startAll();
  await container.stopAll();
  assert.deepEqual(order, ['start:one', 'start:two', 'start:three', 'stop:three', 'stop:two', 'stop:one']);
  assert.equal(container.serviceStateOf('two'), 'stopped');
});

test('a failing service start unwinds the ones already started', async () => {
  const container = new ServiceContainer();
  const order: string[] = [];
  container.addService({ name: 'ok', start: () => void order.push('start:ok'), stop: () => void order.push('stop:ok') });
  container.addService({
    name: 'broken',
    start: () => {
      throw new Error('nope');
    },
  });
  await assert.rejects(container.startAll(), /broken/);
  assert.deepEqual(order, ['start:ok', 'stop:ok']);
  assert.equal(container.serviceStateOf('broken'), 'failed');
});

test('metrics count, gauge and time', async () => {
  const metrics = new MetricsRegistry();
  metrics.inc('requests');
  metrics.inc('requests', 2);
  metrics.gauge('active', 7);
  metrics.observe('latency', 10);
  metrics.observe('latency', 30);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.requests, 3);
  assert.equal(snapshot.gauges.active, 7);
  assert.equal(snapshot.timers.latency?.count, 2);
  assert.equal(snapshot.timers.latency?.avgMs, 20);
  assert.equal(snapshot.timers.latency?.maxMs, 30);
});
