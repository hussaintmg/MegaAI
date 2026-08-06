import test from 'node:test';
import assert from 'node:assert/strict';
import { Mesh, MemoryMeshStore, type MeshTask } from '@megaai/mesh';
import type { JsonObject } from '@megaai/types';
import { createPlanHandler } from './plan-task.js';
import { coderLockKey, lockKeysCollide } from './coder-task.js';
import type { TaskContext, TaskOutcome } from './agent.js';

const PLAN = {
  projectName: 'showroom',
  summary: 'A 3D car showroom with bookings.',
  stack: ['Next.js 16', 'MongoDB'],
  decisions: ['react-three-fiber'],
  additions: ['sign-in, because bookings need an owner'],
  risks: ['a 40 MB model kills a phone'],
  pieces: [
    {
      id: 'db',
      title: 'Collections',
      surface: 'database',
      intent: 'Cars and bookings.',
      files: ['lib/db.ts'],
      acceptance: ['unique index on slug'],
      dependsOn: [],
    },
    {
      id: 'api',
      title: 'Cars API',
      surface: 'backend',
      intent: 'List and read cars.',
      files: ['app/api/cars/route.ts'],
      acceptance: ['GET returns 200'],
      dependsOn: ['db'],
    },
    {
      id: 'ui',
      title: 'Showroom page',
      surface: 'frontend',
      intent: 'The rotating car.',
      files: ['app/page.tsx'],
      acceptance: ['it rotates'],
      dependsOn: ['db'],
    },
  ],
};

/** A plan task and the context the agent would give it, with a live checkpoint. */
function harness(payload: JsonObject) {
  const task = {
    id: 'plan-1',
    title: 'build it',
    payload,
    state: 'running',
    checkpoint: undefined as JsonObject | undefined,
  } as unknown as MeshTask;
  const logs: string[] = [];
  const context: TaskContext = {
    task,
    signal: new AbortController().signal,
    checkpoint: async (patch) => {
      // The queue merges; a memory harness has to as well, or round two starts
      // from nothing and the whole plan is thrown away every time.
      task.checkpoint = { ...(task.checkpoint ?? {}), ...patch };
    },
    log: (line) => void logs.push(line),
  };
  return { task, context, logs };
}

function planPayload(extra: JsonObject = {}): JsonObject {
  return { kind: 'plan', goal: 'build a 3D car showroom', projectDir: 'C:/projects/showroom', ...extra };
}

async function meshWith(): Promise<Mesh> {
  return new Mesh({ store: new MemoryMeshStore() });
}

