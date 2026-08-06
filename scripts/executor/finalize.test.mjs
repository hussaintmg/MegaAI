import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeDelivery, findAppRoot, guessRoutes } from './finalize.mjs';

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'megaai-final-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const APP = JSON.stringify({ name: 'site', scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '15' } });

test('the app is found even when an agent scaffolds it in a subdirectory', () => {
  const { root, cleanup } = workspace({
    'README.md': '# docs',
    'web/package.json': APP,
    'web/app/page.tsx': 'export default function P() { return null; }',
  });
  try {
    assert.equal(findAppRoot(root)?.dir, join(root, 'web'));
  } finally {
    cleanup();
  }
});

test('a workspace with no runnable app is reported, not silently skipped', async () => {
  const { root, cleanup } = workspace({ 'marketing/announcement.md': '# launch' });
  try {
    assert.equal(findAppRoot(root), undefined);
    const said = [];
    const outcome = await finalizeDelivery({ workspaceDir: root, log: (e, m) => said.push(`${e}: ${m}`) });
    assert.equal(outcome.preview, undefined);
    assert.match(said.join('\n'), /No runnable app was found/);
  } finally {
    cleanup();
  }
});

test('routes are guessed from the pages that exist', () => {
  const { root, cleanup } = workspace({
    'package.json': APP,
    'app/page.tsx': 'x',
    'app/models/page.tsx': 'x',
    'app/api/cars/route.ts': 'x',
    'app/components/Thing.tsx': 'x',
  });
  try {
    const routes = guessRoutes(root);
    assert.deepEqual(routes, ['/', '/models'], 'api routes and component folders are not pages');
  } finally {
    cleanup();
  }
});

test('a build that fails stops the deployment — a live URL onto a broken build is worse than none', async () => {
  const { root, cleanup } = workspace({ 'package.json': APP, 'app/page.tsx': 'x' });
  try {
    const said = [];
    let deployed = false;
    const outcome = await finalizeDelivery({
      workspaceDir: root,
      vercelToken: 'tok',
      log: (e, m) => said.push(`${e}: ${m}`),
      previewRunner: {
        run: async () => ({
          ok: false,
          steps: [{ name: 'build', ok: false, exitCode: 1, output: 'Type error in app/page.tsx' }],
          pages: [],
        }),
      },
      deploy: {
        collect: () => [{ file: 'a' }],
        run: async () => {
          deployed = true;
          return { ok: true, url: 'https://x.vercel.app', files: 1, id: 'd', readyState: 'READY' };
        },
        projectName: 'site',
      },
    });
    assert.equal(deployed, false);
    assert.equal(outcome.deployment, undefined);
    assert.match(said.join('\n'), /Skipped the deployment because the app does not build/);
    assert.match(said.join('\n'), /Type error in app\/page\.tsx/);
  } finally {
    cleanup();
  }
});

test('with no token the run says why there is no link, instead of leaving a gap', async () => {
  const { root, cleanup } = workspace({ 'package.json': APP, 'app/page.tsx': 'x' });
  try {
    const said = [];
    await finalizeDelivery({
      workspaceDir: root,
      log: (e, m) => said.push(`${e}: ${m}`),
      previewRunner: { run: async () => ({ ok: true, steps: [], pages: [] }) },
      deploy: { collect: () => [{ file: 'a' }], run: async () => ({ ok: true, url: 'https://x' }), projectName: 'site' },
    });
    assert.match(said.join('\n'), /No Vercel token is saved, so there is no live URL/);
  } finally {
    cleanup();
  }
});

test('a good build deploys, and the URL comes back for the dashboard', async () => {
  const { root, cleanup } = workspace({ 'package.json': APP, 'app/page.tsx': 'x' });
  try {
    const said = [];
    const outcome = await finalizeDelivery({
      workspaceDir: root,
      vercelToken: 'tok',
      log: (e, m) => said.push(`${e}: ${m}`),
      previewRunner: {
        run: async () => ({
          ok: true,
          steps: [{ name: 'build', ok: true, exitCode: 0, output: '' }],
          pages: [{ route: '/', ok: true, status: 200, screenshot: '.megaai/preview/home.png' }],
        }),
      },
      deploy: {
        collect: () => [{ file: 'a' }, { file: 'b' }],
        run: async (options) => {
          assert.equal(options.framework, 'nextjs', 'the framework is taken from the delivery, not assumed');
          return { ok: true, url: 'https://site-abc.vercel.app', inspectorUrl: 'https://vercel.com/i', files: 2, id: 'd', readyState: 'READY' };
        },
        projectName: 'site',
      },
    });
    assert.equal(outcome.deployment?.url, 'https://site-abc.vercel.app');
    assert.equal(outcome.deployment?.simulated, false);
    assert.match(said.join('\n'), /1 screenshot\(s\) taken/);
    assert.match(said.join('\n'), /Live at https:\/\/site-abc\.vercel\.app/);
  } finally {
    cleanup();
  }
});

test('a preview that throws does not take the deployment down with it', async () => {
  const { root, cleanup } = workspace({ 'package.json': APP, 'app/page.tsx': 'x' });
  try {
    const said = [];
    const outcome = await finalizeDelivery({
      workspaceDir: root,
      vercelToken: 'tok',
      log: (e, m) => said.push(`${e}: ${m}`),
      previewRunner: {
        run: async () => {
          throw new Error('no chromium here');
        },
      },
      deploy: {
        collect: () => [{ file: 'a' }],
        run: async () => ({ ok: true, url: 'https://site.vercel.app', files: 1, id: 'd', readyState: 'READY' }),
        projectName: 'site',
      },
    });
    assert.match(said.join('\n'), /Could not preview the app: no chromium here/);
    assert.equal(outcome.deployment?.url, 'https://site.vercel.app', 'the link still gets made');
  } finally {
    cleanup();
  }
});
