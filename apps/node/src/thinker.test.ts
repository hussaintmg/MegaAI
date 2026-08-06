import test from 'node:test';
import assert from 'node:assert/strict';
import type { Provider } from '@megaai/contracts';
import { buildProviders, createThinker, keysFor } from './thinker.js';

function fake(name: string, answer: string | Error): Provider {
  return {
    kind: 'mock',
    name,
    models: () => [],
    isConfigured: () => true,
    complete: async () => {
      if (answer instanceof Error) throw answer;
      return { text: answer, provider: 'mock', model: 'x', stopReason: 'end', usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

test('every spelling of a second key is picked up, and duplicates are not', () => {
  const keys = keysFor(
    { GEMINI_API_KEY: 'one', GEMINI_API_KEY_2: 'two', GEMINI_API_KEY3: 'three', GEMINI_API_KEY_4: 'one' },
    'GEMINI_API_KEY',
  );
  assert.deepEqual(keys, ['one', 'two', 'three']);
});

test('several keys pasted into one variable are read as several keys', () => {
  assert.deepEqual(keysFor({ GROQ_API_KEY: 'a, b ,c' }, 'GROQ_API_KEY'), ['a, b ,c', 'a', 'b', 'c']);
});

test('no keys means no providers, rather than one that fails on first use', () => {
  assert.deepEqual(buildProviders({}), []);
});

test('Gemini leads and Anthropic is last — Claude Code needs that quota to write with', () => {
  const providers = buildProviders({
    ANTHROPIC_API_KEY: 'a',
    GEMINI_API_KEY: 'g',
    GROQ_API_KEY: 'q',
    OPENROUTER_API_KEY: 'o',
  });
  assert.deepEqual(providers.map((provider) => provider.kind), ['gemini', 'openrouter', 'groq', 'anthropic']);
});

test('the first provider that answers is the one used', async () => {
  const thinker = createThinker({ providers: [fake('Gemini', '{"ok":true}'), fake('Groq', 'never asked')] });
  assert.equal(await thinker.think('plan it'), '{"ok":true}');
});

test('a rate-limited provider steps aside for the next one', async () => {
  const thinker = createThinker({
    providers: [fake('Gemini', new Error('all 2 keys are rate limited')), fake('Groq', '{"ok":true}')],
  });
  assert.equal(await thinker.think('plan it'), '{"ok":true}');
});

test('a provider that answers with nothing is not treated as an answer', async () => {
  const thinker = createThinker({ providers: [fake('Gemini', '   '), fake('Groq', 'a real plan')] });
  assert.equal(await thinker.think('plan it'), 'a real plan');
});

test('when they all fail, every reason is given — one of them names the key to fix', async () => {
  const thinker = createThinker({
    providers: [fake('Gemini', new Error('all 2 keys are rate limited until 19:40')), fake('OpenRouter', new Error('401'))],
  });
  await assert.rejects(
    () => thinker.think('plan it'),
    /Gemini: all 2 keys are rate limited until 19:40; OpenRouter: 401/,
  );
});

test('with nothing configured it says which key to set, not "unavailable"', async () => {
  const thinker = createThinker({ providers: [] });
  await assert.rejects(() => thinker.think('plan it'), /megaai-node set GEMINI_API_KEY/);
  assert.match(thinker.describe(), /set GEMINI_API_KEY/);
});
