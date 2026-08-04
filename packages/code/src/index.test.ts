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

test('createBranch, checkoutBranch and listBranches manage local branches', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');

    await engine.createBranch(dir, 'feature', { checkout: true });
    assert.equal(await engine.currentBranch(dir), 'feature');

    writeFileSync(join(dir, 'b.txt'), 'two\n');
    await engine.commitAll(dir, 'feature work');

    const branches = await engine.listBranches(dir);
    assert.deepEqual(
      branches.map((b) => b.name).sort(),
      ['feature', 'main'].sort(),
    );
    assert.ok(branches.find((b) => b.name === 'feature')?.current);

    await engine.checkoutBranch(dir, 'main');
    assert.equal(await engine.currentBranch(dir), 'main');
  } finally {
    cleanup();
  }
});

test('merge fast-forwards clean changes and reports conflicts without throwing', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');
    await engine.createBranch(dir, 'feature', { checkout: true });
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    await engine.commitAll(dir, 'feature work');
    await engine.checkoutBranch(dir, 'main');

    const clean = await engine.merge(dir, 'feature');
    assert.equal(clean.merged, true);
    assert.equal(clean.conflict, false);
    assert.ok(clean.sha);

    // Force a real conflict: diverging edits to the same line on both branches.
    await engine.createBranch(dir, 'conflict-a', { checkout: true });
    writeFileSync(join(dir, 'a.txt'), 'branch-a change\n');
    await engine.commitAll(dir, 'change on conflict-a');
    await engine.checkoutBranch(dir, 'main');
    await engine.createBranch(dir, 'conflict-b', { checkout: true });
    writeFileSync(join(dir, 'a.txt'), 'branch-b change\n');
    await engine.commitAll(dir, 'change on conflict-b');

    const conflict = await engine.merge(dir, 'conflict-a');
    assert.equal(conflict.merged, false);
    assert.equal(conflict.conflict, true);
  } finally {
    cleanup();
  }
});

test('push sends commits to a local bare remote', async () => {
  const { dir: remoteDir, cleanup: cleanupRemote } = workspace();
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    const initRemote = await engine.run(remoteDir, ['init', '--bare', '--initial-branch=main']);
    if (initRemote.exitCode !== 0) await engine.run(remoteDir, ['init', '--bare']);

    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');
    await engine.addRemote(dir, 'origin', remoteDir);

    const result = await engine.push(dir, { remote: 'origin', setUpstream: true });
    assert.equal(result.exitCode, 0);

    const remoteLog = await engine.run(remoteDir, ['log', '--pretty=%s']);
    assert.match(remoteLog.stdout, /base/);
  } finally {
    cleanup();
    cleanupRemote();
  }
});

test('git.branch, git.merge and git.push tools work through the tool contract', async () => {
  const { dir: remoteDir, cleanup: cleanupRemote } = workspace();
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    await engine.run(remoteDir, ['init', '--bare']);

    const [, , , , branch, checkout, branches, merge, push] = createGitTools(engine);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');

    const created = (await branch!.execute({ name: 'feature' }, { workspaceRoot: dir })) as {
      created: string;
      checkedOut: boolean;
    };
    assert.equal(created.created, 'feature');
    assert.equal(created.checkedOut, true);

    writeFileSync(join(dir, 'b.txt'), 'two\n');
    await engine.commitAll(dir, 'feature work');
    await checkout!.execute({ name: 'main' }, { workspaceRoot: dir });

    const listed = (await branches!.execute({}, { workspaceRoot: dir })) as {
      branches: Array<{ name: string }>;
    };
    assert.ok(listed.branches.some((b) => b.name === 'feature'));

    const merged = (await merge!.execute({ branch: 'feature' }, { workspaceRoot: dir })) as {
      merged: boolean;
      conflict: boolean;
    };
    assert.equal(merged.merged, true);
    assert.equal(merged.conflict, false);

    await engine.addRemote(dir, 'origin', remoteDir);
    const pushed = (await push!.execute({ setUpstream: true }, { workspaceRoot: dir })) as {
      pushed: boolean;
      remote: string;
    };
    assert.equal(pushed.pushed, true);
    assert.equal(pushed.remote, 'origin');
  } finally {
    cleanup();
    cleanupRemote();
  }
});

test('git tools are named and permissioned as expected', () => {
  const tools = createGitTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(byName['git.push']?.permissions, ['git.push']);
  assert.deepEqual(byName['git.branch']?.permissions, ['git.write']);
  assert.deepEqual(byName['git.merge']?.permissions, ['git.write']);
  assert.deepEqual(byName['git.branches']?.permissions, ['git.read']);
});
