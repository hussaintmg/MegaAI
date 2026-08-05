import test from 'node:test';
import assert from 'node:assert/strict';
import type { CompletionRequest, CompletionResponse } from '@megaai/types';
import { MemoryDatabase } from '@megaai/database';
import { analyzeGoal, generatePlan, MetaBrain, parsePlanSpec } from './index.js';

function fakeResponse(text: string): CompletionResponse {
  return { text, provider: 'mock', model: 'm', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
}

test('goal analysis detects domains and features', () => {
  assert.equal(analyzeGoal('Build the client a complete ecommerce store with checkout').domain, 'ecommerce');
  assert.equal(analyzeGoal('An ERP with inventory and accounting').domain, 'erp');
  assert.equal(analyzeGoal('A REST api for bookings').domain, 'api');
  assert.equal(analyzeGoal('Personal portfolio website').domain, 'website');
  assert.equal(analyzeGoal('Something entirely different').domain, 'generic');
  assert.deepEqual(analyzeGoal('shop with auth and payment').features, ['auth', 'payments']);
});

test('domain keywords match whole words, never substrings', () => {
  // Each of these used to be misdetected: "api" hides inside rapid/therapist/
  // capital, and "shop" inside workshop and "coffee shop".
  assert.equal(analyzeGoal('Build a rapid prototype of a note-taking tool').domain, 'generic');
  assert.equal(analyzeGoal('Create a portfolio website for a therapist').domain, 'website');
  assert.equal(analyzeGoal('Make a blog about capital markets').domain, 'website');
  assert.equal(analyzeGoal('Design a workshop booking website').domain, 'website');
});

test('the strongest signal wins when a goal mentions several domains', () => {
  // "landing page" (5) beats an incidental "shop" (1) — this exact goal used
  // to produce a full ecommerce plan with a cart and a product catalog.
  assert.equal(analyzeGoal('Build a simple landing page for a coffee shop').domain, 'website');
  // …but a real store still wins, even though it also says "page".
  assert.equal(analyzeGoal('An online store page with a shopping cart and checkout').domain, 'ecommerce');
  assert.equal(analyzeGoal('A GraphQL microservice backend for orders').domain, 'api');
});

test('features are detected through their common variants', () => {
  const features = analyzeGoal('store with authentication, subscriptions, an admin panel and reporting').features;
  assert.ok(features.includes('auth'), 'authentication should map to auth');
  assert.ok(features.includes('payments'), 'subscriptions should map to payments');
  assert.ok(features.includes('admin'));
  assert.ok(features.includes('reports'), 'reporting should map to reports');
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

test('parsePlanSpec sanitises model output and rejects junk', () => {
  const good = parsePlanSpec(
    '```json\n' +
      JSON.stringify({
        projectName: 'Shop',
        domain: 'ecommerce',
        summary: 's',
        phases: [
          { name: 'A', tasks: [{ title: 'T1', description: 'd', agentKind: 'coding', complexity: 'complex' }] },
          { name: 'B', tasks: [{ title: 'T2', agentKind: 'not-a-real-kind', complexity: 'weird', dependsOnTitles: ['T1', 42] }] },
        ],
      }) +
      '\n```',
    'build a shop',
  );
  assert.ok(good);
  assert.equal(good!.phases.length, 2);
  // Unknown agentKind coerces to coding; bad complexity to standard; non-string dep dropped.
  const t2 = good!.phases[1]!.tasks[0]!;
  assert.equal(t2.agentKind, 'coding');
  assert.equal(t2.complexity, 'standard');
  assert.deepEqual(t2.dependsOnTitles, ['T1']);

  assert.equal(parsePlanSpec('not json', 'g'), undefined);
  assert.equal(parsePlanSpec('{"phases":[]}', 'g'), undefined);
  assert.equal(parsePlanSpec('{"phases":[{"name":"x","tasks":[{}]}]}', 'g'), undefined);
});

test('makePlan uses the model when configured and materialises a real plan', async () => {
  const requests: CompletionRequest[] = [];
  const meta = new MetaBrain({
    database: new MemoryDatabase(),
    planner: 'model',
    complete: async (request) => {
      requests.push(request);
      return fakeResponse(
        JSON.stringify({
          projectName: 'From model',
          domain: 'model-generated',
          summary: 'planned by the model',
          phases: [{ name: 'Build', tasks: [{ title: 'Do it', agentKind: 'coding', complexity: 'complex' }] }],
        }),
      );
    },
  });
  const plan = await meta.makePlan('build something');
  assert.equal(plan.domain, 'model-generated');
  assert.equal(plan.phases[0]?.tasks[0]?.title, 'Do it');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.metadata?.planning, true);
});

test('makePlan falls back to templates when the model output is unusable or errors', async () => {
  const garbage = new MetaBrain({
    database: new MemoryDatabase(),
    planner: 'model',
    complete: async () => fakeResponse('the model said no json here'),
  });
  const fallback = await garbage.makePlan('build an ecommerce store');
  assert.equal(fallback.domain, 'ecommerce'); // template plan, not model

  const broken = new MetaBrain({
    database: new MemoryDatabase(),
    planner: 'model',
    complete: async () => {
      throw new Error('provider down');
    },
  });
  const recovered = await broken.makePlan('build an api');
  assert.equal(recovered.domain, 'api'); // template plan despite the model failing
});

test('makePlan uses templates by default (no model call)', async () => {
  let called = false;
  const meta = new MetaBrain({
    database: new MemoryDatabase(),
    complete: async () => {
      called = true;
      return fakeResponse('{}');
    },
  });
  const plan = await meta.makePlan('build an ecommerce store');
  assert.equal(plan.domain, 'ecommerce');
  assert.equal(called, false);
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
