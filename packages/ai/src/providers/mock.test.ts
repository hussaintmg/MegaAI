import test from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from './mock.js';

test('mock provider: vision task with an image writes an analysis action', async () => {
  const provider = new MockProvider();
  const response = await provider.complete({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at the attached screenshot.' },
          { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        ],
      },
    ],
    metadata: { agentKind: 'vision', taskTitle: 'Review homepage screenshot', taskDescription: 'Check the layout' },
  });

  const parsed = JSON.parse(response.text) as { summary: string; actions: Array<{ tool: string; input: { path: string; content: string } }>; echo: { images: number } };
  assert.match(parsed.summary, /Analysed 1 image/);
  assert.equal(parsed.actions.length, 1);
  assert.equal(parsed.actions[0]?.tool, 'fs.write');
  assert.equal(parsed.actions[0]?.input.path, 'vision/review-homepage-screenshot-analysis.md');
  assert.match(parsed.actions[0]?.input.content ?? '', /Images inspected: 1/);
  assert.equal(parsed.echo.images, 1);
});

test('mock provider: vision task without an image reports nothing to analyse', async () => {
  const provider = new MockProvider();
  const response = await provider.complete({
    messages: [{ role: 'user', content: 'Look at the screenshot.' }],
    metadata: { agentKind: 'vision', taskTitle: 'Review homepage screenshot', taskDescription: '' },
  });
  const parsed = JSON.parse(response.text) as { summary: string; actions: unknown[] };
  assert.match(parsed.summary, /no images attached/);
  assert.equal(parsed.actions.length, 1); // still writes a report noting the absence
});

test('mock provider: ml-engineer task scaffolds a training script and model card', async () => {
  const provider = new MockProvider();
  const response = await provider.complete({
    messages: [{ role: 'user', content: 'Train a model.' }],
    metadata: { agentKind: 'ml-engineer', taskTitle: 'Train churn model', taskDescription: 'Predict churn' },
  });
  const parsed = JSON.parse(response.text) as { summary: string; actions: Array<{ input: { path: string } }> };
  assert.match(parsed.summary, /Scaffolded an ML training pipeline/);
  const paths = parsed.actions.map((a) => a.input.path);
  assert.ok(paths.includes('ml/train-churn-model/train.py'));
  assert.ok(paths.includes('ml/train-churn-model/MODEL_CARD.md'));
});
