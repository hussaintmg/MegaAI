import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlanSpec } from '@megaai/types';
import { MemoryDatabase } from '@megaai/database';
import { PlanningService } from './index.js';

const PLAN: PlanSpec = {
  projectName: 'Two-phase build',
  domain: 'generic',
  summary: 'test plan',
  risks: [],
  questionsForHuman: [],
  phases: [
    {
      name: 'Phase A',
      tasks: [
        { title: 'A1', description: '', agentKind: 'coding', complexity: 'standard' },
        { title: 'A2', description: '', agentKind: 'coding', complexity: 'standard' },
      ],
    },
    {
      name: 'Phase B',
      tasks: [{ title: 'B1', description: '', agentKind: 'testing', complexity: 'standard' }],
    },
  ],
};

test('materialized phases run sequentially through dependencies', async () => {
  const planning = new PlanningService(new MemoryDatabase());
  const { project, tasks } = await planning.materializePlan(PLAN, 'goal');
  assert.equal(tasks.length, 3);

  // Only phase A is ready at the start.
  let ready = await planning.readyTasks(project.id);
  assert.deepEqual(ready.map((task) => task.title).sort(), ['A1', 'A2']);

  const a1 = await planning.claimNextTask(project.id);
  const a2 = await planning.claimNextTask(project.id);
  assert.equal(await planning.claimNextTask(project.id), undefined); // B1 not ready yet
  await planning.completeTask(a1!.id, { summary: 'done' });
  await planning.completeTask(a2!.id, { summary: 'done' });

  ready = await planning.readyTasks(project.id);
  assert.deepEqual(ready.map((task) => task.title), ['B1']);
});

test('failing a task retries until attempts run out, then blocks dependents', async () => {
  const planning = new PlanningService(new MemoryDatabase());
  const { project } = await planning.materializePlan(PLAN, 'goal');

  // Fail A1 repeatedly (maxAttempts defaults to 2).
  const first = await planning.claimNextTask(project.id);
  await planning.failTask(first!.id, 'boom 1');
  let again = await planning.getTask(first!.id);
  assert.equal(again?.state, 'pending'); // retry available

  // Claim order is priority+age based; drain until we reclaim A1.
  let reclaimed = await planning.claimNextTask(project.id);
  while (reclaimed && reclaimed.id !== first!.id) {
    await planning.completeTask(reclaimed.id, {});
    reclaimed = await planning.claimNextTask(project.id);
  }
  await planning.failTask(first!.id, 'boom 2');
  again = await planning.getTask(first!.id);
  assert.equal(again?.state, 'failed');

  // With A1 permanently failed, B1 becomes blocked (not ready).
  const ready = await planning.readyTasks(project.id);
  assert.equal(ready.find((task) => task.title === 'B1'), undefined);
  const all = await planning.tasksOf(project.id);
  assert.equal(all.find((task) => task.title === 'B1')?.state, 'blocked');
  const progress = await planning.progressOf(project.id);
  assert.equal(progress.failed >= 1, true);
});

test('project completes when every task completes', async () => {
  const planning = new PlanningService(new MemoryDatabase());
  const { project } = await planning.materializePlan(PLAN, 'goal');
  for (;;) {
    const task = await planning.claimNextTask(project.id);
    if (!task) break;
    await planning.completeTask(task.id, {});
  }
  const done = await planning.getProject(project.id);
  assert.equal(done?.status, 'completed');
  assert.equal(done?.progress, 1);
});
