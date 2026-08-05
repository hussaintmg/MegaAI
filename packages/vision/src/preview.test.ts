/**
 * app.preview against a real server.
 *
 * The point of this tool is that it does not simulate: it spawns a process,
 * waits for the port, drives Chromium and kills the tree afterwards. So does
 * this test — with a hand-written Node server instead of a framework, so it
 * needs no install and stays fast.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreviewRunner } from './preview.js';
import { VisionTester } from './index.js';
import { discoverChromium } from './launch.js';

const HAS_BROWSER = Boolean(discoverChromium());
const ALLOWLIST = { enabled: true, allowlist: ['node', 'npm'] };

/** A workspace holding a tiny static server, ready to `npm run start`. */
function makeApp(body: string, extra: Record<string, string> = {}): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'megaai-preview-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tiny', scripts: { start: 'node server.mjs' } }));
  writeFileSync(
    join(dir, 'server.mjs'),
    `import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const PAGE = ${JSON.stringify(body)};
createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/' || path === '/about') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    return;
  }
  const file = join(process.cwd(), path.slice(1));
  if (existsSync(file) && !file.includes('..')) {
    res.writeHead(200, { 'content-type': 'text/css' }).end(readFileSync(file));
    return;
  }
  res.writeHead(404).end('not found');
}).listen(Number(process.env.PORT) || 3000, '127.0.0.1');
`,
  );
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(dir, name), content);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Tiny app</title>
<link rel="stylesheet" href="site.css"></head>
<body><h1>Tiny app</h1><button type="submit">Continue</button></body></html>`;

test('preview refuses a directory with nothing to run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'megaai-empty-'));
  try {
    const runner = new PreviewRunner(ALLOWLIST, new VisionTester({ preferBrowser: false }));
    await assert.rejects(runner.run({}, dir), /no package\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preview will not run a binary that is off the shell allowlist', async () => {
  const { dir, cleanup } = makeApp(PAGE);
  try {
    const runner = new PreviewRunner({ enabled: true, allowlist: ['git'] }, new VisionTester({ preferBrowser: false }));
    await assert.rejects(
      runner.run({ install: false, build: false, start: ['node', 'server.mjs'] }, dir),
      /not on the shell allowlist/,
    );
  } finally {
    cleanup();
  }
});

test('preview reports a build that fails instead of starting anyway', async () => {
  const { dir, cleanup } = makeApp(PAGE);
  try {
    const runner = new PreviewRunner(ALLOWLIST, new VisionTester({ preferBrowser: false }));
    const result = await runner.run(
      { install: false, build: ['node', '-e', 'process.exit(3)'], start: ['node', 'server.mjs'] },
      dir,
    );
    assert.equal(result.ok, false);
    assert.equal(result.note, 'build failed');
    assert.equal(result.steps.at(-1)?.exitCode, 3);
    assert.deepEqual(result.pages, [], 'nothing is inspected when the build never produced anything');
  } finally {
    cleanup();
  }
});

test('preview reports a server that never listens', async () => {
  const { dir, cleanup } = makeApp(PAGE);
  try {
    const runner = new PreviewRunner(ALLOWLIST, new VisionTester({ preferBrowser: false }));
    const result = await runner.run(
      { install: false, build: false, start: ['node', '-e', 'process.exit(1)'], port: 39411 },
      dir,
    );
    assert.equal(result.ok, false);
    assert.match(result.note ?? '', /never started listening/);
    assert.match(result.steps.at(-1)?.output ?? '', /exited before it started listening/);
  } finally {
    cleanup();
  }
});

test(
  'preview starts the real server, loads every route and photographs it',
  { skip: HAS_BROWSER ? false : 'no Chromium available' },
  async () => {
    const { dir, cleanup } = makeApp(PAGE, { 'site.css': 'body { font-family: system-ui; margin: 2rem; }' });
    try {
      const runner = new PreviewRunner(ALLOWLIST, new VisionTester({ preferBrowser: true }));
      const result = await runner.run(
        { install: false, build: false, start: ['node', 'server.mjs'], port: 39412, routes: ['/', '/about', '/missing'] },
        dir,
      );

      assert.equal(result.url, 'http://127.0.0.1:39412');
      assert.equal(result.steps.at(-1)?.name, 'start');
      assert.equal(result.pages.length, 3);

      const home = result.pages.find((page) => page.route === '/');
      assert.equal(home?.status, 200);
      assert.equal(home?.ok, true);
      assert.equal(home?.audit?.driver, 'browser', 'the page was loaded in a real browser, not parsed');
      assert.ok(home?.audit?.elements.some((el) => el.tag === 'button'), 'real geometry came back from the DOM');
      assert.ok(home?.screenshot, 'a screenshot path is reported');
      assert.ok(existsSync(join(dir, home!.screenshot!)), 'and the PNG is on disk in the workspace');

      // A route that 404s is a failure, and the whole preview fails with it.
      const missing = result.pages.find((page) => page.route === '/missing');
      assert.equal(missing?.status, 404);
      assert.equal(missing?.ok, false);
      assert.equal(result.ok, false);
      assert.match(result.note ?? '', /one or more routes failed/);
    } finally {
      cleanup();
    }
  },
);

test(
  'the audit names the asset that failed, not just "Failed to load resource"',
  { skip: HAS_BROWSER ? false : 'no Chromium available' },
  async () => {
    // site.css is referenced but never written, so the stylesheet 404s. The
    // console message Chromium emits for this carries no URL, which made the
    // old report useless; the network list has to carry the real one.
    const { dir, cleanup } = makeApp(PAGE);
    try {
      const runner = new PreviewRunner(ALLOWLIST, new VisionTester({ preferBrowser: true }));
      const result = await runner.run(
        { install: false, build: false, start: ['node', 'server.mjs'], port: 39413, routes: ['/'] },
        dir,
      );
      const audit = result.pages[0]?.audit;
      const failure = audit?.network.find((entry) => entry.url.endsWith('/site.css'));
      assert.ok(failure, `expected the missing stylesheet in network[], got ${JSON.stringify(audit?.network)}`);
      assert.equal(failure?.status, 404);
      assert.equal(failure?.severity, 'error', 'a missing stylesheet breaks the page');
      assert.deepEqual(
        audit?.console.errors.filter((line) => /^Failed to load resource/.test(line)),
        [],
        'the URL-less console twin is dropped in favour of the network entry',
      );
      assert.equal(audit?.passed, false);
    } finally {
      cleanup();
    }
  },
);

test(
  'the trained models get a look at the rendered pixels',
  { skip: HAS_BROWSER ? false : 'no Chromium available' },
  async () => {
    const { dir, cleanup } = makeApp(PAGE, { 'site.css': 'body { margin: 2rem; }' });
    try {
      const seen: number[] = [];
      const tester = new VisionTester({
        preferBrowser: true,
        inspector: async (png) => {
          seen.push(png.length);
          return { screenKind: 'article', screenConfidence: 0.91, defect: 'overflow', defectConfidence: 0.83 };
        },
      });
      const result = await new PreviewRunner(ALLOWLIST, tester).run(
        { install: false, build: false, start: ['node', 'server.mjs'], port: 39414, routes: ['/'] },
        dir,
      );
      const audit = result.pages[0]?.audit;
      assert.ok(seen[0] && seen[0] > 1000, 'the inspector received a real PNG');
      assert.equal(audit?.visual?.screenKind, 'article');
      // A confident defect becomes a reported issue, not just a field nobody reads.
      const issue = audit?.accessibility.find((i) => i.rule === 'visual-overflow');
      assert.ok(issue, `expected the defect to be raised as an issue, got ${JSON.stringify(audit?.accessibility)}`);
      assert.equal(issue?.severity, 'error');
      assert.match(issue?.detail ?? '', /83% confident/);
    } finally {
      cleanup();
    }
  },
);

test(
  'a low-confidence defect guess is not reported as a finding',
  { skip: HAS_BROWSER ? false : 'no Chromium available' },
  async () => {
    const { dir, cleanup } = makeApp(PAGE, { 'site.css': 'body { margin: 2rem; }' });
    try {
      const tester = new VisionTester({
        preferBrowser: true,
        inspector: async () => ({ defect: 'overlap', defectConfidence: 0.41 }),
      });
      const result = await new PreviewRunner(ALLOWLIST, tester).run(
        { install: false, build: false, start: ['node', 'server.mjs'], port: 39415, routes: ['/'] },
        dir,
      );
      const audit = result.pages[0]?.audit;
      assert.equal(audit?.visual?.defect, 'overlap', 'the raw guess is still reported');
      assert.equal(
        audit?.accessibility.some((i) => i.rule.startsWith('visual-')),
        false,
        'but a coin-flip guess must not become an issue',
      );
    } finally {
      cleanup();
    }
  },
);

test('the preview directory is created inside the workspace, never outside it', async () => {
  const { dir, cleanup } = makeApp(PAGE);
  try {
    mkdirSync(join(dir, 'app'), { recursive: true });
    writeFileSync(join(dir, 'app', 'package.json'), '{"name":"nested"}');
    const runner = new PreviewRunner(ALLOWLIST, new VisionTester({ preferBrowser: false }));
    await assert.rejects(runner.run({ dir: '../escape' }, dir), /escapes the workspace/);
  } finally {
    cleanup();
  }
});