test('one goal becomes a plan, and only the unblocked pieces are handed out', async () => {
  const mesh = await meshWith();
  const asked: string[] = [];
  const handler = createPlanHandler({
    mesh,
    think: async (prompt) => {
      asked.push(prompt);
      return `Here you go:\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``;
    },
    listFiles: () => ['package.json'],
    coders: () => ['claude', 'codex', 'opencode'],
  });

  const { context, logs } = harness(planPayload());
  const outcome = await handler(context);

  assert.match(asked[0] ?? '', /build a 3D car showroom/);
  assert.match(asked[0] ?? '', /claude, codex, opencode/, 'the planner is told who will build it');

  const queued = await mesh.store.listTasks({ states: ['pending'] });
  assert.equal(queued.length, 1, 'the API and the page both wait on the schema');
  assert.equal(queued[0]?.payload['kind'], 'coder', 'a real coding agent does the work, not this one');
  assert.match(String(queued[0]?.title), /showroom · database · Collections/);
  assert.equal(outcome.kind, 'parked', 'it stays alive to hand out the rest');
  assert.ok(logs.some((line) => /planned 3 pieces/.test(line)));
});

test('the brief handed to the agent is the real one, not a restatement of the goal', async () => {
  const mesh = await meshWith();
  const handler = createPlanHandler({ mesh, think: async () => JSON.stringify(PLAN) });
  await handler(harness(planPayload({ verifyCommand: 'npm run build' })).context);

  const [queued] = await mesh.store.listTasks({ states: ['pending'] });
  const brief = String(queued?.payload['task']);
  assert.match(brief, /# Collections/);
  assert.match(brief, /A 3D car showroom with bookings/);
  assert.match(brief, /`lib\/db\.ts`/);
  assert.match(brief, /1\. unique index on slug/);
  assert.match(brief, /npm run build/);
  assert.deepEqual(queued?.payload['scope'], ['lib/db.ts'], 'and the files it owns travel with it');
});

test('when the first piece finishes, what it produced is passed to the next', async () => {
  const mesh = await meshWith();
  const handler = createPlanHandler({ mesh, think: async () => JSON.stringify(PLAN), now: () => 1_000 });
  const { context } = harness(planPayload());

  await handler(context);
  const [schema] = await mesh.store.listTasks({ states: ['pending'] });
  assert.ok(schema);
  // The agent that ran it says what it did; that sentence is what the next
  // agent needs and is exactly what a re-stated goal cannot give it.
  await mesh.store.putTask({
    ...schema,
    state: 'completed',
    result: { output: 'created lib/db.ts with cars and bookings, slug is unique' },
  });

  await handler(context);
  const queued = await mesh.store.listTasks({ states: ['pending'] });
  assert.equal(queued.length, 2, 'the API and the page are now both free to start');
  const brief = String(queued[0]?.payload['task']);
  assert.match(brief, /Already finished by the others/);
  assert.match(brief, /slug is unique/);
});

test('two pieces started together are each told to keep out of the other\'s files', async () => {
  const mesh = await meshWith();
  const handler = createPlanHandler({ mesh, think: async () => JSON.stringify(PLAN) });
  const { context } = harness(planPayload());
  await handler(context);
  const [schema] = await mesh.store.listTasks({ states: ['pending'] });
  await mesh.store.putTask({ ...schema!, state: 'completed', result: { output: 'done' } });
  await handler(context);

  const queued = await mesh.store.listTasks({ states: ['pending'] });
  const api = queued.find((entry) => String(entry.title).includes('Cars API'));
  assert.match(String(api?.payload['task']), /Do not touch — another agent is in these right now/);
  assert.match(String(api?.payload['task']), /app\/page\.tsx/);
});

test('no more than the parallel limit is in flight at once', async () => {
  const wide = {
    ...PLAN,
    pieces: ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      id,
      title: id,
      surface: 'backend',
      intent: 'x',
      files: [`${id}.ts`],
      acceptance: ['x'],
      dependsOn: [],
    })),
  };
  const mesh = await meshWith();
  const handler = createPlanHandler({ mesh, think: async () => JSON.stringify(wide) });
  await handler(harness(planPayload({ maxParallel: 2 })).context);
  assert.equal((await mesh.store.listTasks({ states: ['pending'] })).length, 2);
});

test('the plan is remembered, so a restart does not think it all over again', async () => {
  const mesh = await meshWith();
  let thoughts = 0;
  const handler = createPlanHandler({
    mesh,
    think: async () => {
      thoughts += 1;
      return JSON.stringify(PLAN);
    },
  });
  const { context } = harness(planPayload());
  await handler(context);
  await handler(context);
  await handler(context);
  assert.equal(thoughts, 1, 'thinking is the expensive part and it only happens once');
});

test('everything finished finishes the goal, with what was decided along the way', async () => {
  const mesh = await meshWith();
  const handler = createPlanHandler({ mesh, think: async () => JSON.stringify(PLAN) });
  const { context } = harness(planPayload());

  let outcome: TaskOutcome = { kind: 'parked', until: 0, reason: '' };
  for (let round = 0; round < 6; round += 1) {
    outcome = await handler(context);
    if (outcome.kind !== 'parked') break;
    for (const queued of await mesh.store.listTasks({ states: ['pending'] })) {
      await mesh.store.putTask({ ...queued, state: 'completed', result: { output: `finished ${queued.title}` } });
    }
  }

  assert.equal(outcome.kind, 'done');
  const result = outcome.kind === 'done' ? (outcome.result ?? {}) : {};
  assert.equal(result['completed'], 3);
  assert.equal(result['failed'], 0);
  assert.deepEqual(result['additions'], ['sign-in, because bookings need an owner']);
  assert.deepEqual(result['risks'], ['a 40 MB model kills a phone']);
});

test('a piece that failed blocks what depended on it and the goal still settles', async () => {
  const mesh = await meshWith();
  const handler = createPlanHandler({ mesh, think: async () => JSON.stringify(PLAN) });
  const { context } = harness(planPayload());

  await handler(context);
  const [schema] = await mesh.store.listTasks({ states: ['pending'] });
  await mesh.store.putTask({ ...schema!, state: 'failed', error: 'no coding agent could finish it' });

  const outcome = await handler(context);
  assert.equal(outcome.kind, 'failed', 'rather than parking on a dependency that will never arrive');
  assert.match(outcome.kind === 'failed' ? outcome.error : '', /nothing in "showroom" was built/);
  assert.match(outcome.kind === 'failed' ? outcome.error : '', /2 more could never start/);
});

test('a plan that mostly worked reports what did not, instead of failing whole', async () => {
  const mesh = await meshWith();
  const handler = createPlanHandler({ mesh, think: async () => JSON.stringify(PLAN) });
  const { context } = harness(planPayload());

  await handler(context);
  const [schema] = await mesh.store.listTasks({ states: ['pending'] });
  await mesh.store.putTask({ ...schema!, state: 'completed', result: { output: 'schema done' } });
  await handler(context);
  const queued = await mesh.store.listTasks({ states: ['pending'] });
  await mesh.store.putTask({ ...queued[0]!, state: 'completed', result: { output: 'api done' } });
  await mesh.store.putTask({ ...queued[1]!, state: 'failed', error: 'ran out of everything' });

  const outcome = await handler(context);
  assert.equal(outcome.kind, 'done');
  const result = outcome.kind === 'done' ? (outcome.result ?? {}) : {};
  assert.equal(result['completed'], 2);
  assert.equal(result['failed'], 1);
  assert.deepEqual(result['failedPieces'], ['Showroom page']);
});

test('a planner that answers with prose fails loudly and quotes what it said', async () => {
  const mesh = await meshWith();
  const handler = createPlanHandler({ mesh, think: async () => 'I would start with market research.' });
  const outcome = await handler(harness(planPayload()).context);
  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.kind === 'failed' ? outcome.error : '', /did not return JSON/);
  assert.match(outcome.kind === 'failed' ? outcome.error : '', /market research/);
});

test('no model to think with is waited out, not failed — the coding agents are fine', async () => {
  const mesh = await meshWith();
  const handler = createPlanHandler({
    mesh,
    think: async () => {
      throw new Error('no API key configured');
    },
    now: () => 5_000,
  });
  const outcome = await handler(harness(planPayload()).context);
  assert.equal(outcome.kind, 'parked');
  assert.match(outcome.kind === 'parked' ? outcome.reason : '', /no API key configured/);
});

test('the goal id travels down to every piece, so the website can follow it', async () => {
  const mesh = await meshWith();
  const handler = createPlanHandler({ mesh, think: async () => JSON.stringify(PLAN) });
  await handler(harness(planPayload({ goalId: 'goal-abc' })).context);
  const [queued] = await mesh.store.listTasks({ states: ['pending'] });
  assert.equal(queued?.payload['goalId'], 'goal-abc');
  assert.equal(queued?.payload['planTaskId'], 'plan-1');
  assert.equal(queued?.payload['pieceId'], 'db');
});

/* ---------------- the locks that keep them apart ---------------- */

test('a task with a scope locks its files; one without locks the folder', () => {
  const scoped = coderLockKey({ kind: 'coder', goal: 'g', task: 't', projectDir: 'C:/p', scope: ['app/api', 'lib/db.ts'] });
  assert.deepEqual(scoped, ['C:/p::app/api', 'C:/p::lib/db.ts']);
  assert.deepEqual(coderLockKey({ kind: 'coder', goal: 'g', task: 't', projectDir: 'C:/p' }), ['C:/p']);
});

test('a folder and a file inside it are the same lock; two siblings are not', () => {
  assert.equal(lockKeysCollide('C:/p::app/api', 'C:/p::app/api/cars/route.ts'), true);
  assert.equal(lockKeysCollide('C:/p::app/api/cars/route.ts', 'C:/p::app/api/orders/route.ts'), false);
  // A task holding the whole folder blocks everything in it.
  assert.equal(lockKeysCollide('C:/p', 'C:/p::app/page.tsx'), true);
  // A different project is a different place entirely.
  assert.equal(lockKeysCollide('C:/other::app/page.tsx', 'C:/p::app/page.tsx'), false);
  assert.equal(lockKeysCollide('C:/p::app/api', 'C:/p::app/apix/route.ts'), false);
});

test('a goal from a phone gets a folder from the machine that picks it up', async () => {
  const mesh = await meshWith();
  const made: string[] = [];
  const handler = createPlanHandler({
    mesh,
    think: async () => JSON.stringify(PLAN),
    resolveProjectDir: (goal) => `C:/work/${goal.split(' ').slice(-2).join('-')}`,
    ensureDir: (dir) => void made.push(dir),
  });
  const { context, task } = harness({ kind: 'plan', goal: 'build a car showroom' });

  await handler(context);
  assert.deepEqual(made, ['C:/work/car-showroom']);
  const [queued] = await mesh.store.listTasks({ states: ['pending'] });
  assert.equal(queued?.payload['projectDir'], 'C:/work/car-showroom');

  // And it is remembered, so a restart does not start the project somewhere else.
  const remembered = (task.checkpoint?.['plan'] as Record<string, unknown>)['projectDir'];
  assert.equal(remembered, 'C:/work/car-showroom');
});

test('a goal with nowhere to go says so instead of building in the current directory', async () => {
  const mesh = await meshWith();
  const handler = createPlanHandler({ mesh, think: async () => JSON.stringify(PLAN) });
  const outcome = await handler(harness({ kind: 'plan', goal: 'build something' }).context);
  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.kind === 'failed' ? outcome.error : '', /did not say which folder/);
});
