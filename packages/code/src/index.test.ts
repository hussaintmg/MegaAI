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
    writeFileSync(join(dir, 'a.txt'), 'base\n');
    await engine.commitAll(dir, 'base');
    const main = await engine.currentBranch(dir);

    await engine.createBranch(dir, 'feature');
    assert.equal(await engine.currentBranch(dir), 'feature');
    writeFileSync(join(dir, 'b.txt'), 'feature work\n');
    await engine.commitAll(dir, 'feature work');
    assert.deepEqual((await engine.listBranches(dir)).sort(), [main, 'feature'].sort());

    await engine.checkout(dir, main!);
    assert.equal(await engine.currentBranch(dir), main);
    const result = await engine.merge(dir, 'feature');
    assert.deepEqual(result, { merged: true, conflicts: [] });
    assert.deepEqual(
      (await engine.log(dir)).map((entry) => entry.message),
      ['feature work', 'base'],
    );
  } finally {
    cleanup();
  }
});

test('merge surfaces conflicts instead of leaving a half-merge', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'x.txt'), 'base\n');
    await engine.commitAll(dir, 'base');
    const main = await engine.currentBranch(dir);

    await engine.createBranch(dir, 'feature');
    writeFileSync(join(dir, 'x.txt'), 'feature change\n');
    await engine.commitAll(dir, 'feature change');

    await engine.checkout(dir, main!);
    writeFileSync(join(dir, 'x.txt'), 'main change\n');
    await engine.commitAll(dir, 'main change');

    const result = await engine.merge(dir, 'feature');
    assert.equal(result.merged, false);
    assert.deepEqual(result.conflicts, ['x.txt']);
    assert.deepEqual(await engine.status(dir), []); // merge --abort leaves a clean tree
  } finally {
    cleanup();
  }
});

test('push requires a remote and reports the underlying failure', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'a.txt'), 'base\n');
    await engine.commitAll(dir, 'base');
    await assert.rejects(engine.push(dir), /git push failed/);
  } finally {
    cleanup();
  }
});

test('git.branch, git.checkout, git.merge and git.push tools work through the tool contract', async () => {
  const { dir, cleanup } = workspace();
  try {
    const [commit, , , , branch, checkout, merge, push] = createGitTools();
    writeFileSync(join(dir, 'a.txt'), 'base\n');
    await commit!.execute({ message: 'base' }, { workspaceRoot: dir });
    const engine = new GitEngine();
    const main = await engine.currentBranch(dir);

    const created = (await branch!.execute({ name: 'feature' }, { workspaceRoot: dir })) as { created: string };
    assert.equal(created.created, 'feature');
    writeFileSync(join(dir, 'b.txt'), 'feature\n');
    await commit!.execute({ message: 'feature work' }, { workspaceRoot: dir });

    const listed = (await branch!.execute({}, { workspaceRoot: dir })) as { branches: string[] };
    assert.deepEqual(listed.branches.sort(), [main, 'feature'].sort());

    await checkout!.execute({ name: main! }, { workspaceRoot: dir });
    assert.equal(await engine.currentBranch(dir), main);

    const merged = (await merge!.execute({ from: 'feature' }, { workspaceRoot: dir })) as {
      merged: boolean;
      conflicts: string[];
    };
    assert.deepEqual(merged, { merged: true, conflicts: [] });

    assert.equal(push!.permissions[0], 'git.push');
    await assert.rejects(push!.execute({}, { workspaceRoot: dir }), /git push failed/);
  } finally {
    cleanup();
  }
});
