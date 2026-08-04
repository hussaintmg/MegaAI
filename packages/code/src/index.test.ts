import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('branches: list, create, checkout', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');
    const base = await engine.currentBranch(dir);

    await engine.createBranch(dir, 'feature', { checkout: true });
    assert.equal(await engine.currentBranch(dir), 'feature');
    assert.deepEqual(new Set(await engine.listBranches(dir)), new Set([base, 'feature']));

    await engine.checkout(dir, base!);
    assert.equal(await engine.currentBranch(dir), base);

    await assert.rejects(engine.checkout(dir, 'does-not-exist'), /git checkout failed/);
    await assert.rejects(engine.createBranch(dir, ''), /must not be empty/);
  } finally {
    cleanup();
  }
});

test('merge: fast-forwards cleanly and reports conflicts without leaving one behind', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'shared.txt'), 'base\n');
    await engine.commitAll(dir, 'base');
    const base = await engine.currentBranch(dir);

    await engine.createBranch(dir, 'feature', { checkout: true });
    writeFileSync(join(dir, 'feature.txt'), 'new file\n');
    await engine.commitAll(dir, 'feature work');
    await engine.checkout(dir, base!);

    const clean = await engine.merge(dir, 'feature');
    assert.equal(clean.merged, true);
    assert.equal(clean.conflict, false);
    assert.ok(clean.sha);
    assert.ok(existsSync(join(dir, 'feature.txt')));

    // Now create a genuine conflict.
    await engine.createBranch(dir, 'conflict-a', { checkout: true });
    writeFileSync(join(dir, 'shared.txt'), 'from a\n');
    await engine.commitAll(dir, 'a change');
    await engine.checkout(dir, base!);
    await engine.createBranch(dir, 'conflict-b', { checkout: true });
    writeFileSync(join(dir, 'shared.txt'), 'from b\n');
    await engine.commitAll(dir, 'b change');

    const conflict = await engine.merge(dir, 'conflict-a');
    assert.equal(conflict.merged, false);
    assert.equal(conflict.conflict, true);
    // Merge was aborted: workspace is clean and still on conflict-b.
    assert.deepEqual(await engine.status(dir), []);
    assert.equal(await engine.currentBranch(dir), 'conflict-b');
  } finally {
    cleanup();
  }
});

test('push: publishes the current branch to a remote', async () => {
  const { dir: remoteDir, cleanup: cleanupRemote } = workspace();
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    const bare = await engine.run(remoteDir, ['init', '--bare']);
    assert.equal(bare.exitCode, 0);

    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');
    await engine.addRemote(dir, 'origin', remoteDir);
    assert.deepEqual(await engine.listRemotes(dir), ['origin']);

    const branch = await engine.currentBranch(dir);
    const pushed = await engine.push(dir, { setUpstream: true });
    assert.equal(pushed.exitCode, 0);

    const remoteLog = await engine.run(remoteDir, ['log', '--pretty=%s', branch!]);
    assert.match(remoteLog.stdout, /base/);
  } finally {
    cleanup();
    cleanupRemote();
  }
});

test('git.push tool carries the git.push permission so policy can gate it', () => {
  const [, , , , , , , , push] = createGitTools();
  assert.equal(push!.name, 'git.push');
  assert.deepEqual(push!.permissions, ['git.push']);
});
