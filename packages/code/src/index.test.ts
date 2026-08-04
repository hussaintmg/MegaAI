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

    await engine.createBranch(dir, 'feature/one');
    let branches = await engine.listBranches(dir);
    assert.deepEqual(
      branches.map((b) => b.name).sort(),
      ['feature/one', 'main'].sort(),
    );
    assert.equal(branches.find((b) => b.name === 'feature/one')?.current, false);

    await engine.checkout(dir, 'feature/one');
    assert.equal(await engine.currentBranch(dir), 'feature/one');

    await engine.checkout(dir, 'feature/two', { create: true });
    branches = await engine.listBranches(dir);
    assert.equal(branches.find((b) => b.name === 'feature/two')?.current, true);
  } finally {
    cleanup();
  }
});

test('branch/checkout reject option-injection ref names', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');
    await assert.rejects(engine.createBranch(dir, '--upload-pack=/bin/sh'), /Invalid branch name/);
    await assert.rejects(engine.checkout(dir, '-x'), /Invalid branch name/);
  } finally {
    cleanup();
  }
});

test('merge: fast-forward succeeds, conflicting merge aborts cleanly', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');
    await engine.checkout(dir, 'feature', { create: true });
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    await engine.commitAll(dir, 'feature work');
    await engine.checkout(dir, 'main');

    const clean = await engine.merge(dir, 'feature');
    assert.equal(clean.merged, true);
    assert.equal(clean.conflict, false);
    assert.deepEqual(await engine.status(dir), []);

    // Now create a genuine conflict.
    await engine.checkout(dir, 'conflict-a', { create: true });
    writeFileSync(join(dir, 'a.txt'), 'from a\n');
    await engine.commitAll(dir, 'a change');
    await engine.checkout(dir, 'main');
    await engine.checkout(dir, 'conflict-b', { create: true });
    writeFileSync(join(dir, 'a.txt'), 'from b\n');
    await engine.commitAll(dir, 'b change');

    const conflicted = await engine.merge(dir, 'conflict-a');
    assert.equal(conflicted.merged, false);
    assert.equal(conflicted.conflict, true);
    // Workspace left clean — merge --abort ran.
    assert.deepEqual(await engine.status(dir), []);
  } finally {
    cleanup();
  }
});

test('remotes: add, list, and reject unsafe URLs', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    await engine.remoteAdd(dir, 'origin', '/tmp/some/bare/repo.git');
    assert.deepEqual(await engine.listRemotes(dir), [{ name: 'origin', url: '/tmp/some/bare/repo.git' }]);

    await assert.rejects(engine.remoteAdd(dir, 'evil', 'ext::sh -c touch /tmp/pwned'), /ext:: or fd::/);
    await assert.rejects(engine.remoteAdd(dir, '-x', 'https://example.com/x.git'), /Invalid remote name/);
    await assert.rejects(engine.remoteAdd(dir, 'origin2', '-x'), /Invalid remote URL/);
  } finally {
    cleanup();
  }
});

test('push: publishes a branch to a local bare remote', async () => {
  const { dir, cleanup } = workspace();
  const bare = workspace();
  try {
    const engine = new GitEngine();
    await engine.run(bare.dir, ['init', '--bare']);

    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await engine.commitAll(dir, 'base');
    await engine.remoteAdd(dir, 'origin', bare.dir);

    const result = await engine.push(dir, 'origin', 'main', { setUpstream: true });
    assert.equal(result.exitCode, 0);

    const remoteLog = await engine.run(bare.dir, ['log', '--pretty=%s', 'main']);
    assert.match(remoteLog.stdout, /base/);
  } finally {
    cleanup();
    bare.cleanup();
  }
});

test('git collaboration tools work through the tool contract', async () => {
  const { dir, cleanup } = workspace();
  const bare = workspace();
  try {
    const tools = createGitTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const ctx = { workspaceRoot: dir };

    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await byName['git.commit']!.execute({ message: 'base' }, ctx);

    await byName['git.branch.create']!.execute({ name: 'feature' }, ctx);
    const list = (await byName['git.branch.list']!.execute({}, ctx)) as {
      branches: Array<{ name: string; current: boolean }>;
    };
    assert.ok(list.branches.some((b) => b.name === 'feature'));

    await byName['git.checkout']!.execute({ branch: 'feature' }, ctx);
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    await byName['git.commit']!.execute({ message: 'feature work' }, ctx);
    await byName['git.checkout']!.execute({ branch: 'main' }, ctx);

    const merged = (await byName['git.merge']!.execute({ branch: 'feature' }, ctx)) as { merged: boolean };
    assert.equal(merged.merged, true);

    const engine = new GitEngine();
    await engine.run(bare.dir, ['init', '--bare']);
    await byName['git.remote.add']!.execute({ name: 'origin', url: bare.dir }, ctx);
    const remotes = (await byName['git.remote.list']!.execute({}, ctx)) as {
      remotes: Array<{ name: string; url: string }>;
    };
    assert.deepEqual(remotes.remotes, [{ name: 'origin', url: bare.dir }]);

    const pushed = (await byName['git.push']!.execute({ setUpstream: true }, ctx)) as {
      pushed: boolean;
      remote: string;
      branch: string;
    };
    assert.equal(pushed.pushed, true);
    assert.equal(pushed.remote, 'origin');
    assert.equal(pushed.branch, 'main');
  } finally {
    cleanup();
    bare.cleanup();
  }
});
