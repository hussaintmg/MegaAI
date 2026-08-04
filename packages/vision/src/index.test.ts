import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MegaError } from '@megaai/types';
import { createVisionTools, readImagePart, visionReadImageTool } from './index.js';

// A valid 1x1 transparent PNG.
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function workspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'megaai-vision-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('readImagePart reads a PNG as a base64 ChatImagePart', async () => {
  const { dir, cleanup } = workspace();
  try {
    writeFileSync(join(dir, 'shot.png'), Buffer.from(PNG_1X1_BASE64, 'base64'));
    const result = readImagePart(dir, 'shot.png');
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.part.type, 'image');
    assert.equal(result.part.data, PNG_1X1_BASE64);
    assert.ok(result.bytes > 0);
  } finally {
    cleanup();
  }
});

test('readImagePart rejects unsupported extensions', async () => {
  const { dir, cleanup } = workspace();
  try {
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    assert.throws(() => readImagePart(dir, 'notes.txt'), MegaError);
  } finally {
    cleanup();
  }
});

test('readImagePart rejects paths escaping the workspace', async () => {
  const { dir, cleanup } = workspace();
  try {
    assert.throws(() => readImagePart(dir, '../outside.png'), MegaError);
  } finally {
    cleanup();
  }
});

test('readImagePart 404s on a missing file', async () => {
  const { dir, cleanup } = workspace();
  try {
    assert.throws(() => readImagePart(dir, 'missing.png'), MegaError);
  } finally {
    cleanup();
  }
});

test('vision.readImage tool returns base64 content through the Tool contract', async () => {
  const { dir, cleanup } = workspace();
  try {
    writeFileSync(join(dir, 'ui.png'), Buffer.from(PNG_1X1_BASE64, 'base64'));
    const result = await visionReadImageTool.execute({ path: 'ui.png' }, { workspaceRoot: dir });
    assert.deepEqual(result, {
      path: 'ui.png',
      mimeType: 'image/png',
      bytes: Buffer.from(PNG_1X1_BASE64, 'base64').length,
      base64: PNG_1X1_BASE64,
    });
  } finally {
    cleanup();
  }
});

test('createVisionTools exposes the vision.readImage tool', () => {
  const tools = createVisionTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ['vision.readImage'],
  );
});
