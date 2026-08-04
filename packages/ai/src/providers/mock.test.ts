import test from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from './mock.js';

const IMAGE = { type: 'image' as const, mimeType: 'image/png' as const, data: 'AAAA' };

test('mock provider accepts multimodal message content without crashing', async () => {
  const provider = new MockProvider();
  const response = await provider.complete({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'describe this' }, IMAGE] }],
  });
  assert.equal(response.provider, 'mock');
  assert.ok(response.usage.inputTokens > 0);
});

test('mock provider handles the vision agent kind and reports images reviewed', async () => {
  const provider = new MockProvider();
  const response = await provider.complete({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'review this screenshot' }, IMAGE, IMAGE] }],
    metadata: { agentKind: 'vision', taskTitle: 'Review homepage screenshot', taskDescription: 'Check layout' },
  });
  const parsed = JSON.parse(response.text);
  assert.match(parsed.summary, /Analysed 2 image/);
  assert.equal(parsed.actions[0].tool, 'fs.write');
  assert.match(parsed.actions[0].input.content, /Images reviewed: 2/);
});

test('mock provider vision reply notes when no images were attached', async () => {
  const provider = new MockProvider();
  const response = await provider.complete({
    messages: [{ role: 'user', content: 'review this' }],
    metadata: { agentKind: 'vision', taskTitle: 'Review homepage', taskDescription: '' },
  });
  const parsed = JSON.parse(response.text);
  assert.match(parsed.summary, /No images attached/);
});
