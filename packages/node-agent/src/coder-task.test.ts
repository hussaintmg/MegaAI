import test from 'node:test';
import assert from 'node:assert/strict';
import { CoderPool, type CoderLauncher } from '@megaai/coders';
import { Mesh, type MeshTask } from '@megaai/mesh';
import type { JsonObject } from '@megaai/types';
import { ManualClock } from '@megaai/utils';
import { NodeAgent, type TaskContext } from './agent.js';
import { coderLockKey, createCoderHandler, listProjectFiles, parseGitStatus } from './coder-task.js';
import { ResourceGuard } from './guard.js';
import type { MachineSample } from './machine.js';

const AWAY: MachineSample = { at: 0, cpuLoad: 0.1, memUsedPct: 0.4, idleSeconds: 900 };
const PAYLOAD = {
  kind: 'coder',
  goal: 'build the 3d car website',
  task: 'add the scroll animations',
  projectDir: 'C:\\projects\\velocity',
};

/** A launcher that answers from a script and keeps every prompt it was given. */
function scripted(replies: Array<{ exitCode: number; output: string }>) {
  const prompts: string[] = [];
  const launcher: CoderLauncher = async (_command, args, _cwd) => {
    prompts.push(args.join(' '));
    return replies.shift() ?? { exitCode: 0, output: 'done' };
  };
  return { launcher, prompts };
}

function pool(clock: ManualClock) {
  const p = new CoderPool({ clock });
  p.setInstalled(['claude', 'codex', 'opencode']);
  return p;
}

function contextFor(payload: JsonObject, checkpoint?: JsonObject) {
  const task = {
    id: 'task-1',
    title: 'scroll animations',
    payload,
    state: 'running',
    requires: [],
    urgent: false,
    priority: 0,
    createdAt: 0,
    updatedAt: 0,
    rev: 1,
    attempts: 1,
    maxAttempts: 3,
    ...(checkpoint ? { checkpoint } : {}),
  } as MeshTask;
  let merged: JsonObject = { ...(checkpoint ?? {}) };
  const context: TaskContext = {
    task,
    signal: new AbortController().signal,
    checkpoint: async (patch) => {
      merged = { ...merged, ...patch };
    },
    log: () => {},
  };
  return { context, saved: () => merged };
}

test('a night that runs out of quota waits for the first reset instead of failing', async () => {
  const clock = new ManualClock(Date.parse('2026-08-06T22:00:00Z'));
  const mesh = new Mesh({ clock });
  const { launcher } = scripted([
    { exitCode: 1, output: 'Claude usage limit reached. Your limit will reset at 2026-08-07T06:00:00Z' },
    { exitCode: 1, output: 'rate limit exceeded, resets at 2026-08-07T02:00:00Z' },
    { exitCode: 1, output: 'quota exceeded — retry after 9 hours' },
  ]);

  const agent = new NodeAgent({
    mesh,
    name: 'Laptop',
    capabilities: ['shell'],
    guard: new ResourceGuard({ clock, thresholds: { minHoldMs: 0 } }),
    sample: () => ({ ...AWAY, at: clock.now() }),
    handlers: { coder: createCoderHandler({ pool: pool(clock), launcher }) },
    clock,
    tickMs: 0,
    renewMs: 0,
    lockKeyFor: (task) => coderLockKey(task.payload),
  });

  const task = await mesh.enqueue({ title: 'scroll animations', requires: ['shell'], payload: PAYLOAD, maxAttempts: 2 });
  await agent.start();
  await agent.drain();

  const after = await mesh.store.getTask(task.id);
  assert.equal(after?.state, 'pending', 'running out of quota is not the work failing');
  assert.equal(after?.attempts, 0, 'and it does not spend one of the task’s attempts');
  assert.equal(after?.notBefore, Date.parse('2026-08-07T02:00:00Z'), 'the soonest reset is when the night resumes');
  assert.match(after?.waitingFor ?? '', /every coding agent is out of quota/);

  // Nothing is offered before then, and it comes back on its own after.
  assert.equal(await mesh.claimNext(agent.nodeId), undefined);
  clock.advance(4 * 3_600_000);
  assert.equal((await mesh.claimNext(agent.nodeId))?.id, task.id);
});

test('the handoff is written down, so a reboot between agents loses nothing', async () => {
  const clock = new ManualClock(0);

  // Night, part one: Claude works and runs out, Codex continues and runs out.
  const first = scripted([
    { exitCode: 1, output: 'wrote components/Hero.tsx\nClaude usage limit reached, resets at 2026-08-07T06:00:00Z' },
    { exitCode: 1, output: 'wrote lib/cars.ts\nrate limit exceeded, resets at 2026-08-07T07:00:00Z' },
    { exitCode: 1, output: 'quota exhausted' },
  ]);
  const one = contextFor(PAYLOAD);
  const before = await createCoderHandler({ pool: pool(clock), launcher: first.launcher })(one.context);
  assert.equal(before.kind, 'parked');

  const carried = one.saved();
  const coder = carried['coder'] as { history: Array<{ coder: string; summary: string }> };
  assert.equal(coder.history.length >= 2, true, 'each turn is recorded as it happens, not at the end');
  assert.match(coder.history[0]?.summary ?? '', /claude/);

  // …and then Windows reboots. A fresh process picks the same task back up.
  const second = scripted([{ exitCode: 0, output: 'Added the scroll animations and verified the build.' }]);
  const two = contextFor(PAYLOAD, carried);
  const after = await createCoderHandler({ pool: pool(clock), launcher: second.launcher })(two.context);

  assert.equal(after.kind, 'done');
  const prompt = second.prompts[0] ?? '';
  assert.match(prompt, /Do not start over/);
  assert.match(prompt, /components\/Hero\.tsx/, 'the new agent is told what the first one wrote');
  assert.match(prompt, /lib\/cars\.ts/, 'and what the second one wrote');
});

