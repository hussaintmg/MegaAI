import test from 'node:test';
import assert from 'node:assert/strict';
import { Mesh } from '@megaai/mesh';
import { ManualClock } from '@megaai/utils';
import { NodeAgent, type NodeAgentOptions, type TaskHandler } from './agent.js';
import { ResourceGuard } from './guard.js';
import type { MachineSample } from './machine.js';
import { StateFile } from './state.js';
import { coderLockKey, lockKeysCollide } from './coder-task.js';

const AWAY: MachineSample = { at: 0, cpuLoad: 0.1, memUsedPct: 0.4, idleSeconds: 900 };

function harness(handlers: Record<string, TaskHandler>, overrides: Partial<NodeAgentOptions> = {}) {
  const clock = new ManualClock(0);
  const mesh = new Mesh({ clock });
  const guard = new ResourceGuard({ clock, thresholds: { minHoldMs: 0 } });
  const logs: string[] = [];
  let machine: MachineSample = { ...AWAY };

  const agent = new NodeAgent({
    mesh,
    name: 'Laptop',
    capabilities: ['shell', 'browser'],
    guard,
    sample: () => ({ ...machine, at: clock.now() }),
    handlers,
    clock,
    log: (line) => logs.push(line),
    tickMs: 0,
    renewMs: 0,
    ...overrides,
  });

  return {
    clock,
    mesh,
    agent,
    logs,
    machine: (patch: Partial<MachineSample>) => {
      machine = { ...machine, ...patch };
    },
  };
}

/** A handler that stops where you tell it to and can be let go later. */
function suspendable() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  const handler: TaskHandler = async (context) => {
    started.push(context.task.id);
    await context.checkpoint({ step: 'installed dependencies' });
    await Promise.race([
      held,
      new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve())),
    ]);
    if (context.signal.aborted) throw new Error('interrupted');
    return { kind: 'done', result: { fine: true } };
  };
  return { handler, release, started };
}

test('it keeps working while you are here, and only screen work waits', async () => {
  const h = harness({ build: async () => ({ kind: 'done' }) });
  h.machine({ idleSeconds: 4 });

  const coding = await h.mesh.enqueue({ title: 'nightly rebuild', requires: ['shell'], payload: { kind: 'build' } });
  const onScreen = await h.mesh.enqueue({
    title: 'open the app and look at it',
    requires: ['shell'],
    interactive: true,
    payload: { kind: 'build' },
  });

  await h.agent.start();
  await h.agent.drain();

  assert.equal((await h.mesh.store.getTask(coding.id))?.state, 'completed', 'a background build does not disturb you');
  assert.equal((await h.mesh.store.getTask(onScreen.id))?.state, 'pending');
  assert.match((await h.mesh.explainWait(onScreen.id)) ?? '', /needs the mouse and screen/);

  // You walk away, and the rest goes too.
  h.machine({ idleSeconds: 900 });
  await h.agent.tick();
  await h.agent.drain();
  assert.equal((await h.mesh.store.getTask(onScreen.id))?.state, 'completed');
});

test('a task cut short by heat goes back with its progress, and is not counted as a failure', async () => {
  const suspended = suspendable();
  const h = harness({ build: suspended.handler });
  const task = await h.mesh.enqueue({ title: 'long build', requires: ['shell'], payload: { kind: 'build' }, maxAttempts: 2 });

  await h.agent.start();
  assert.deepEqual(h.agent.runningIds, [task.id]);

  h.machine({ temperatureC: 95 });
  await h.agent.tick();
  await h.agent.drain();

  const after = await h.mesh.store.getTask(task.id);
  assert.equal(after?.state, 'pending', 'the machine getting hot is not the task going wrong');
  assert.equal(after?.attempts, 0, 'and it must not use up one of the task’s tries');
  assert.deepEqual(after?.checkpoint, { step: 'installed dependencies' }, 'the work already done survives');
  assert.match(after?.waitingFor ?? '', /95°C/);
  suspended.release();
});

test('after a restart the same machine picks its own work back up', async () => {
  const seen: Array<Record<string, unknown> | undefined> = [];
  const h = harness(
    {
      build: async (context) => {
        seen.push(context.task.checkpoint);
        return { kind: 'done' };
      },
    },
    { nodeId: 'laptop-1' },
  );

  // The previous run of this process had the task and then died.
  await h.mesh.register({ id: 'laptop-1', name: 'Laptop', kind: 'laptop', capabilities: ['shell', 'browser'] });
  const task = await h.mesh.enqueue({ title: 'half-finished build', requires: ['shell'], payload: { kind: 'build' } });
  await h.mesh.claimNext('laptop-1');
  await h.mesh.progress(task.id, 'laptop-1', { step: 'wrote the hero section' });

  // Waiting out the lease would leave the machine idle next to work it is
  // allowed to do, so the returning node hands its own claims back at once.
  await h.agent.start();
  await h.agent.drain();

  assert.equal((await h.mesh.store.getTask(task.id))?.state, 'completed');
  assert.deepEqual(seen[0], { step: 'wrote the hero section' }, 'it continues rather than starting again');
  assert.ok(h.logs.some((line) => /recovered .* from the previous run/.test(line)));
});

