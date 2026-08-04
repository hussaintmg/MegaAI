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

test('branch, checkout and merge collaborate cleanly', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'base.txt'), 'base\n');
    await engine.commitAll(dir, 'base');
    assert.equal(await engine.currentBranch(dir), 'main');

    await engine.createBranch(dir, 'feature');
    assert.deepEqual(
      (await engine.listBranches(dir)).map((b) => b.name).sort(),
      ['feature', 'main'],
    );

    await engine.checkout(dir, 'feature');
    assert.equal(await engine.currentBranch(dir), 'feature');
    writeFileSync(join(dir, 'feature.txt'), 'feature\n');
    await engine.commitAll(dir, 'feature work');

    await engine.checkout(dir, 'main');
    const result = await engine.merge(dir, 'feature', { message: 'merge feature' });
    assert.equal(result.merged, true);
    assert.deepEqual(result.conflicted, []);
    const messages = (await engine.log(dir)).map((c) => c.message);
    assert.equal(messages[0], 'merge feature');
    assert.deepEqual(new Set(messages), new Set(['merge feature', 'feature work', 'base']));
  } finally {
    cleanup();
  }
});

test('merge reports and cleans up conflicts instead of leaving one in progress', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'x.txt'), 'base\n');
    await engine.commitAll(dir, 'base');
    await engine.createBranch(dir, 'feature');

    writeFileSync(join(dir, 'x.txt'), 'main change\n');
    await engine.commitAll(dir, 'main change');

    await engine.checkout(dir, 'feature');
    writeFileSync(join(dir, 'x.txt'), 'feature change\n');
    await engine.commitAll(dir, 'feature change');
    await engine.checkout(dir, 'main');

    const result = await engine.merge(dir, 'feature');
    assert.equal(result.merged, false);
    assert.deepEqual(result.conflicted, ['x.txt']);
    // Merge was aborted — workspace is clean, not stuck mid-merge.
    assert.deepEqual(await engine.status(dir), []);
  } finally {
    cleanup();
  }
});

test('push refuses non-origin remotes and unsafe ref names', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');

    await assert.rejects(engine.push(dir, 'main', { remote: 'not-origin' }), /origin/);
    await assert.rejects(engine.createBranch(dir, '--evil'), /Invalid branch name/);
    await assert.rejects(engine.checkout(dir, '-x'), /Invalid branch name/);
  } finally {
    cleanup();
  }
});

test('git.branch, git.checkout and git.merge tools work through the tool contract', async () => {
  const { dir, cleanup } = workspace();
  try {
    const [, , , , branchTool, checkoutTool, mergeTool] = createGitTools();
    writeFileSync(join(dir, 'base.txt'), 'base\n');
    const engine = new GitEngine();
    await engine.commitAll(dir, 'base');

    await branchTool!.execute({ name: 'feature' }, { workspaceRoot: dir });
    const listed = (await branchTool!.execute({}, { workspaceRoot: dir })) as {
      branches: Array<{ name: string }>;
    };
    assert.ok(listed.branches.some((b) => b.name === 'feature'));

    await checkoutTool!.execute({ branch: 'feature' }, { workspaceRoot: dir });
    assert.equal(await engine.currentBranch(dir), 'feature');
    writeFileSync(join(dir, 'feature.txt'), 'feature\n');
    await engine.commitAll(dir, 'feature work');

    await checkoutTool!.execute({ branch: 'main' }, { workspaceRoot: dir });
    const merged = (await mergeTool!.execute({ branch: 'feature' }, { workspaceRoot: dir })) as {
      merged: boolean;
    };
    assert.equal(merged.merged, true);
  } finally {
    cleanup();
  }
});