test('what changed on disk goes into the brief', async () => {
  const clock = new ManualClock(0);
  const { launcher, prompts } = scripted([{ exitCode: 0, output: 'done' }]);
  const handler = createCoderHandler({
    pool: pool(clock),
    launcher,
    changedFiles: async () => ['app/page.tsx', 'components/Hero.tsx'],
  });

  const one = contextFor(PAYLOAD);
  await handler(one.context);
  assert.match(prompts[0] ?? '', /- app\/page\.tsx/);
});

test('a finished task says who finished it and how many hands it went through', async () => {
  const clock = new ManualClock(0);
  const { launcher } = scripted([
    { exitCode: 1, output: 'usage limit reached, resets at 2026-08-07T06:00:00Z' },
    { exitCode: 0, output: 'Done: added the scroll animations.' },
  ]);
  const one = contextFor(PAYLOAD);
  const outcome = await createCoderHandler({ pool: pool(clock), launcher })(one.context);

  assert.equal(outcome.kind, 'done');
  assert.deepEqual(outcome.kind === 'done' ? outcome.result?.['coders'] : undefined, ['claude', 'codex']);
  assert.equal(outcome.kind === 'done' ? outcome.result?.['handoffs'] : undefined, 1);
  assert.equal(outcome.kind === 'done' ? outcome.result?.['finishedBy'] : undefined, 'codex');
});

test('no coding agent installed is a failure with an answer, not a wait forever', async () => {
  const clock = new ManualClock(0);
  const empty = new CoderPool({ clock });
  empty.setInstalled([]);
  const one = contextFor(PAYLOAD);
  const outcome = await createCoderHandler({ pool: empty, launcher: scripted([]).launcher })(one.context);

  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.kind === 'failed' ? outcome.error : '', /no coding agent is installed/);
});

test('a task missing its folder is rejected before anything is spawned', async () => {
  const clock = new ManualClock(0);
  const { launcher, prompts } = scripted([{ exitCode: 0, output: 'done' }]);
  const one = contextFor({ kind: 'coder', goal: 'x', task: 'y' });
  const outcome = await createCoderHandler({ pool: pool(clock), launcher })(one.context);

  assert.equal(outcome.kind, 'failed');
  assert.equal(prompts.length, 0, 'running a coding agent in the wrong folder is worse than not running it');
});

test('outside a git repo the next agent is still told what is in the folder', async () => {
  // Without this the brief says "read the files listed above" and lists
  // nothing — which is how an agent rewrites a page that already existed.
  const clock = new ManualClock(0);
  const { launcher, prompts } = scripted([{ exitCode: 0, output: 'done' }]);
  const handler = createCoderHandler({
    pool: pool(clock),
    launcher,
    changedFiles: async () => [],
    projectFiles: async () => ['index.html', 'app/page.tsx'],
  });

  await handler(contextFor(PAYLOAD).context);
  assert.match(prompts[0] ?? '', /Files already in this project/);
  assert.match(prompts[0] ?? '', /- index\.html/);
});

test('the folder listing skips what would drown the brief', () => {
  const tree: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
    '/p': [
      { name: 'index.html', isDirectory: false },
      { name: 'node_modules', isDirectory: true },
      { name: '.git', isDirectory: true },
      { name: '.next', isDirectory: true },
      { name: 'app', isDirectory: true },
    ],
    '/p/app': [{ name: 'page.tsx', isDirectory: false }],
    '/p/node_modules': [{ name: 'react', isDirectory: true }],
  };
  const files = listProjectFiles('/p', { readDir: (dir) => tree[dir] ?? [] });
  // node_modules alone would be tens of thousands of paths, and would push the
  // part that matters out of the agent's context.
  assert.deepEqual(files, ['index.html', 'app/page.tsx']);
});

test('a folder that cannot be read is not a crash', () => {
  assert.deepEqual(
    listProjectFiles('/p', {
      readDir: () => {
        throw new Error('EACCES');
      },
    }),
    [],
  );
});

test('git status is read as paths, including renames', () => {
  assert.deepEqual(
    parseGitStatus(' M app/page.tsx\n?? components/Hero.tsx\nR  lib/old.ts -> lib/cars.ts\n\n'),
    ['app/page.tsx', 'components/Hero.tsx', 'lib/cars.ts'],
  );
});
