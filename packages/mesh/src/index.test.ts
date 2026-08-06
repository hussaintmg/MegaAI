import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '@megaai/utils';
import { Mesh } from './index.js';

function mesh(clock = new ManualClock(0)) {
  const events: string[] = [];
  return {
    clock,
    events,
    m: new Mesh({ clock, onEvent: (e) => events.push(`${e.type}: ${e.message}`) }),
  };
}

async function laptop(m: Mesh) {
  return m.register({ id: 'laptop', name: 'Laptop', kind: 'laptop', capabilities: ['shell', 'browser', 'gpu', 'whatsapp'] });
}
async function cloud(m: Mesh) {
  return m.register({ id: 'cloud', name: 'Vercel', kind: 'cloud', capabilities: ['always-on', 'email'] });
}
async function phone(m: Mesh) {
  return m.register({ id: 'phone', name: 'A07', kind: 'phone', capabilities: ['sms', 'whatsapp', 'camera'] });
}

test('the highest-priority capable node gets the work, and the others leave it alone', async () => {
  const { m } = mesh();
  await laptop(m);
  await cloud(m);
  await m.register({ id: 'shared', name: 'Shared', kind: 'cloud', capabilities: ['shell'], priority: 5 });

  const task = await m.enqueue({ title: 'build the site', requires: ['shell'] });

  // The lower-priority node can run it, but the laptop is awake — so it waits.
  assert.equal(await m.claimNext('shared'), undefined);
  const claimed = await m.claimNext('laptop');
  assert.equal(claimed?.id, task.id);
  assert.equal(claimed?.claimedBy, 'laptop');
});

test('a task nobody can run right now waits, and says what it is waiting for', async () => {
  const { clock, m } = mesh();
  await laptop(m);
  await cloud(m);
  const task = await m.enqueue({ title: 'render in Unreal', requires: ['gpu'] });

  // Laptop goes to sleep.
  clock.advance(120_000);
  await m.heartbeat('cloud');

  assert.equal(await m.claimNext('cloud'), undefined, 'the cloud has no GPU — it must not take this');
  assert.equal((await m.store.getTask(task.id))?.state, 'pending', 'pending is not failure');
  assert.match(await m.explainWait(task.id) ?? '', /waiting for Laptop to come online/);

  // Laptop wakes up and the work simply runs.
  await m.heartbeat('laptop');
  assert.equal((await m.claimNext('laptop'))?.id, task.id);
});

test('a node that stops reporting loses the task, and its progress is kept', async () => {
  const { clock, m } = mesh();
  await laptop(m);
  const task = await m.enqueue({ title: 'long build', requires: ['shell'] });

  const claimed = await m.claimNext('laptop');
  await m.progress(claimed!.id, 'laptop', { step: 'installed dependencies' });

  // The lid closes mid-task. Nothing tells the mesh; the lease just lapses.
  clock.advance(10 * 60_000);
  const reclaimed = await m.reclaimExpired();
  assert.equal(reclaimed.length, 1);

  const after = await m.store.getTask(task.id);
  assert.equal(after?.state, 'pending');
  assert.equal(after?.claimedBy, undefined);
  assert.deepEqual(after?.checkpoint, { step: 'installed dependencies' }, 'the work already done is not thrown away');
  assert.match(after?.waitingFor ?? '', /lease held by laptop expired/);

  // After the reboot it picks up where it was.
  const again = await m.claimNext('laptop');
  assert.equal(again?.id, task.id);
  assert.deepEqual(again?.checkpoint, { step: 'installed dependencies' });
});

test('gentle gear takes only urgent work — the laptop stops competing with you', async () => {
  const { m } = mesh();
  await laptop(m);
  await m.enqueue({ title: 'nightly rebuild', requires: ['shell'] });
  const urgent = await m.enqueue({ title: 'send the client this file', requires: ['shell'], urgent: true });

  await m.heartbeat('laptop', { gear: 'gentle' });
  const claimed = await m.claimNext('laptop');
  assert.equal(claimed?.id, urgent.id, 'only the urgent one gets through while you are working');

  const deferred = (await m.store.listTasks()).find((t) => t.title === 'nightly rebuild');
  assert.match(await m.explainWait(deferred!.id) ?? '', /deferred while you are using the machine/);

  // You walk away; the backlog drains.
  await m.heartbeat('laptop', { gear: 'full', concurrency: 3 });
  assert.equal((await m.claimNext('laptop'))?.title, 'nightly rebuild');
});

test('a paused node takes nothing at all', async () => {
  const { m } = mesh();
  await laptop(m);
  await m.enqueue({ title: 'anything', requires: ['shell'], urgent: true });
  await m.heartbeat('laptop', { gear: 'stop', health: { temperatureC: 91 } });
  assert.equal(await m.claimNext('laptop'), undefined, 'too hot to work is a real answer');
});