test('the machine is the same machine after a restart, not a new one', async () => {
  // The whole fast-recovery path hangs off this: an agent that comes back with
  // a fresh id cannot recognise — or release — what its previous run was
  // holding, so the work sits claimed by a node that no longer exists until
  // the lease times out.
  const files = new Map<string, string>();
  const options = {
    read: async (file: string) => {
      const found = files.get(file);
      if (found === undefined) throw new Error('ENOENT');
      return found;
    },
    write: async (file: string, contents: string) => void files.set(file, contents),
    move: async (from: string, to: string) => {
      const contents = files.get(from);
      files.delete(from);
      if (contents !== undefined) files.set(to, contents);
    },
    ensureDir: async () => {},
  };

  const first = harness({ build: async () => ({ kind: 'done' }) }, { state: new StateFile('/state/node.json', options) });
  await first.agent.start();
  const id = first.agent.nodeId;
  await first.agent.drain();

  const second = harness({ build: async () => ({ kind: 'done' }) }, { state: new StateFile('/state/node.json', options) });
  await second.agent.start();
  assert.equal(second.agent.nodeId, id);
});

test('several projects run at once, but never two agents in the same folder', async () => {
  const suspended = suspendable();
  const h = harness(
    { coder: suspended.handler },
    { lockKeyFor: (task) => (typeof task.payload['projectDir'] === 'string' ? task.payload['projectDir'] : undefined) },
  );

  const first = await h.mesh.enqueue({
    title: 'hero section',
    requires: ['shell'],
    payload: { kind: 'coder', projectDir: 'C:\\projects\\velocity' },
  });
  const second = await h.mesh.enqueue({
    title: 'spec table',
    requires: ['shell'],
    payload: { kind: 'coder', projectDir: 'C:\\projects\\velocity' },
  });
  const other = await h.mesh.enqueue({
    title: 'shop backend',
    requires: ['shell'],
    payload: { kind: 'coder', projectDir: 'C:\\projects\\shop' },
  });

  await h.agent.start();

  assert.ok(h.agent.runningIds.includes(first.id));
  assert.ok(h.agent.runningIds.includes(other.id), 'a different project is genuine parallel work');

  const held = await h.mesh.store.getTask(second.id);
  assert.equal(held?.state, 'pending');
  assert.equal(held?.attempts, 0);
  // Two coding agents editing the same files undo each other's work.
  assert.match(held?.waitingFor ?? '', /another task is already working in C:\\projects\\velocity/);

  suspended.release();
  await h.agent.drain();
});

test('a task this machine cannot run says so plainly', async () => {
  const h = harness({ build: async () => ({ kind: 'done' }) });
  const task = await h.mesh.enqueue({ title: 'render the level', requires: ['shell'], payload: { kind: 'unreal-render' } });

  await h.agent.start();
  await h.agent.drain();

  const after = await h.mesh.store.getTask(task.id);
  assert.match(after?.error ?? '', /no handler for "unreal-render"/);
});

test('the mesh is told what the machine is doing, not just that it is alive', async () => {
  const h = harness({});
  h.machine({ cpuLoad: 0.62, memUsedPct: 0.71, temperatureC: 58, batteryPct: 91, charging: true });
  await h.agent.start();

  const node = await h.mesh.store.getNode(h.agent.nodeId);
  assert.deepEqual(node?.health, { cpuLoad: 0.62, memUsedPct: 0.71, temperatureC: 58, batteryPct: 91, charging: true });
  assert.equal(node?.gear, 'full');
});

test('shutting down puts the work back instead of dropping it', async () => {
  const suspended = suspendable();
  const h = harness({ build: suspended.handler });
  const task = await h.mesh.enqueue({ title: 'long build', requires: ['shell'], payload: { kind: 'build' } });

  await h.agent.start();
  await h.agent.stop('this machine is shutting down');

  const after = await h.mesh.store.getTask(task.id);
  assert.equal(after?.state, 'pending');
  assert.match(after?.waitingFor ?? '', /shutting down/);
  suspended.release();
});

