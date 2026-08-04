import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskRecord } from '@megaai/types';
import { loadTaskImages } from './index.js';

function taskWith(attachments: TaskRecord['attachments']): TaskRecord {
  return {
    id: 'tsk_1',
    projectId: 'prj_1',
    title: 'a task',
    description: '',
    agentKind: 'vision',
    state: 'ready',
    priority: 'normal',
    complexity: 'standard',
    dependsOn: [],
    attempts: 0,
    maxAttempts: 2,
    attachments,
    createdAt: 0,
    updatedAt: 0,
  };
}

test('loadTaskImages base64-encodes an attached image with an inferred mime type', () => {
  const root = mkdtempSync(join(tmpdir(), 'megaai-images-'));
  try {
    writeFileSync(join(root, 'shot.png'), Buffer.from('hello'));
    const images = loadTaskImages(root, taskWith([{ path: 'shot.png' }]));
    assert.equal(images.length, 1);
    assert.deepEqual(images[0], { type: 'image', mimeType: 'image/png', data: Buffer.from('hello').toString('base64') });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadTaskImages skips missing files, unreadable extensions, sandbox escapes and oversized files', () => {
  const root = mkdtempSync(join(tmpdir(), 'megaai-images-'));
  try {
    writeFileSync(join(root, 'not-an-image.txt'), 'hello');
    writeFileSync(join(root, 'huge.png'), Buffer.alloc(6 * 1024 * 1024));
    const images = loadTaskImages(
      root,
      taskWith([
        { path: 'missing.png' },
        { path: 'not-an-image.txt' },
        { path: '../escape.png' },
        { path: 'huge.png' },
      ]),
    );
    assert.equal(images.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadTaskImages returns nothing for a task with no attachments', () => {
  const root = mkdtempSync(join(tmpdir(), 'megaai-images-'));
  try {
    assert.deepEqual(loadTaskImages(root, taskWith(undefined)), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
