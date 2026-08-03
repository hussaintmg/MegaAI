import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDatabase } from '@megaai/database';
import { ApprovalManager } from '@megaai/policy';
import { WorkflowEngine, type WorkflowDefinition } from './index.js';

const instantWait = async (): Promise<void> => {};

test('steps retry with backoff and eventually succeed', async () => {
  const engine = new WorkflowEngine(new MemoryDatabase(), { wait: instantWait, maxStepAttempts: 3 });
  let attempts = 0;
  const run = await engine.start({
    name: 'retry-flow',
    steps: [
      {
        name: 'flaky',
        run: () => {
          attempts += 1;
          if (attempts < 3) throw new Error('transient');
          return { attempts };
        },
      },
    ],
  });
  assert.equal(run.state, 'completed');
  assert.equal(run.steps[0]?.attempts, 3);
  assert.deepEqual(run.steps[0]?.output, { attempts: 3 });
});

test('failure rolls back completed steps in reverse order', async () => {
  const engine = new WorkflowEngine(new MemoryDatabase(), { wait: instantWait, maxStepAttempts: 1 });
  const rolledBack: string[] = [];
  const run = await engine.start({
    name: 'rollback-flow',
    steps: [
      { name: 'one', run: () => 'a', rollback: () => void rolledBack.push('one') },
      { name: 'two', run: () => 'b', rollback: () => void rolledBack.push('two') },
      {
        name: 'boom',
        run: () => {
          throw new Error('fatal');
        },
      },
    ],
  });
  assert.equal(run.state, 'failed');
  assert.deepEqual(rolledBack, ['two', 'one']);
  assert.equal(run.steps[0]?.state, 'rolled-back');
});

test('conditions skip steps', async () => {
  const engine = new WorkflowEngine(new MemoryDatabase(), { wait: instantWait });
  const run = await engine.start({
    name: 'conditional-flow',
    steps: [
      { name: 'always', run: () => 1 },
      { name: 'never', condition: () => false, run: () => 2 },
    ],
  });
  assert.equal(run.state, 'completed');
  assert.equal(run.steps[1]?.state, 'skipped');
});

test('approval gates pause the run and rejection fails it', async () => {
  const approvals = new ApprovalManager();
  const engine = new WorkflowEngine(new MemoryDatabase(), { wait: instantWait, approvals });
  const pending = engine.start({
    name: 'gated-flow',
    steps: [{ name: 'deploy', requiresApproval: true, run: () => 'deployed' }],
  });
  // Wait until the approval shows up, then reject it.
  await new Promise((resolve) => setImmediate(resolve));
  const [approval] = approvals.pending();
  assert.ok(approval);
  approvals.resolve(approval.id, false, 'human');
  const run = await pending;
  assert.equal(run.state, 'failed');
  assert.match(run.steps[0]?.error ?? '', /approval rejected/);
});

test('auto-approve lets gated runs finish', async () => {
  const approvals = new ApprovalManager({ autoApprove: true });
  const engine = new WorkflowEngine(new MemoryDatabase(), { wait: instantWait, approvals });
  const run = await engine.start({
    name: 'auto-flow',
    steps: [{ name: 'deploy', requiresApproval: true, run: () => 'deployed' }],
  });
  assert.equal(run.state, 'completed');
});

test('a paused run resumes from its checkpoint — even on a new engine', async () => {
  const database = new MemoryDatabase();
  const executed: string[] = [];
  let runId = '';

  // The first step pauses its own run: the engine checkpoints and stops
  // before the second step.
  const engine = new WorkflowEngine(database, { wait: instantWait });
  const paused = await engine.start({
    name: 'resumable-flow',
    steps: [
      {
        name: 'first',
        run: (ctx) => {
          executed.push('first');
          runId = ctx.runId;
          engine.pause(ctx.runId);
          return 1;
        },
      },
      { name: 'second', run: () => void executed.push('second') },
    ],
  });
  assert.equal(paused.state, 'paused');
  assert.deepEqual(executed, ['first']);

  // A brand-new engine (fresh-process simulation) resumes from the
  // persisted checkpoint; the completed first step is NOT re-run.
  const fresh = new WorkflowEngine(database, { wait: instantWait });
  const definition: WorkflowDefinition = {
    name: 'resumable-flow',
    steps: [
      { name: 'first', run: () => void executed.push('first-again') },
      { name: 'second', run: () => void executed.push('second') },
    ],
  };
  fresh.define(definition);
  const finished = await fresh.resume(runId);
  assert.equal(finished.state, 'completed');
  assert.deepEqual(executed, ['first', 'second']);
});
