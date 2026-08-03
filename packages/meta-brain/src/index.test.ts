import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDatabase } from '@megaai/database';
import { analyzeGoal, generatePlan, MetaBrain } from './index.js';

test('goal analysis detects domains and features', () => {
  assert.equal(analyzeGoal('Build the client a complete ecommerce store with checkout').domain, 'ecommerce');
  assert.equal(analyzeGoal('An ERP with inventory and accounting').domain, 'erp');
  assert.equal(analyzeGoal('A REST api for bookings').domain, 'api');
  assert.equal(analyzeGoal('Personal portfolio website').domain, 'website');
  assert.equal(analyzeGoal('Something entirely different').domain, 'generic');
  assert.deepEqual(analyzeGoal('shop with auth and payment').features, ['auth', 'payment']);
});

test('generated plans are phased, typed and end with delivery work', () => {
  const plan = generatePlan('Build an ecommerce store for a client');
  assert.equal(plan.domain, 'ecommerce');
  assert.ok(plan.phases.length >= 4);
  const kinds = new Set(plan.phases.flatMap((phase) => phase.tasks.map((task) => task.agentKind)));
  for (const expected of ['research', 'coding', 'testing', 'documentation', 'devops']) {
    assert.ok(kinds.has(expected), `plan should include a ${expected} task`);
  }
});

test('meta brain rejects empty goals and records decisions', () => {
  const meta = new MetaBrain({ database: new MemoryDatabase() });
  assert.throws(() => meta.plan('  '), /non-empty/);
  const plan = meta.plan('Build a small api');
  assert.equal(plan.domain, 'api');
});

test('escalates complexity after failed attempts', async () => {
  const meta = new MetaBrain({ database: new MemoryDatabase() });
  const base = {
    id: 't1', projectId: 'p', title: 'x', description: '', agentKind: 'coding',
    state: 'in-progress' as const, priority: 'normal' as const, dependsOn: [], maxAttempts: 3,
    createdAt: 0, updatedAt: 0,
  };
  assert.equal(await meta.complexityFor({ ...base, complexity: 'standard', attempts: 1 }), 'standard');
  assert.equal(await meta.complexityFor({ ...base, complexity: 'standard', attempts: 2 }), 'complex');
  assert.equal(await meta.complexityFor({ ...base, complexity: 'complex', attempts: 2 }), 'frontier');
});

test('learning stats aggregate per agent and provider', async () => {
  const meta = new MetaBrain({ database: new MemoryDatabase() });
  await meta.recordOutcome({ projectId: 'p', taskId: 't1', agentKind: 'coding', provider: 'mock', model: 'm', ok: true, durationMs: 100 });
  await meta.recordOutcome({ projectId: 'p', taskId: 't2', agentKind: 'coding', provider: 'mock', model: 'm', ok: false, durationMs: 300, error: 'x' });
  const stats = await meta.stats();
  assert.equal(stats.totalRuns, 2);
  assert.equal(stats.byAgent.coding?.runs, 2);
  assert.equal(stats.byAgent.coding?.successRate, 0.5);
  assert.equal(stats.byAgent.coding?.avgDurationMs, 200);
  assert.equal(stats.byProvider.mock?.successes, 1);
});
