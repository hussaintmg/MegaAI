import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskMessages } from './index.js';

const TASK = { title: 'Review the checkout page', description: 'Check spacing and colours', agentKind: 'review' };

test('buildTaskMessages keeps plain string content when there are no images', () => {
  const [message] = buildTaskMessages({ task: TASK, contextText: 'ctx' });
  assert.equal(typeof message?.content, 'string');
  assert.match(message?.content as string, /Review the checkout page/);
});

test('buildTaskMessages attaches images as multimodal content parts', () => {
  const image = { type: 'image' as const, mimeType: 'image/png' as const, data: 'AAAA' };
  const [message] = buildTaskMessages({ task: TASK, images: [image] });
  assert.ok(Array.isArray(message?.content));
  const parts = message?.content as Array<{ type: string }>;
  assert.equal(parts[0]?.type, 'text');
  assert.deepEqual(parts[1], image);
  assert.equal(parts.length, 2);
});
