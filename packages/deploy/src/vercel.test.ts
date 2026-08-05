import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectDeployFiles, deployToVercel } from './vercel.js';

function workspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'megaai-vercel-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A fetch that replies from a scripted queue and records what was sent. */
function scriptedFetch(replies: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method?: string; body: unknown }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = replies.shift() ?? { status: 500, body: {} };
    return { status: next.status, json: async () => next.body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const instant = async (): Promise<void> => undefined;

test('only the delivery source is uploaded — not node_modules or the build output', () => {
  const { root, cleanup } = workspace({
    'package.json': '{"name":"site"}',
    'app/page.tsx': 'export default function P() { return null; }',
    'node_modules/next/index.js': 'vendored',
    '.next/static/chunk.js': 'built',
    '.megaai/preview/home.png': 'screenshot',
    '.git/HEAD': 'ref',
  });
  try {
    const files = collectDeployFiles(root);
    assert.deepEqual(
      files.map((f) => f.file).sort(),
      ['app/page.tsx', 'package.json'],
      'uploading node_modules would be pointless and enormous; Vercel installs them itself',
    );
    assert.equal(files[0]?.encoding, 'base64');
    assert.equal(Buffer.from(files[1]!.data, 'base64').toString(), '{"name":"site"}');
  } finally {
    cleanup();
  }
});

test('a successful deployment returns the URL only once the build is READY', async () => {
  const { impl, calls } = scriptedFetch([
    { status: 200, body: { id: 'dpl_1', url: 'car-site-abc.vercel.app', readyState: 'QUEUED', inspectorUrl: 'https://vercel.com/x/dpl_1' } },
    { status: 200, body: { readyState: 'BUILDING' } },
    { status: 200, body: { readyState: 'READY' } },
  ]);

  const result = await deployToVercel({
    token: 'tok',
    projectName: 'car-site',
    files: [{ file: 'package.json', data: 'e30=', encoding: 'base64', sha: 'x', size: 2 }],
    fetchImpl: impl,
    sleep: instant,
  });

  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://car-site-abc.vercel.app');
  assert.equal(result.inspectorUrl, 'https://vercel.com/x/dpl_1');
  assert.equal(result.readyState, 'READY');
  // It waited: reporting the URL at QUEUED would hand back a link to a build
  // that had not run yet.
  assert.equal(calls.length, 3);
  assert.match(calls[0]!.url, /\/v13\/deployments/);
  assert.equal(calls[0]!.method, 'POST');
  const sent = calls[0]!.body as { name: string; target: string; projectSettings: { framework: string } };
  assert.equal(sent.name, 'car-site');
  assert.equal(sent.target, 'production');
  assert.equal(sent.projectSettings.framework, 'nextjs');
});

test('a failed build is reported as not live, with the log to look at', async () => {
  const { impl } = scriptedFetch([
    { status: 200, body: { id: 'dpl_2', url: 'x.vercel.app', readyState: 'BUILDING', inspectorUrl: 'https://vercel.com/x/dpl_2' } },
    { status: 200, body: { readyState: 'ERROR' } },
  ]);
  const result = await deployToVercel({
    token: 'tok',
    projectName: 'x',
    files: [{ file: 'a', data: 'YQ==', encoding: 'base64', sha: 'x', size: 1 }],
    fetchImpl: impl,
    sleep: instant,
  });
  assert.equal(result.ok, false);
  assert.equal(result.readyState, 'ERROR');
  assert.match(result.error ?? '', /finished as ERROR/);
  assert.equal(result.inspectorUrl, 'https://vercel.com/x/dpl_2');
});

test('a rejected token says so, rather than failing with a bare status', async () => {
  const { impl } = scriptedFetch([
    { status: 403, body: { error: { code: 'forbidden', message: 'Not authorized' } } },
  ]);
  await assert.rejects(
    deployToVercel({
      token: 'bad',
      projectName: 'x',
      files: [{ file: 'a', data: 'YQ==', encoding: 'base64', sha: 'x', size: 1 }],
      fetchImpl: impl,
      sleep: instant,
    }),
    /forbidden: Not authorized/,
  );
});

test('deploying nothing, or without a token, is refused up front', async () => {
  await assert.rejects(deployToVercel({ token: '', projectName: 'x', files: [] }), /token is required/);
  await assert.rejects(deployToVercel({ token: 't', projectName: 'x', files: [] }), /no files to deploy/);
});

test('a build that never finishes gives up rather than hanging the run', async () => {
  const replies: Array<{ status: number; body: Record<string, unknown> }> = [
    { status: 200, body: { id: "d", url: "x.vercel.app", readyState: "QUEUED" } },
  ];
  for (let i = 0; i < 50; i += 1) replies.push({ status: 200, body: { readyState: 'BUILDING' } });
  const { impl } = scriptedFetch(replies);
  const result = await deployToVercel({
    token: 't',
    projectName: 'x',
    files: [{ file: 'a', data: 'YQ==', encoding: 'base64', sha: 'x', size: 1 }],
    fetchImpl: impl,
    sleep: instant,
    timeoutMs: 20_000,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /still BUILDING/);
});
