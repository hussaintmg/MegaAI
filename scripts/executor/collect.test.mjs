import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectContents, isPreviewShot, MAX_IMAGE_BYTES, walkFiles } from './collect.mjs';

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'megaai-collect-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('the walk skips what the build produced, not what was authored', () => {
  const { root, cleanup } = workspace({
    'app/page.tsx': 'export default function Page() { return null; }',
    'lib/data.ts': 'export const x = 1;',
    'package.json': '{}',
    'node_modules/next/index.js': 'module.exports = {};',
    '.next/static/chunk.js': 'x',
    '.git/HEAD': 'ref: refs/heads/main',
    'coverage/lcov.info': 'x',
    'dist/bundle.js': 'x',
  });
  try {
    assert.deepEqual(walkFiles(root), ['app/page.tsx', 'lib/data.ts', 'package.json']);
  } finally {
    cleanup();
  }
});

test('a workspace with a real node_modules still reports its source files', () => {
  // Before app.preview, no delivery had dependencies installed. Now every one
  // does, and thousands of vendored files would fill the 300-entry budget
  // before a single authored file was listed.
  const files = { 'app/page.tsx': 'x', 'README.md': 'y' };
  for (let i = 0; i < 500; i += 1) files[`node_modules/pkg${i}/index.js`] = 'vendored';
  const { root, cleanup } = workspace(files);
  try {
    assert.deepEqual(walkFiles(root), ['README.md', 'app/page.tsx']);
  } finally {
    cleanup();
  }
});

test('preview screenshots travel as data, other binaries only as names', () => {
  // A minimal valid PNG header; the content does not matter, the NUL does —
  // that is what marks it binary.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
  const { root, cleanup } = workspace({
    '.megaai/preview/home.png': png,
    'public/logo.png': png,
    'app/page.tsx': 'export default function Page() { return <h1>hi</h1>; }',
  });
  try {
    const contents = collectContents(root, walkFiles(root));
    const shot = contents.find((f) => f.path === '.megaai/preview/home.png');
    assert.match(shot?.image ?? '', /^data:image\/png;base64,/);
    assert.equal(shot?.binary, undefined);

    const logo = contents.find((f) => f.path === 'public/logo.png');
    assert.equal(logo?.binary, true, 'an ordinary binary is listed, not inlined');
    assert.equal(logo?.image, undefined);

    const source = contents.find((f) => f.path === 'app/page.tsx');
    assert.match(source?.text ?? '', /<h1>hi<\/h1>/);
  } finally {
    cleanup();
  }
});

test('an oversized screenshot is not inlined', () => {
  const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  const { root, cleanup } = workspace({ '.megaai/preview/huge.png': huge });
  try {
    const [entry] = collectContents(root, walkFiles(root));
    assert.equal(entry?.image, undefined);
    assert.equal(entry?.binary, true);
  } finally {
    cleanup();
  }
});

test('isPreviewShot only accepts PNGs from the preview directory', () => {
  assert.equal(isPreviewShot('.megaai/preview/home.png', 100), true);
  assert.equal(isPreviewShot('.megaai/preview/home.jpg', 100), false);
  assert.equal(isPreviewShot('public/home.png', 100), false);
  assert.equal(isPreviewShot('.megaai/preview/home.png', MAX_IMAGE_BYTES + 1), false);
});

test('every collected entry is either text, an image, or marked binary', () => {
  const { root, cleanup } = workspace({
    'a.ts': 'const a = 1;',
    'b.bin': Buffer.from([0, 1, 2, 3]),
    '.megaai/preview/home.png': Buffer.from([0x89, 0x50, 0x00, 0x01]),
  });
  try {
    const contents = collectContents(root, walkFiles(root));
    assert.equal(contents.length, 3);
    for (const entry of contents) {
      assert.ok(
        typeof entry.text === 'string' || typeof entry.image === 'string' || entry.binary === true,
        `${entry.path} came back with nothing usable`,
      );
    }
    // Sorted by path, so the dashboard's file list is stable between runs.
    assert.deepEqual(
      contents.map((entry) => entry.path),
      ['.megaai/preview/home.png', 'a.ts', 'b.bin'],
    );
  } finally {
    cleanup();
  }
});
