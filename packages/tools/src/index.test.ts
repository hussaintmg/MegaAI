import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MegaError } from '@megaai/types';
import type { ToolContext } from '@megaai/contracts';
import { createPipelineTool, createShellTool, createHttpTool, createToolRegistry, fsReadTool, fsWriteTool, resolveInWorkspace } from './index.js';

function makeWorkspace(): { ctx: ToolContext; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'megaai-ws-'));
  return { ctx: { workspaceRoot: dir }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('sandbox blocks escapes and absolute paths outside the root', () => {
  const { ctx, cleanup } = makeWorkspace();
  try {
    assert.throws(() => resolveInWorkspace(ctx.workspaceRoot, '../outside.txt'), MegaError);
    assert.throws(() => resolveInWorkspace(ctx.workspaceRoot, '../../etc/passwd'), MegaError);
    assert.throws(() => resolveInWorkspace(ctx.workspaceRoot, '/etc/passwd'), MegaError);
    assert.ok(resolveInWorkspace(ctx.workspaceRoot, 'src/deep/file.txt').startsWith(ctx.workspaceRoot));
  } finally {
    cleanup();
  }
});

test('fs.write + fs.read round-trip inside the workspace', async () => {
  const { ctx, cleanup } = makeWorkspace();
  try {
    await fsWriteTool.execute({ path: 'src/hello.txt', content: 'salaam' }, ctx);
    const result = (await fsReadTool.execute({ path: 'src/hello.txt' }, ctx)) as { content: string };
    assert.equal(result.content, 'salaam');
    await assert.rejects(
      fsWriteTool.execute({ path: '../escape.txt', content: 'nope' }, ctx),
      /escapes the workspace/,
    );
  } finally {
    cleanup();
  }
});

test('shell tool is deny-by-default and allowlisted when enabled', async () => {
  const { ctx, cleanup } = makeWorkspace();
  try {
    const disabled = createShellTool({ enabled: false, allowlist: ['node'] });
    await assert.rejects(disabled.execute({ command: 'node', args: ['-v'] }, ctx), /disabled/);

    const enabled = createShellTool({ enabled: true, allowlist: ['node'] });
    await assert.rejects(enabled.execute({ command: 'rm', args: ['-rf', '/'] }, ctx), /not on the shell allowlist/);
    const versionResult = (await enabled.execute({ command: 'node', args: ['--version'] }, ctx)) as {
      exitCode: number;
      stdout: string;
    };
    assert.equal(versionResult.exitCode, 0);
    assert.match(versionResult.stdout, /^v\d+/);
  } finally {
    cleanup();
  }
});

test('http tool refuses hosts off the allowlist', async () => {
  const http = createHttpTool({ allowedHosts: ['example.com'] });
  await assert.rejects(http.execute({ url: 'https://evil.test/steal' }, { workspaceRoot: '/tmp' }), /allowlist/);
});

test('pipeline runs ordered steps and fails fast on a broken step', async () => {
  const { ctx, cleanup } = makeWorkspace();
  try {
    const pipeline = createPipelineTool({ enabled: true, allowlist: ['node'] });

    const ok = (await pipeline.execute(
      { steps: [{ name: 'version', command: 'node', args: ['--version'] }] },
      ctx,
    )) as { ok: boolean; steps: unknown[] };
    assert.equal(ok.ok, true);
    assert.equal(ok.steps.length, 1);

    // Second step fails → whole pipeline throws, and the good first step is
    // reported in the error details.
    await assert.rejects(
      pipeline.execute(
        {
          steps: [
            { name: 'good', command: 'node', args: ['--version'] },
            { name: 'bad', command: 'node', args: ['-e', 'process.exit(3)'] },
            { name: 'never', command: 'node', args: ['--version'] },
          ],
        },
        ctx,
      ),
      (err: unknown) => {
        assert.match(String(err), /pipeline step "bad" failed/);
        return true;
      },
    );

    // Non-allowlisted binaries are refused.
    await assert.rejects(
      pipeline.execute({ steps: [{ command: 'rm', args: ['-rf', '/'] }] }, ctx),
      /not on the shell allowlist/,
    );
  } finally {
    cleanup();
  }
});

test('registry exposes specs and prompt catalog filtered by allowlist', () => {
  const registry = createToolRegistry();
  assert.ok(registry.get('fs.write'));
  assert.ok(registry.specs().length >= 6);
  const catalog = registry.describeForPrompt(['fs.write']);
  assert.match(catalog, /fs\.write/);
  assert.doesNotMatch(catalog, /shell\.exec/);
});
