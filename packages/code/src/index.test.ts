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

test('branch create, checkout and list track the current branch', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');

    await engine.createBranch(dir, 'feature');
    assert.equal(await engine.currentBranch(dir), 'main');

    await engine.checkout(dir, 'feature');
    assert.equal(await engine.currentBranch(dir), 'feature');

    const branches = await engine.listBranches(dir);
    assert.deepEqual(
      branches.map((b) => b.name).sort(),
      ['feature', 'main'],
    );
    assert.deepEqual(
      branches.filter((b) => b.current).map((b) => b.name),
      ['feature'],
    );

    await engine.checkout(dir, 'other', { create: true });
    assert.equal(await engine.currentBranch(dir), 'other');
  } finally {
    cleanup();
  }
});

test('merge brings a branch into the current one and rejects an unmergeable state cleanly', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'shared.txt'), 'base\n');
    await engine.commitAll(dir, 'base');

    await engine.checkout(dir, 'feature', { create: true });
    writeFileSync(join(dir, 'feature.txt'), 'from feature\n');
    await engine.commitAll(dir, 'feature work');

    await engine.checkout(dir, 'main');
    const merged = await engine.merge(dir, 'feature');
    assert.ok(merged.sha);
    assert.equal(merged.fastForward, true);
    assert.deepEqual(await engine.status(dir), []);

    // Diverging edits to the same line on both branches → conflict, clean abort.
    writeFileSync(join(dir, 'shared.txt'), 'main change\n');
    await engine.commitAll(dir, 'main edits shared');
    await engine.checkout(dir, 'conflict', { create: true });
    writeFileSync(join(dir, 'shared.txt'), 'conflicting change\n');
    await engine.commitAll(dir, 'conflict edits shared');
    await engine.checkout(dir, 'main');
    writeFileSync(join(dir, 'shared.txt'), 'main change again\n');
    await engine.commitAll(dir, 'main edits shared again');

    await assert.rejects(engine.merge(dir, 'conflict'), /git merge failed/);
    assert.deepEqual(await engine.status(dir), []);
  } finally {
    cleanup();
  }
});

test('push publishes a branch to a remote', async () => {
  const { dir, cleanup } = workspace();
  const remote = workspace();
  try {
    const engine = new GitEngine();
    const bare = await engine.run(remote.dir, ['init', '--bare']);
    assert.equal(bare.exitCode, 0);

    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');
    await engine.run(dir, ['remote', 'add', 'origin', remote.dir]);

    const pushed = await engine.push(dir, { setUpstream: true });
    assert.equal(pushed.exitCode, 0);

    const remoteLog = await engine.run(remote.dir, ['log', '--oneline', 'main']);
    assert.equal(remoteLog.exitCode, 0);
    assert.match(remoteLog.stdout, /base/);

    await assert.rejects(engine.push(dir, { remote: 'does-not-exist' }), /git push failed/);
  } finally {
    cleanup();
    remote.cleanup();
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

test('branch, checkout, merge and push tools work through the tool contract', async () => {
  const { dir, cleanup } = workspace();
  const remote = workspace();
  try {
    const engine = new GitEngine();
    const [, , , , branchList, branchCreate, checkout, merge, push] = createGitTools(engine);
    const ctx = { workspaceRoot: dir };

    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');

    await branchCreate!.execute({ name: 'feature' }, ctx);
    await checkout!.execute({ name: 'feature' }, ctx);
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    await engine.commitAll(dir, 'feature work');

    const branches = (await branchList!.execute({}, ctx)) as { branches: Array<{ name: string; current: boolean }> };
    assert.deepEqual(
      branches.branches.map((b) => b.name).sort(),
      ['feature', 'main'],
    );

    await checkout!.execute({ name: 'main' }, ctx);
    const merged = (await merge!.execute({ branch: 'feature' }, ctx)) as { sha: string; fastForward: boolean };
    assert.ok(merged.sha);

    await engine.run(remote.dir, ['init', '--bare']);
    await engine.run(dir, ['remote', 'add', 'origin', remote.dir]);
    const pushed = (await push!.execute({ setUpstream: true }, ctx)) as { exitCode: number };
    assert.equal(pushed.exitCode, 0);
  } finally {
    cleanup();
    remote.cleanup();
  }
});
