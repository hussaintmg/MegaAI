import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '@megaai/utils';
import { MemoryDatabase } from '@megaai/database';
import { Scheduler } from '@megaai/runtime';
import { JobsEngine, createJobsTools } from './index.js';

function make() {
  const clock = new ManualClock(1_000);
  const engine = new JobsEngine({ database: new MemoryDatabase(), scheduler: new Scheduler(), clock, minIntervalMs: 10 });
  return { engine, clock };
}

test('schedule rejects unknown kinds and floors the interval', async () => {
  const { engine } = make();
  await assert.rejects(engine.schedule({ name: 'x', kind: 'nope', intervalMs: 1000 }), /Unknown job kind/);
  let ran = 0;
  engine.registerHandler('tick', () => {
    ran += 1;
  });
  const job = await engine.schedule({ name: 'ticker', kind: 'tick', intervalMs: 1 }); // below the floor
  assert.equal(job.intervalMs, 10);
  assert.equal(job.runs, 0);
  assert.equal(ran, 0);
});

test('fire runs the handler, records bookkeeping and survives handler errors', async () => {
  const { engine, clock } = make();
  const seen: string[] = [];
  engine.registerHandler('report', (ctx) => {
    seen.push(ctx.job.name);
  });
  engine.registerHandler('boom', () => {
    throw new Error('kaboom');
  });

  const ok = await engine.schedule({ name: 'nightly', kind: 'report', intervalMs: 100, params: { channel: 'ops' } });
  clock.advance(50);
  await engine.fire(ok.id);
  const afterOk = await engine.get(ok.id);
  assert.equal(afterOk!.runs, 1);
  assert.equal(afterOk!.lastStatus, 'ok');
  assert.equal(afterOk!.lastRunAt, 1_050);
  assert.deepEqual(seen, ['nightly']);

  const bad = await engine.schedule({ name: 'flaky', kind: 'boom', intervalMs: 100 });
  await engine.fire(bad.id);
  const afterBad = await engine.get(bad.id);
  assert.equal(afterBad!.runs, 1);
  assert.equal(afterBad!.lastStatus, 'error');
  assert.match(afterBad!.lastError ?? '', /kaboom/);
});

test('disabled jobs do not fire; cancel removes them', async () => {
  const { engine } = make();
  let ran = 0;
  engine.registerHandler('tick', () => {
    ran += 1;
  });
  const job = await engine.schedule({ name: 't', kind: 'tick', intervalMs: 100, enabled: false });
  await engine.fire(job.id);
  assert.equal(ran, 0); // disabled → no-op

  await engine.setEnabled(job.id, true);
  await engine.fire(job.id);
  assert.equal(ran, 1);

  assert.equal(await engine.cancel(job.id), true);
  assert.equal((await engine.list()).length, 0);
  assert.equal(await engine.cancel(job.id), false);
});

test('start arms enabled jobs on the scheduler and stop disarms them', async () => {
  const clock = new ManualClock(1_000);
  const scheduler = new Scheduler();
  const engine = new JobsEngine({ database: new MemoryDatabase(), scheduler, clock, minIntervalMs: 10 });
  let ran = 0;
  engine.registerHandler('tick', () => {
    ran += 1;
  });
  await engine.schedule({ name: 'armed', kind: 'tick', intervalMs: 50 });
  await engine.start();
  assert.equal(scheduler.list().length, 1);
  // Trigger the underlying scheduled job body directly (no real timer wait).
  // The scheduler exposes list(); firing goes through the engine.
  const [job] = await engine.list();
  await engine.fire(job!.id);
  assert.equal(ran, 1);
  engine.stop();
  assert.equal(scheduler.list().length, 0);
});

test('jobs tools schedule, list, run and cancel', async () => {
  const { engine } = make();
  let ran = 0;
  engine.registerHandler('tick', () => {
    ran += 1;
  });
  const tools = Object.fromEntries(createJobsTools(engine).map((t) => [t.name, t]));
  for (const name of Object.keys(tools)) assert.deepEqual(tools[name]!.permissions, ['jobs']);

  const scheduled = (await tools['jobs.schedule']!.execute({ name: 'j', kind: 'tick', intervalMs: 100 }, { workspaceRoot: '/tmp' })) as { id: string };
  const listed = (await tools['jobs.list']!.execute({}, { workspaceRoot: '/tmp' })) as { jobs: unknown[]; kinds: string[] };
  assert.equal(listed.jobs.length, 1);
  assert.ok(listed.kinds.includes('tick'));

  await tools['jobs.run']!.execute({ id: scheduled.id }, { workspaceRoot: '/tmp' });
  assert.equal(ran, 1);
  const cancel = (await tools['jobs.cancel']!.execute({ id: scheduled.id }, { workspaceRoot: '/tmp' })) as { cancelled: boolean };
  assert.equal(cancel.cancelled, true);
});
