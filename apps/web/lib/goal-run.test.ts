import test from 'node:test';
import assert from 'node:assert/strict';
import { goalRun, machinesReady, planOf, statusFromRun } from './goal-run.ts';
import { buildGoalTask, type MeshNodeDoc, type MeshTaskDoc } from './mesh-model.ts';

const NOW = 1_000_000;

function task(patch: Partial<MeshTaskDoc> & { _id: string }): MeshTaskDoc {
  return {
    title: 'a task',
    payload: {},
    state: 'pending',
    requires: ['shell'],
    interactive: false,
    urgent: false,
    priority: 0,
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    rev: 1,
    attempts: 0,
    maxAttempts: 3,
    ...patch,
  };
}

function node(patch: Partial<MeshNodeDoc> = {}): MeshNodeDoc {
  return {
    _id: 'laptop',
    name: 'Laptop',
    kind: 'laptop',
    capabilities: ['shell', 'browser'],
    priority: 100,
    gear: 'full',
    concurrency: 2,
    lastSeen: NOW,
    ...patch,
  };
}

const BLUEPRINT = {
  projectName: 'showroom',
  summary: 'A 3D car showroom.',
  stack: ['Next.js 16'],
  decisions: ['react-three-fiber'],
  additions: ['sign-in'],
  risks: ['a huge model kills a phone'],
  pieces: [
    { id: 'db', title: 'Collections', surface: 'database', intent: 'i', files: ['lib/db.ts'], dependsOn: [] },
    { id: 'api', title: 'Cars API', surface: 'backend', intent: 'i', files: ['app/api/cars/route.ts'], dependsOn: ['db'] },
  ],
};

function planTask(patch: Partial<MeshTaskDoc> = {}): MeshTaskDoc {
  return task({
    _id: 'plan-1',
    title: 'Plan and build: a showroom',
    payload: { kind: 'plan', goal: 'a showroom', goalId: 'g1' },
    checkpoint: { plan: { projectDir: 'C:/work/showroom', blueprint: BLUEPRINT, repairs: [], children: {}, statuses: {} } },
    state: 'running',
    ...patch,
  });
}

/* ---------------- queueing one ---------------- */

test('a goal is queued as a plan, not as code — the planner decides, the agents write', () => {
  const built = buildGoalTask({ goal: 'build a 3D car showroom' }, 'g1');
  assert.ok(built.ok);
  assert.equal(built.task?.payload['kind'], 'plan');
  assert.equal(built.task?.payload['goalId'], 'g1');
  assert.equal(built.task?.interactive, false, 'planning must not wait for you to walk away');
  assert.deepEqual(built.task?.requires, ['shell']);
});

test('a goal need not name a folder — a phone does not know the laptop\'s paths', () => {
  const built = buildGoalTask({ goal: 'build a shop' }, 'g1');
  assert.ok(built.ok);
  assert.equal(built.task?.payload['projectDir'], undefined);
});

test('a folder that is not a full path is refused, with what a full one looks like', () => {
  const built = buildGoalTask({ goal: 'build a shop', projectDir: 'projectsshop' }, 'g1');
  assert.equal(built.ok, false);
  assert.match(built.error ?? '', /C:\/projects\/showroom/);
});

test('a goal too short to mean anything is refused before it reaches a machine', () => {
  assert.equal(buildGoalTask({ goal: 'hi' }, 'g1').ok, false);
});

/* ---------------- reading one back ---------------- */

test('the plan comes back out of the supervisor\'s checkpoint', () => {
  const { plan, projectDir } = planOf(planTask());
  assert.equal(projectDir, 'C:/work/showroom');
  assert.equal(plan?.projectName, 'showroom');
  assert.deepEqual(plan?.additions, ['sign-in'], 'what it decided to add is part of the answer');
  assert.equal(plan?.pieces.length, 2);
});

test('before the plan exists, the goal says it is being thought about', () => {
  const run = goalRun(task({ _id: 'plan-1', payload: { kind: 'plan' }, state: 'running' }), [], [node()], NOW);
  assert.equal(run.state, 'planning');
  assert.match(run.headline, /backend, frontend, database, security/);
});

test('with no machine listening, the goal says so rather than looking busy', () => {
  const run = goalRun(task({ _id: 'plan-1', payload: { kind: 'plan' }, state: 'pending' }), [], [], NOW);
  assert.equal(run.state, 'waiting');
  assert.match(run.headline, /no machine has joined the queue yet/);
});

