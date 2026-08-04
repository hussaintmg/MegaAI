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

test('branch, checkout and merge a local branch', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'a.txt'), 'base\n');
    await engine.commitAll(dir, 'base');
    assert.equal(await engine.currentBranch(dir), 'main');

    await engine.createBranch(dir, 'feature');
    assert.equal(await engine.currentBranch(dir), 'feature');
    assert.deepEqual((await engine.listBranches(dir)).sort(), ['feature', 'main']);

    writeFileSync(join(dir, 'b.txt'), 'feature work\n');
    await engine.commitAll(dir, 'feature work');

    await engine.checkout(dir, 'main');
    assert.equal(await engine.currentBranch(dir), 'main');

    const merged = await engine.merge(dir, 'feature');
    assert.equal(merged.merged, true);
    assert.ok(merged.sha);
    const log = await engine.log(dir);
    assert.deepEqual(
      log.map((entry) => entry.message).sort(),
      ["Merge branch 'feature'", 'base', 'feature work'].sort(),
    );
  } finally {
    cleanup();
  }
});

test('merge reports conflicts instead of throwing and leaves a clean state', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'x.txt'), 'main v1\n');
    await engine.commitAll(dir, 'base');

    await engine.createBranch(dir, 'feature');
    writeFileSync(join(dir, 'x.txt'), 'feature change\n');
    await engine.commitAll(dir, 'feature change');

    await engine.checkout(dir, 'main');
    writeFileSync(join(dir, 'x.txt'), 'main change\n');
    await engine.commitAll(dir, 'main change');

    const result = await engine.merge(dir, 'feature');
    assert.equal(result.merged, false);
    assert.equal(result.conflict, true);
    assert.deepEqual(await engine.status(dir), []);
  } finally {
    cleanup();
  }
});

test('addRemote and push publish to a local bare remote', async () => {
  const { dir: remoteDir, cleanup: cleanupRemote } = workspace();
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    await engine.run(remoteDir, ['init', '--bare']);

    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'first');
    await engine.addRemote(dir, 'origin', remoteDir);

    const pushed = await engine.push(dir, { setUpstream: true });
    assert.equal(pushed.pushed, true);
    assert.equal(pushed.remote, 'origin');
    assert.equal(pushed.branch, 'main');

    const remoteLog = await engine.run(remoteDir, ['log', '--all', '--pretty=%s']);
    assert.match(remoteLog.stdout, /first/);
  } finally {
    cleanup();
    cleanupRemote();
  }
});

test('push is rejected when the remote host is not on the allowlist', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine({ remoteAllowlist: ['github.com'] });
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'first');
    await engine.addRemote(dir, 'origin', 'https://gitlab.com/example/repo.git');

    await assert.rejects(engine.push(dir), /not on the git remote allowlist/);
  } finally {
    cleanup();
  }
});

test('git tools expose branch, merge, remote and push', async () => {
  const { dir: remoteDir, cleanup: cleanupRemote } = workspace();
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    await engine.run(remoteDir, ['init', '--bare']);
    const [, , , , branchList, branchCreate, checkout, merge, remoteAdd, push] = createGitTools(engine);

    writeFileSync(join(dir, 'a.txt'), 'base\n');
    await engine.commitAll(dir, 'base');

    await branchCreate!.execute({ name: 'feature' }, { workspaceRoot: dir });
    writeFileSync(join(dir, 'b.txt'), 'feature\n');
    await engine.commitAll(dir, 'feature work');

    const listed = (await branchList!.execute({}, { workspaceRoot: dir })) as { branches: string[]; current: string };
    assert.equal(listed.current, 'feature');
    assert.ok(listed.branches.includes('main'));

    await checkout!.execute({ branch: 'main' }, { workspaceRoot: dir });
    const merged = (await merge!.execute({ branch: 'feature' }, { workspaceRoot: dir })) as { merged: boolean };
    assert.equal(merged.merged, true);

    await remoteAdd!.execute({ name: 'origin', url: remoteDir }, { workspaceRoot: dir });
    const pushed = (await push!.execute({ setUpstream: true }, { workspaceRoot: dir })) as { pushed: boolean };
    assert.equal(pushed.pushed, true);
  } finally {
    cleanup();
    cleanupRemote();
  }
});
