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
    assert.deepEqual(
      (await engine.listBranches(dir)).map((b) => b.name).sort(),
      [main, 'feature'].sort(),
    );

    await engine.checkout(dir, 'feature');
    assert.equal(await engine.currentBranch(dir), 'feature');
    writeFileSync(join(dir, 'b.txt'), 'from feature\n');
    await engine.commitAll(dir, 'feature work');

    await engine.checkout(dir, main as string);
    const merged = await engine.merge(dir, 'feature');
    assert.equal(merged.merged, true);
    assert.equal(merged.conflict, false);
    assert.ok(merged.sha);
    assert.deepEqual(
      (await engine.log(dir)).map((c) => c.message),
      ['feature work', 'base'],
    );
  } finally {
    cleanup();
  }
});

test('merge reports a conflict and leaves a clean tree instead of throwing', async () => {
  const { dir, cleanup } = workspace();
  try {
    const engine = new GitEngine();
    writeFileSync(join(dir, 'x.txt'), 'base\n');
    await engine.commitAll(dir, 'base');
    const main = await engine.currentBranch(dir);

    await engine.checkout(dir, 'feature', { create: true });
    writeFileSync(join(dir, 'x.txt'), 'from feature\n');
    await engine.commitAll(dir, 'feature edit');

    await engine.checkout(dir, main as string);
    writeFileSync(join(dir, 'x.txt'), 'from main\n');
    await engine.commitAll(dir, 'main edit');

    const result = await engine.merge(dir, 'feature');
    assert.equal(result.merged, false);
    assert.equal(result.conflict, true);
    assert.deepEqual(await engine.status(dir), []);
  } finally {
    cleanup();
  }
});

test('push is rejected when the remote is not on the allowlist, and succeeds once allowlisted', async () => {
  const { dir: work, cleanup: cleanupWork } = workspace();
  const { dir: bare, cleanup: cleanupBare } = workspace();
  try {
    const engine = new GitEngine();
    const initBare = await engine.run(bare, ['init', '--bare']);
    assert.equal(initBare.exitCode, 0);

    writeFileSync(join(work, 'a.txt'), 'one\n');
    await engine.commitAll(work, 'first');
    await engine.addRemote(work, 'origin', bare);
    assert.equal(await engine.remoteUrl(work, 'origin'), bare);

    const findPush = (tools: ReturnType<typeof createGitTools>) => tools.find((t) => t.name === 'git.push')!;

    const deniedPush = findPush(createGitTools(engine, { allowedRemotes: [] }));
    await assert.rejects(deniedPush.execute({}, { workspaceRoot: work }), /not on the git push allowlist/);

    const allowedPush = findPush(createGitTools(engine, { allowedRemotes: [bare] }));
    const branch = await engine.currentBranch(work);
    const result = (await allowedPush.execute({ setUpstream: true }, { workspaceRoot: work })) as {
      pushed: boolean;
    };
    assert.equal(result.pushed, true);

    const remoteLog = await engine.run(bare, ['log', '--pretty=%s', branch as string]);
    assert.match(remoteLog.stdout, /first/);
  } finally {
    cleanupWork();
    cleanupBare();
  }
});
