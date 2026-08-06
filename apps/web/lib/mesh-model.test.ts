import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTask, describeGear, explainWait, isOnline, type MeshNodeDoc, type MeshTaskDoc } from './mesh-model.ts';

function node(overrides: Partial<MeshNodeDoc> = {}): MeshNodeDoc {
  return {
    _id: 'laptop',
    name: 'Laptop',
    kind: 'laptop',
    capabilities: ['shell', 'browser', 'whatsapp'],
    priority: 100,
    gear: 'full',
    concurrency: 3,
    lastSeen: 1_000,
    ...overrides,
  };
}

function task(overrides: Partial<MeshTaskDoc> = {}): MeshTaskDoc {
  return {
    _id: 'mtask_1',
    title: 'do the thing',
    payload: {},
    state: 'pending',
    requires: ['shell'],
    interactive: false,
    urgent: false,
    priority: 0,
    createdAt: 0,
    updatedAt: 0,
    rev: 1,
    attempts: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

/* ---------------- queueing from the website ---------------- */

test('a coding task without a folder is refused here, not on the machine', () => {
  // Otherwise it travels all the way to a laptop, spends a claim and an
  // attempt, and fails at 3am with nobody watching.
  const built = buildTask({ kind: 'coder', title: 'add the hero' });
  assert.equal(built.ok, false);
  assert.match(built.error ?? '', /needs a project folder/);
});

test('a relative folder is refused, with the shape of a real one shown', () => {
  const built = buildTask({ kind: 'coder', title: 'x', projectDir: 'projects/velocity' });
  assert.equal(built.ok, false);
  assert.match(built.error ?? '', /not a full path/);
  assert.match(built.error ?? '', /C:\/projects\/velocity/);
});

test('both Windows and posix full paths are accepted', () => {
  assert.equal(buildTask({ kind: 'coder', title: 'x', projectDir: 'C:/projects/v' }).ok, true);
  assert.equal(buildTask({ kind: 'coder', title: 'x', projectDir: 'C:\\projects\\v' }).ok, true);
  assert.equal(buildTask({ kind: 'coder', title: 'x', projectDir: '/home/me/v' }).ok, true);
});

test('what needs the screen is decided by the kind, not by whoever fills the form', () => {
  const coding = buildTask({ kind: 'coder', title: 'write it', projectDir: '/p' });
  const onScreen = buildTask({ kind: 'desktop', title: 'open the app and look' });

  assert.equal(coding.task?.interactive, false, 'a background coding agent does not disturb anyone');
  assert.equal(onScreen.task?.interactive, true);
  assert.deepEqual(onScreen.task?.requires, ['shell', 'browser']);
});

test('the goal defaults to the task, so a handoff brief is never empty', () => {
  const built = buildTask({ kind: 'shell', title: 'run the tests', projectDir: '/p' });
  assert.equal(built.task?.payload['goal'], 'run the tests');
});

test('a kind nobody implements is rejected rather than queued forever', () => {
  const built = buildTask({ kind: 'telepathy', title: 'read my mind' });
  assert.equal(built.ok, false);
  assert.match(built.error ?? '', /not a kind of task this queue knows about/);
});

test('an empty description is not a task', () => {
  assert.equal(buildTask({ kind: 'coder', title: '   ', projectDir: '/p' }).ok, false);
});

/* ---------------- saying what is going on ---------------- */

test('a queue with no machines says so, instead of blaming capabilities', () => {
  // "no node has shell" sends people hunting for a setting. There is no
  // setting: a machine joins by running the agent.
  const why = explainWait(task(), [], 5_000);
  assert.match(why ?? '', /no machine has joined the queue yet/);
});

test('screen work waiting for you to leave says exactly that', () => {
  const why = explainWait(task({ interactive: true }), [node({ gear: 'background', lastSeen: 5_000 })], 5_000);
  assert.match(why ?? '', /waits until you step away/);
});

test('background work is never reported as waiting for you', () => {
  const why = explainWait(task(), [node({ gear: 'background', lastSeen: 5_000 })], 5_000);
  assert.equal(why, 'queued, waiting for a free slot');
});

test('what the machine itself wrote wins over anything guessed here', () => {
  const parked = task({
    notBefore: 9_000,
    waitingFor: 'every coding agent is out of quota — work resumes when the first one comes back',
  });
  const why = explainWait(parked, [node()], 5_000);
  assert.match(why ?? '', /every coding agent is out of quota/);
  assert.match(why ?? '', /in 4s/, 'and it adds when, which the machine did not know at the time');
});

test('a sleeping laptop is named, not hidden behind "no capable node"', () => {
  const why = explainWait(task(), [node({ lastSeen: 0 })], 5 * 60_000);
  assert.match(why ?? '', /waiting for Laptop to come online/);
});

test('online is a question about the last heartbeat, not about the gear', () => {
  assert.equal(isOnline(node({ lastSeen: 1_000, gear: 'stop' }), 10_000), true);
  assert.equal(isOnline(node({ lastSeen: 1_000 }), 120_000), false);
});

test('a gear is explained in words, because the word alone is not obvious', () => {
  assert.equal(describeGear('background'), 'in use — background work only');
  assert.equal(describeGear('full'), 'running everything');
  assert.equal(describeGear('stop'), 'paused');
});
