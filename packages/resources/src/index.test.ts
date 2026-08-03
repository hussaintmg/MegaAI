import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResourceSnapshot } from '@megaai/types';
import { createEventBus } from '@megaai/events';
import { classifyPressure, defaultThresholds, ResourceMonitor, sampleResources } from './index.js';

function snapshot(overrides: Partial<ResourceSnapshot>): ResourceSnapshot {
  return {
    timestamp: 0,
    cpuCount: 8,
    cpuLoad: 0.1,
    memTotalBytes: 100,
    memFreeBytes: 90,
    memUsedPct: 10,
    ...overrides,
  };
}

test('pressure classification honours thresholds', () => {
  assert.equal(classifyPressure(snapshot({}), defaultThresholds), 'ok');
  assert.equal(classifyPressure(snapshot({ memUsedPct: 85 }), defaultThresholds), 'elevated');
  assert.equal(classifyPressure(snapshot({ memUsedPct: 95 }), defaultThresholds), 'critical');
  assert.equal(classifyPressure(snapshot({ cpuLoad: 1.5 }), defaultThresholds), 'critical');
});

test('sampleResources returns a sane live snapshot', () => {
  const live = sampleResources();
  assert.ok(live.cpuCount >= 1);
  assert.ok(live.memTotalBytes > 0);
  assert.ok(live.memUsedPct >= 0 && live.memUsedPct <= 100);
});

test('monitor emits pressure transitions and adapts concurrency', () => {
  const bus = createEventBus();
  let next = snapshot({});
  const monitor = new ResourceMonitor({ bus, sampler: () => next });
  const transitions: string[] = [];
  bus.on<{ from: string; to: string }>('resources.pressure', (event) =>
    transitions.push(`${event.payload.from}->${event.payload.to}`),
  );

  assert.equal(monitor.sample(), 'ok');
  assert.equal(monitor.recommendedConcurrency(4), 4);

  next = snapshot({ memUsedPct: 85 });
  assert.equal(monitor.sample(), 'elevated');
  assert.equal(monitor.recommendedConcurrency(4), 2);

  next = snapshot({ memUsedPct: 96 });
  assert.equal(monitor.sample(), 'critical');
  assert.equal(monitor.recommendedConcurrency(4), 1);

  assert.deepEqual(transitions, ['ok->elevated', 'elevated->critical']);
});
