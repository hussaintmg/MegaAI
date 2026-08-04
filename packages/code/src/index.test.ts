import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGitTools, GitEngine } from './index.js';

function workspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'megaai-git-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('git is available in this environment', async () => {
  assert.equal(await GitEngine.isAvailable(), true);
});

test('commitAll initialises, commits, and skips empty commits', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    assert.equal(engine.isRepo(dir), false);

    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const first = await engine.commitAll(dir, 'first delivery');
    assert.ok(first, 'expected a commit sha');
    assert.equal(engine.isRepo(dir), true);

    // Nothing changed → no new commit.
    assert.equal(await engine.commitAll(dir, 'noop'), undefined);

    writeFileSync(join(dir, 'b.txt'), 'two\n');
    const second = await engine.commitAll(dir, 'second delivery');
    assert.ok(second && second !== first);

    const log = await engine.log(dir);
    assert.deepEqual(
      log.map((entry) => entry.message),
      ['second delivery', 'first delivery'],
    );
    assert.deepEqual(await engine.status(dir), []);
  } finally {
    cleanup();
  }
});

test('status and diff report uncommitted work', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'x.txt'), 'v1\n');
    await engine.commitAll(dir, 'base');
    writeFileSync(join(dir, 'x.txt'), 'v2 changed\n');
    const status = await engine.status(dir);
    assert.equal(status.length, 1);
    assert.equal(status[0]?.path, 'x.txt');
    const diff = await engine.diff(dir);
    assert.match(diff, /x\.txt/);
  } finally {
    cleanup();
  }
});

test('git tools work through the tool contract and stay in the workspace', async () => {
  const { dir, cleanup } = workspace();
  try {
    const [commit, status, log] = createGitTools();
    writeFileSync(join(dir, 'file.txt'), 'hello\n');
    const committed = (await commit!.execute({ message: 'via tool' }, { workspaceRoot: dir })) as {
      committed: boolean;
      sha?: string;
    };
    assert.equal(committed.committed, true);
    assert.ok(committed.sha);

    const clean = (await status!.execute({}, { workspaceRoot: dir })) as { clean: boolean };
    assert.equal(clean.clean, true);

    const history = (await log!.execute({}, { workspaceRoot: dir })) as {
      commits: Array<{ message: string }>;
    };
    assert.equal(history.commits[0]?.message, 'via tool');

    await assert.rejects(commit!.execute({ message: '' }, { workspaceRoot: dir }), /must not be empty/);
  } finally {
    cleanup();
  }
});

test('createBranch/checkout/listBranches/currentBranch manage local branches', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');
    const base = await engine.currentBranch(dir);

    await engine.createBranch(dir, 'feature/one');
    assert.equal(await engine.currentBranch(dir), 'feature/one');
    assert.deepEqual((await engine.listBranches(dir)).sort(), [base, 'feature/one'].sort());

    await engine.checkout(dir, base!);
    assert.equal(await engine.currentBranch(dir), base);

    await engine.createBranch(dir, 'feature/two', { checkout: false });
    assert.equal(await engine.currentBranch(dir), base, 'checkout:false must not switch branches');
  } finally {
    cleanup();
  }
});

test('merge fast-forwards clean changes and cleanly reports conflicts', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'shared.txt'), 'base\n');
    await engine.commitAll(dir, 'base');
    const main = await engine.currentBranch(dir);

    await engine.createBranch(dir, 'feature/clean');
    writeFileSync(join(dir, 'new.txt'), 'added on branch\n');
    await engine.commitAll(dir, 'add new file');
    await engine.checkout(dir, main!);

    const clean = await engine.merge(dir, 'feature/clean');
    assert.equal(clean.merged, true);
    assert.equal(clean.conflict, false);
    assert.ok(clean.sha);

    await engine.createBranch(dir, 'feature/conflict');
    writeFileSync(join(dir, 'shared.txt'), 'from branch\n');
    await engine.commitAll(dir, 'conflicting change on branch');
    await engine.checkout(dir, main!);
    writeFileSync(join(dir, 'shared.txt'), 'from main\n');
    await engine.commitAll(dir, 'conflicting change on main');

    const conflicted = await engine.merge(dir, 'feature/conflict');
    assert.equal(conflicted.merged, false);
    assert.equal(conflicted.conflict, true);
    assert.deepEqual(await engine.status(dir), [], 'a conflicting merge must be aborted, leaving a clean tree');
  } finally {
    cleanup();
  }
});

test('push publishes the current branch to a local remote', async () => {
  const { dir: remoteDir, cleanup: cleanupRemote } = workspace();
  const { dir, cleanup } = workspace();
  try {
    await promisify(execFile)('git', ['init', '--bare', remoteDir]);

    const engine = new GitEngine();
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');
    await engine.run(dir, ['remote', 'add', 'origin', remoteDir]);

    const result = await engine.push(dir, { setUpstream: true });
    assert.equal(result.pushed, true);
    assert.equal(result.remote, 'origin');
    assert.equal(result.branch, await engine.currentBranch(dir));

    await assert.rejects(engine.push(dir, { remote: 'does-not-exist' }), /git push failed/);
  } finally {
    cleanup();
    cleanupRemote();
  }
});

test('branch/checkout/merge/push tools respect dryRun and stay in the workspace', async () => {
  const { dir: remoteDir, cleanup: cleanupRemote } = workspace();
  const { dir, cleanup } = workspace();
  try {
    await promisify(execFile)('git', ['init', '--bare', remoteDir]);

    const [, , , , branches, branch, checkout, merge, push] = createGitTools();
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const engine = new GitEngine();
    await engine.commitAll(dir, 'base');
    await engine.run(dir, ['remote', 'add', 'origin', remoteDir]);
    const main = await engine.currentBranch(dir);

    const dryBranch = await branch!.execute({ name: 'feature/dry' }, { workspaceRoot: dir, dryRun: true });
    assert.deepEqual(dryBranch, { wouldCreate: 'feature/dry', checkout: true });
    assert.equal(await engine.currentBranch(dir), main, 'dryRun must not create the branch');

    await branch!.execute({ name: 'feature/live' }, { workspaceRoot: dir });
    assert.equal(await engine.currentBranch(dir), 'feature/live');

    await checkout!.execute({ name: main! }, { workspaceRoot: dir });
    assert.equal(await engine.currentBranch(dir), main);

    const mergeResult = (await merge!.execute({ branch: 'feature/live' }, { workspaceRoot: dir })) as {
      merged: boolean;
    };
    assert.equal(mergeResult.merged, true);

    const listed = (await branches!.execute({}, { workspaceRoot: dir })) as { branches: string[] };
    assert.ok(listed.branches.includes('feature/live'));

    const dryPush = await push!.execute({}, { workspaceRoot: dir, dryRun: true });
    assert.deepEqual(dryPush, { wouldPush: { remote: 'origin', branch: '(current)' } });

    const pushed = (await push!.execute({}, { workspaceRoot: dir })) as { pushed: boolean };
    assert.equal(pushed.pushed, true);
  } finally {
    cleanup();
    cleanupRemote();
  }
});