test('a handler that finishes after being interrupted is not recorded as success', async () => {
  // Otherwise a task cut off halfway looks done, and nobody ever finishes it.
  let go!: () => void;
  const gate = new Promise<void>((resolve) => {
    go = resolve;
  });
  const h = harness({
    build: async () => {
      await gate;
      return { kind: 'done', result: { claimed: 'finished' } };
    },
  });
  const task = await h.mesh.enqueue({ title: 'build', requires: ['shell'], payload: { kind: 'build' } });

  await h.agent.start();
  h.machine({ temperatureC: 99 });
  await h.agent.tick();
  go();
  await h.agent.drain();

  const after = await h.mesh.store.getTask(task.id);
  assert.equal(after?.state, 'pending');
  assert.equal(after?.result, undefined);
});

/* ---------------- working in one project at the same time ---------------- */

test('two agents work in one project at once, as long as their files do not meet', async () => {
  const suspended = suspendable();
  const h = harness(
    { coder: suspended.handler },
    {
      lockKeyFor: (task) => coderLockKey(task.payload),
      lockConflict: lockKeysCollide,
    },
  );

  const api = await h.mesh.enqueue({
    title: 'the API',
    requires: ['shell'],
    payload: { kind: 'coder', goal: 'g', task: 't', projectDir: 'C:/site', scope: ['app/api'] },
  });
  const page = await h.mesh.enqueue({
    title: 'the page',
    requires: ['shell'],
    payload: { kind: 'coder', goal: 'g', task: 't', projectDir: 'C:/site', scope: ['app/page.tsx'] },
  });
  // Inside the API folder — the same place by any honest reading.
  const inside = await h.mesh.enqueue({
    title: 'the cars route',
    requires: ['shell'],
    payload: { kind: 'coder', goal: 'g', task: 't', projectDir: 'C:/site', scope: ['app/api/cars/route.ts'] },
  });

  await h.agent.start();

  assert.ok(h.agent.runningIds.includes(api.id));
  assert.ok(h.agent.runningIds.includes(page.id), 'this is the parallel work the whole plan is built around');
  const held = await h.mesh.store.getTask(inside.id);
  assert.equal(held?.state, 'pending', 'and this one is inside a folder someone is already in');
  assert.equal(held?.attempts, 0, 'waiting never costs a retry');

  suspended.release();
  await h.agent.drain();
});

test('a task that declares no files still owns the whole folder', async () => {
  const suspended = suspendable();
  const h = harness(
    { coder: suspended.handler },
    { lockKeyFor: (task) => coderLockKey(task.payload), lockConflict: lockKeysCollide },
  );

  await h.mesh.enqueue({
    title: 'do something to the site',
    requires: ['shell'],
    payload: { kind: 'coder', goal: 'g', task: 't', projectDir: 'C:/site' },
  });
  const scoped = await h.mesh.enqueue({
    title: 'the page',
    requires: ['shell'],
    payload: { kind: 'coder', goal: 'g', task: 't', projectDir: 'C:/site', scope: ['app/page.tsx'] },
  });

  await h.agent.start();
  assert.equal((await h.mesh.store.getTask(scoped.id))?.state, 'pending', 'guessing "probably not that file" is how work is lost');

  suspended.release();
  await h.agent.drain();
});

/* ---------------- how much this machine can really take ---------------- */

test('the coding agents cap the machine, not just its temperature', async () => {
  let free = 1;
  const suspended = suspendable();
  const h = harness({ coder: suspended.handler }, { capacity: () => free });

  await h.mesh.enqueue({ title: 'one', requires: ['shell'], payload: { kind: 'coder' } });
  await h.mesh.enqueue({ title: 'two', requires: ['shell'], payload: { kind: 'coder' } });

  await h.agent.start();
  assert.equal(h.agent.runningIds.length, 1, 'one agent free means one task, whatever the CPU says');

  const node = await h.mesh.store.getNode(h.agent.nodeId);
  assert.equal(node?.concurrency, 1, 'and the queue is told the truth, so it stops offering more');

  free = 2;
  await h.agent.tick();
  assert.equal(h.agent.runningIds.length, 2, 'and a limit resetting is picked up on the next round');

  suspended.release();
  await h.agent.drain();
});

test('the supervisor never queues behind the work it is supposed to hand out', async () => {
  const suspended = suspendable();
  let planned = 0;
  const h = harness(
    {
      coder: suspended.handler,
      plan: async () => {
        planned += 1;
        return { kind: 'done' };
      },
    },
    { capacity: () => 1, lightweight: (task) => task.payload['kind'] === 'plan' },
  );

  await h.mesh.enqueue({ title: 'a six hour build', requires: ['shell'], payload: { kind: 'coder' } });
  await h.mesh.enqueue({ title: 'work out what is next', requires: ['shell'], payload: { kind: 'plan' } });

  await h.agent.start();
  // Without this, nothing new is ever handed out while the machine is busy —
  // which is exactly when handing work out matters.
  assert.equal(planned, 1);

  suspended.release();
  await h.agent.drain();
});
