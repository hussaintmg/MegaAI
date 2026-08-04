import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('branches: create, list, checkout', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');
    assert.equal(await engine.currentBranch(dir), 'main');

    await engine.createBranch(dir, 'feature/x');
    assert.equal(await engine.currentBranch(dir), 'feature/x');

    const branches = await engine.listBranches(dir);
    assert.deepEqual(
      branches.map((b) => b.name).sort(),
      ['feature/x', 'main'],
    );
    assert.deepEqual(
      branches.filter((b) => b.current).map((b) => b.name),
      ['feature/x'],
    );

    await engine.checkout(dir, 'main');
    assert.equal(await engine.currentBranch(dir), 'main');

    await assert.rejects(engine.checkout(dir, 'does-not-exist'), /git checkout failed/);
  } finally {
    cleanup();
  }
});

test('merge: fast case succeeds, conflicting case aborts cleanly', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'shared.txt'), 'base\n');
    await engine.commitAll(dir, 'base');

    await engine.createBranch(dir, 'feature');
    writeFileSync(join(dir, 'feature-only.txt'), 'new\n');
    await engine.commitAll(dir, 'feature work');
    await engine.checkout(dir, 'main');

    const clean = await engine.merge(dir, 'feature');
    assert.equal(clean.merged, true);
    assert.equal(clean.conflict, false);
    assert.ok(clean.sha);

    // Now create a genuine conflict.
    await engine.createBranch(dir, 'conflict-a');
    writeFileSync(join(dir, 'shared.txt'), 'from a\n');
    await engine.commitAll(dir, 'change on a');
    await engine.checkout(dir, 'main');
    writeFileSync(join(dir, 'shared.txt'), 'from main\n');
    await engine.commitAll(dir, 'change on main');

    const conflicted = await engine.merge(dir, 'conflict-a');
    assert.equal(conflicted.merged, false);
    assert.equal(conflicted.conflict, true);
    // Merge was aborted, so the workspace is clean and back on main.
    assert.deepEqual(await engine.status(dir), []);
    assert.equal(await engine.currentBranch(dir), 'main');
  } finally {
    cleanup();
  }
});

test('push: publishes the current branch to a local remote', async () => {
  const { dir: remoteDir, cleanup: cleanupRemote } = workspace();
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    const bare = await engine.run(remoteDir, ['init', '--bare']);
    assert.equal(bare.exitCode, 0);

    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');

    const result = await engine.push(dir, { remoteUrl: remoteDir, setUpstream: true });
    assert.equal(result.exitCode, 0);

    const clone = await engine.run(remoteDir, ['log', '--oneline', '--all']);
    assert.match(clone.stdout, /base/);
  } finally {
    cleanup();
    cleanupRemote();
  }
});

test('git tools expose branch, checkout, merge and push', async () => {
  const { dir: remoteDir, cleanup: cleanupRemote } = workspace();
  const { dir, cleanup } = workspace();
  try {
    const [, , , , branch, checkout, merge, push] = createGitTools();
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const [commit] = createGitTools();
    await commit!.execute({ message: 'base' }, { workspaceRoot: dir });

    const created = (await branch!.execute({ name: 'feature' }, { workspaceRoot: dir })) as {
      created: boolean;
      branch: string;
    };
    assert.equal(created.created, true);
    assert.equal(created.branch, 'feature');

    const listed = (await branch!.execute({}, { workspaceRoot: dir })) as {
      branches: Array<{ name: string; current: boolean }>;
    };
    assert.ok(listed.branches.some((b) => b.name === 'feature' && b.current));

    await checkout!.execute({ branch: 'main' }, { workspaceRoot: dir });
    const mergeResult = (await merge!.execute({ branch: 'feature' }, { workspaceRoot: dir })) as {
      merged: boolean;
    };
    assert.equal(mergeResult.merged, true);

    const bare = new GitEngine();
    const bareInit = await bare.run(remoteDir, ['init', '--bare']);
    assert.equal(bareInit.exitCode, 0);
    const pushed = (await push!.execute(
      { remoteUrl: remoteDir, setUpstream: true },
      { workspaceRoot: dir },
    )) as { pushed: boolean };
    assert.equal(pushed.pushed, true);
  } finally {
    cleanup();
    cleanupRemote();
  }
});
