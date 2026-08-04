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

test('branches, checkout and merge collaborate cleanly', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'base.txt'), 'base\n');
    await engine.commitAll(dir, 'base');

    await engine.createBranch(dir, 'feature', { checkout: true });
    assert.equal(await engine.currentBranch(dir), 'feature');
    const branches = await engine.branches(dir);
    assert.ok(branches.some((b) => b.name === 'feature' && b.current));
    assert.ok(branches.some((b) => b.name === 'main' || b.name === 'master'));

    writeFileSync(join(dir, 'feature.txt'), 'new\n');
    await engine.commitAll(dir, 'feature work');

    const main = branches.find((b) => b.name !== 'feature')!.name;
    await engine.checkout(dir, main);
    assert.equal(await engine.currentBranch(dir), main);

    const result = await engine.merge(dir, 'feature');
    assert.deepEqual(result, { merged: true, conflict: false, message: result.message });
    assert.ok(existsSync(join(dir, 'feature.txt')));
  } finally {
    cleanup();
  }
});

test('merge aborts cleanly on conflict', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'x.txt'), 'base\n');
    await engine.commitAll(dir, 'base');
    const main = (await engine.currentBranch(dir))!;

    await engine.createBranch(dir, 'feature', { checkout: true });
    writeFileSync(join(dir, 'x.txt'), 'feature change\n');
    await engine.commitAll(dir, 'feature edit');

    await engine.checkout(dir, main);
    writeFileSync(join(dir, 'x.txt'), 'main change\n');
    await engine.commitAll(dir, 'main edit');

    const result = await engine.merge(dir, 'feature');
    assert.equal(result.merged, false);
    assert.equal(result.conflict, true);
    assert.deepEqual(await engine.status(dir), []);
  } finally {
    cleanup();
  }
});

test('push publishes commits to a remote', async () => {
  const { dir, cleanup } = workspace();
  const { dir: remoteDir, cleanup: cleanupRemote } = workspace();
  try {
    const engine = new GitEngine();
    const bare = await engine.run(remoteDir, ['init', '--bare']);
    assert.equal(bare.exitCode, 0);

    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'first delivery');
    const branchName = (await engine.currentBranch(dir))!;

    await engine.addRemote(dir, 'origin', remoteDir);
    const result = await engine.push(dir, 'origin', branchName, { setUpstream: true });
    assert.equal(result.exitCode, 0);

    const remoteLog = await engine.run(remoteDir, ['log', '--all', '--pretty=%s']);
    assert.match(remoteLog.stdout, /first delivery/);
  } finally {
    cleanup();
    cleanupRemote();
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

test('git branch/checkout/merge/push tools work through the tool contract', async () => {
  const { dir, cleanup } = workspace();
  const { dir: remoteDir, cleanup: cleanupRemote } = workspace();
  try {
    const tools = createGitTools();
    const byName = (name: string) => tools.find((t) => t.name === name)!;
    const commit = byName('git.commit');
    const branchTool = byName('git.branch');
    const checkoutTool = byName('git.checkout');
    const mergeTool = byName('git.merge');
    const branchesTool = byName('git.branches');
    const remoteAddTool = byName('git.remote.add');
    const pushTool = byName('git.push');

    const engine = new GitEngine();
    await engine.run(remoteDir, ['init', '--bare']);

    writeFileSync(join(dir, 'base.txt'), 'base\n');
    await commit.execute({ message: 'base' }, { workspaceRoot: dir });
    const main = (await engine.currentBranch(dir))!;

    const created = (await branchTool.execute({ name: 'feature', checkout: true }, { workspaceRoot: dir })) as {
      created: boolean;
    };
    assert.equal(created.created, true);

    writeFileSync(join(dir, 'feature.txt'), 'new\n');
    await commit.execute({ message: 'feature work' }, { workspaceRoot: dir });

    await checkoutTool.execute({ name: main }, { workspaceRoot: dir });
    const merged = (await mergeTool.execute({ branch: 'feature' }, { workspaceRoot: dir })) as {
      merged: boolean;
      conflict: boolean;
    };
    assert.equal(merged.merged, true);
    assert.equal(merged.conflict, false);

    const branchList = (await branchesTool.execute({}, { workspaceRoot: dir })) as {
      branches: Array<{ name: string }>;
    };
    assert.ok(branchList.branches.some((b) => b.name === 'feature'));

    await remoteAddTool.execute({ name: 'origin', url: remoteDir }, { workspaceRoot: dir });
    const pushed = (await pushTool.execute(
      { remote: 'origin', setUpstream: true },
      { workspaceRoot: dir },
    )) as { pushed: boolean; remote: string };
    assert.equal(pushed.pushed, true);
    assert.equal(pushed.remote, 'origin');

    const remoteLog = await engine.run(remoteDir, ['log', '--all', '--pretty=%s']);
    assert.match(remoteLog.stdout, /feature work/);
  } finally {
    cleanup();
    cleanupRemote();
  }
});