test('a goal being built shows who is writing what, in the order the plan set', () => {
  const children = [
    task({
      _id: 'c2',
      title: 'showroom · backend · Cars API',
      payload: { kind: 'coder', goalId: 'g1', pieceId: 'api', surface: 'backend', scope: ['app/api/cars/route.ts'] },
      state: 'running',
    }),
    task({
      _id: 'c1',
      title: 'showroom · database · Collections',
      payload: { kind: 'coder', goalId: 'g1', pieceId: 'db', surface: 'database', scope: ['lib/db.ts'] },
      state: 'completed',
      result: { coders: ['claude', 'codex'], finishedBy: 'codex', output: 'wrote lib/db.ts' },
    }),
  ];
  const run = goalRun(planTask(), children, [node()], NOW);

  assert.equal(run.state, 'building');
  assert.deepEqual(run.pieces.map((piece) => piece.id), ['db', 'api'], 'plan order, not finish order');
  assert.equal(run.pieces[0]?.finishedBy, 'codex', 'a real coding agent wrote it, and it is named');
  assert.deepEqual(run.pieces[0]?.coders, ['claude', 'codex'], 'including the one that ran out mid-way');
  assert.equal(run.done, 1);
  assert.equal(run.total, 2);
  assert.match(run.headline, /1\/2 done · 1 being written right now/);
});

test('a piece that has not started says why, which "queued" never does', () => {
  const children = [
    task({
      _id: 'c1',
      title: 'showroom · database · Collections',
      payload: { kind: 'coder', goalId: 'g1', pieceId: 'db', surface: 'database' },
      state: 'pending',
      notBefore: NOW + 20 * 60_000,
      waitingFor: 'every coding agent is out of quota',
    }),
  ];
  const run = goalRun(planTask(), children, [node()], NOW);
  assert.equal(run.state, 'waiting');
  assert.match(run.pieces[0]?.waitingFor ?? '', /out of quota \(in 20 min\)/);
  assert.match(run.headline, /out of quota/);
});

test('a finished goal says so; one with holes in it does not claim to be finished', () => {
  const good = goalRun(
    planTask({ state: 'completed' }),
    [
      task({ _id: 'c1', payload: { kind: 'coder', pieceId: 'db' }, state: 'completed' }),
      task({ _id: 'c2', payload: { kind: 'coder', pieceId: 'api' }, state: 'completed' }),
    ],
    [node()],
    NOW,
  );
  assert.equal(good.state, 'completed');
  assert.equal(statusFromRun(good), 'completed');

  const holed = goalRun(
    planTask({ state: 'completed' }),
    [
      task({ _id: 'c1', payload: { kind: 'coder', pieceId: 'db' }, state: 'completed' }),
      task({ _id: 'c2', payload: { kind: 'coder', pieceId: 'api' }, state: 'failed', error: 'nobody could finish it' }),
    ],
    [node()],
    NOW,
  );
  assert.equal(holed.state, 'building');
  assert.match(holed.headline, /1 of 2 pieces finished; 1 did not/);
});

test('a plan that failed shows its reason instead of an empty page', () => {
  const run = goalRun(planTask({ state: 'failed', error: 'no planning model is configured' }), [], [node()], NOW);
  assert.equal(run.state, 'failed');
  assert.equal(run.headline, 'no planning model is configured');
  assert.equal(statusFromRun(run), 'failed');
});

test('a goal with no task at all is not left looking like it is running', () => {
  // The row exists but nothing was ever queued — a failed insert, or a goal
  // from before this all worked. Silence here reads as "still going" for ever.
  const run = goalRun(undefined, [], [node()], NOW);
  assert.equal(run.state, 'failed');
  assert.match(run.headline, /never handed to the machines/);
});

/* ---------------- before it is even queued ---------------- */

test('an empty fleet is named before the goal is submitted, not discovered later', () => {
  const empty = machinesReady([], NOW);
  assert.equal(empty.ok, false);
  assert.match(empty.note ?? '', /megaai-node run/);

  const offline = machinesReady([node({ lastSeen: NOW - 10 * 60_000 })], NOW);
  assert.equal(offline.ok, false);
  assert.match(offline.note ?? '', /Laptop is offline/);

  assert.equal(machinesReady([node()], NOW).ok, true);
});
