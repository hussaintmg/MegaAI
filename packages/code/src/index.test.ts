import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGitTools, GitEngine } from './index.js';

const execFileAsync = promisify(execFile);

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

test('branch create/list/checkout track the workspace repository', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'a.txt'), 'base\n');
    await engine.commitAll(dir, 'base');
    assert.equal(await engine.currentBranch(dir), 'main');

    await engine.createBranch(dir, 'feature');
    assert.equal(await engine.currentBranch(dir), 'feature');

    const branches = await engine.listBranches(dir);
    assert.deepEqual(
      branches.map((b) => b.name).sort(),
      ['feature', 'main'],
    );
    assert.equal(branches.find((b) => b.name === 'feature')?.current, true);

    await engine.checkout(dir, 'main');
    assert.equal(await engine.currentBranch(dir), 'main');
  } finally {
    cleanup();
  }
});

test('merge integrates a clean branch and reports (without throwing on) conflicts', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'a.txt'), 'base\n');
    await engine.commitAll(dir, 'base');

    await engine.createBranch(dir, 'feature');
    writeFileSync(join(dir, 'b.txt'), 'from feature\n');
    await engine.commitAll(dir, 'add b');
    await engine.checkout(dir, 'main');

    const clean = await engine.merge(dir, 'feature');
    assert.equal(clean.merged, true);
    assert.equal(clean.conflict, false);
    assert.ok(clean.sha);
    const messages = (await engine.log(dir)).map((c) => c.message);
    assert.equal(messages[0], "Merge branch 'feature'");
    assert.deepEqual(new Set(messages), new Set(["Merge branch 'feature'", 'add b', 'base']));

    // Now force an actual conflict on the same file from both sides.
    writeFileSync(join(dir, 'a.txt'), 'main change\n');
    await engine.commitAll(dir, 'change a on main');
    await engine.createBranch(dir, 'conflicting', { from: 'main' });
    writeFileSync(join(dir, 'a.txt'), 'main change\nconflicting change\n');
    await engine.commitAll(dir, 'conflict setup');
    await engine.checkout(dir, 'main');
    writeFileSync(join(dir, 'a.txt'), 'main change\ndiverging change\n');
    await engine.commitAll(dir, 'diverge on main');

    const conflicted = await engine.merge(dir, 'conflicting');
    assert.equal(conflicted.merged, false);
    assert.equal(conflicted.conflict, true);

    await engine.abortMerge(dir);
    assert.deepEqual(await engine.status(dir), []);
  } finally {
    cleanup();
  }
});

test('push reaches a real local "remote" and never throws on failure', async () => {
  const remote = workspace();
  const dir = workspace();
  try {
    await execFileAsync('git', ['init', '--bare', remote.dir]);
    const engine = new GitEngine();
    writeFileSync(join(dir.dir, 'a.txt'), 'base\n');
    await engine.commitAll(dir.dir, 'base');
    await engine.addRemote(dir.dir, 'origin', remote.dir);

    const ok = await engine.push(dir.dir, 'origin', 'main', { setUpstream: true });
    assert.equal(ok.exitCode, 0);

    const missing = await engine.push(dir.dir, 'origin', 'no-such-branch');
    assert.notEqual(missing.exitCode, 0);
  } finally {
    remote.cleanup();
    dir.cleanup();
  }
});

test('git tools honour dryRun and gate git.push behind its own permission', async () => {
  const { dir, cleanup } = workspace();
  try {
    const tools = createGitTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    writeFileSync(join(dir, 'a.txt'), 'base\n');
    await byName['git.commit']!.execute({ message: 'base' }, { workspaceRoot: dir });

    const dryCreate = await byName['git.branch.create']!.execute(
      { name: 'feature' },
      { workspaceRoot: dir, dryRun: true },
    );
    assert.deepEqual(dryCreate, { wouldCreate: 'feature', from: null });
    assert.deepEqual(await new GitEngine().listBranches(dir), [{ name: 'main', current: true }]);

    const dryPush = await byName['git.push']!.execute({}, { workspaceRoot: dir, dryRun: true });
    assert.deepEqual(dryPush, { wouldPush: true, remote: 'origin', branch: 'main' });

    assert.deepEqual(byName['git.push']!.permissions, ['git.push']);
    assert.deepEqual(byName['git.branch.create']!.permissions, ['git.write']);
  } finally {
    cleanup();
  }
});