test('phone-only work goes to the phone even though the laptop outranks it', async () => {
  const { m } = mesh();
  await laptop(m);
  await phone(m);
  const sms = await m.enqueue({ title: 'text the client', requires: ['sms'] });
  assert.equal(await m.claimNext('laptop'), undefined, 'the laptop cannot send SMS');
  assert.equal((await m.claimNext('phone'))?.id, sms.id);
});

test('two nodes reaching for the same task — exactly one gets it', async () => {
  const { m } = mesh();
  await m.register({ id: 'a', name: 'A', kind: 'cloud', capabilities: ['always-on'], priority: 10 });
  await m.register({ id: 'b', name: 'B', kind: 'cloud', capabilities: ['always-on'], priority: 10 });
  await m.enqueue({ title: 'only once', requires: ['always-on'] });

  const [first, second] = await Promise.all([m.claimNext('a'), m.claimNext('b')]);
  const winners = [first, second].filter(Boolean);
  assert.equal(winners.length, 1, 'a task run twice is a task done wrong');
});

test('a failure is retried with backoff, and only gives up when the attempts run out', async () => {
  const { clock, m } = mesh();
  await laptop(m);
  const task = await m.enqueue({ title: 'flaky step', requires: ['shell'], maxAttempts: 2 });

  const first = await m.claimNext('laptop');
  const afterFail = await m.fail(first!.id, 'laptop', 'network dropped');
  assert.equal(afterFail.state, 'pending', 'one error does not end the task');
  assert.match(await m.explainWait(task.id) ?? '', /retrying in \d+s after: network dropped/);

  // Still inside the backoff — nothing is offered.
  assert.equal(await m.claimNext('laptop'), undefined);
  clock.advance(60_000);

  const second = await m.claimNext('laptop');
  assert.equal(second?.attempts, 2);
  const exhausted = await m.fail(second!.id, 'laptop', 'network dropped again');
  assert.equal(exhausted.state, 'failed', 'it does give up eventually, and says why');
  assert.match(exhausted.error ?? '', /network dropped again/);
});

test('parking is not failing — the attempt is handed back and the reason is kept', async () => {
  const { clock, m } = mesh();
  await laptop(m);
  const task = await m.enqueue({ title: 'write the feature', requires: ['shell'], maxAttempts: 2 });

  const claimed = await m.claimNext('laptop');
  assert.equal(claimed?.attempts, 1);

  const parked = await m.park(
    task.id,
    'laptop',
    clock.now() + 4 * 3_600_000,
    'every coding agent is out of quota — work resumes when the first one comes back',
  );
  assert.equal(parked.state, 'pending');
  assert.equal(parked.attempts, 0, 'running out of quota must not push the task closer to being abandoned');
  assert.match(await m.explainWait(task.id) ?? '', /out of quota/);

  assert.equal(await m.claimNext('laptop'), undefined, 'and it is not offered again before then');
  clock.advance(4 * 3_600_000 + 1);
  assert.equal((await m.claimNext('laptop'))?.id, task.id, 'it comes back on its own');
});

test('only the holder may report on a task', async () => {
  const { m } = mesh();
  await laptop(m);
  await cloud(m);
  const task = await m.enqueue({ title: 'mine', requires: ['shell'] });
  await m.claimNext('laptop');
  await assert.rejects(m.complete(task.id, 'cloud'), /not held by cloud/);
});

test('a capability no node has is called out, not left silent', async () => {
  const { m } = mesh();
  await cloud(m);
  const task = await m.enqueue({ title: 'take a photo', requires: ['camera'] });
  assert.match(await m.explainWait(task.id) ?? '', /no node can run this — it needs camera/);
});

test('the snapshot shows who is online and what the queue is doing', async () => {
  const { clock, m } = mesh();
  await laptop(m);
  await cloud(m);
  await m.enqueue({ title: 'a', requires: ['shell'] });
  const running = await m.enqueue({ title: 'b', requires: ['shell'] });
  await m.claimNext('laptop');

  clock.advance(120_000);
  await m.heartbeat('cloud');

  const snapshot = await m.snapshot();
  assert.equal(snapshot.nodes.find((n) => n.id === 'laptop')?.online, false, 'a silent node is shown as offline');
  assert.equal(snapshot.nodes.find((n) => n.id === 'cloud')?.online, true);
  assert.equal(snapshot.counts.pending + snapshot.counts.claimed + snapshot.counts.running, 2);
  assert.ok(snapshot.tasks.some((t) => t.id === running.id));
});

test('registering the same node twice updates it instead of duplicating it', async () => {
  const { m } = mesh();
  await laptop(m);
  await m.heartbeat('laptop', { gear: 'gentle' });
  const again = await m.register({ id: 'laptop', name: 'Laptop', kind: 'laptop', capabilities: ['shell'] });
  assert.equal(again.gear, 'gentle', 'a re-register does not reset the gear it chose');
  assert.equal((await m.store.listNodes()).length, 1);
});
