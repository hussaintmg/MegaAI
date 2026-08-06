import test from 'node:test';
import assert from 'node:assert/strict';
import { executorSettings, mergeSettings, providerKeys, redactSettings, type SettingsDoc } from './settings-model.ts';

// crypto.ts refuses to run without this, which is the point of it.
process.env.ENCRYPTION_SECRET ||= 'test-secret-for-settings-tests-0123456789';

function blank(): SettingsDoc {
  return {
    _id: 'settings',
    providers: {},
    fallbackChain: ['gemini', 'mock'],
    planner: 'template',
    email: { enabled: false, from: '', to: '', apiUrl: '', apiKeyEnc: '', smtpHost: '' },
    deploy: { target: 'vercel', vercelTokenEnc: '' },
  };
}

test('several keys can be added to one provider, and all of them are kept', () => {
  // Free tiers are per key, so this is the difference between stopping at 2am
  // and finishing.
  let doc = mergeSettings(blank(), { providers: { gemini: { addKeys: ['AAAAkey1'] } } });
  doc = mergeSettings(doc, { providers: { gemini: { addKeys: ['BBBBkey2', 'CCCCkey3'] } } });

  assert.equal(providerKeys(doc.providers['gemini']).length, 3);
  const forRunner = executorSettings(doc).providers as Record<string, { apiKeys?: string[] }>;
  assert.deepEqual(forRunner['gemini']?.apiKeys, ['AAAAkey1', 'BBBBkey2', 'CCCCkey3']);
});

test('typing in the single key box adds a key rather than replacing the last one', () => {
  let doc = mergeSettings(blank(), { providers: { gemini: { addKeys: ['first-key'] } } });
  doc = mergeSettings(doc, { providers: { gemini: { apiKey: 'second-key' } } });
  assert.equal(providerKeys(doc.providers['gemini']).length, 2, 'adding is what holding several means');
});

test('a key already saved is never overwritten by the masked value shown back', () => {
  // The page shows "••••" for what is stored; saving that must not store the
  // dots as a key.
  let doc = mergeSettings(blank(), { providers: { gemini: { addKeys: ['real-key'] } } });
  doc = mergeSettings(doc, { providers: { gemini: { apiKey: '••••••••', addKeys: ['••••'] } } });
  assert.equal(providerKeys(doc.providers['gemini']).length, 1);
});

test('a key can be removed by id, and remove-then-add in one save does both', () => {
  let doc = mergeSettings(blank(), { providers: { gemini: { addKeys: ['old-key'] } } });
  const oldId = providerKeys(doc.providers['gemini'])[0]!.id;

  doc = mergeSettings(doc, { providers: { gemini: { removeKeyIds: [oldId], addKeys: ['new-key'] } } });
  const keys = providerKeys(doc.providers['gemini']);
  assert.equal(keys.length, 1);
  const forRunner = executorSettings(doc).providers as Record<string, { apiKeys?: string[] }>;
  assert.deepEqual(forRunner['gemini']?.apiKeys, ['new-key']);
});

test('a key saved before multi-key existed is carried over, not lost', () => {
  // Upgrading must not silently drop the key someone pasted months ago.
  const legacy = blank();
  legacy.providers['gemini'] = { enabled: true, model: '', apiKeyEnc: mergeSettings(blank(), {
    providers: { gemini: { addKeys: ['pasted-long-ago'] } },
  }).providers['gemini']!.keys![0]!.apiKeyEnc };

  assert.equal(providerKeys(legacy.providers['gemini']).length, 1);
  const forRunner = executorSettings(legacy).providers as Record<string, { apiKeys?: string[] }>;
  assert.deepEqual(forRunner['gemini']?.apiKeys, ['pasted-long-ago']);

  // …and adding a second one keeps the first.
  const upgraded = mergeSettings(legacy, { providers: { gemini: { addKeys: ['brand-new'] } } });
  assert.equal(providerKeys(upgraded.providers['gemini']).length, 2);
});

test('the settings page is told how many keys there are, and never any of them', () => {
  const doc = mergeSettings(blank(), { providers: { gemini: { addKeys: ['AIzaSy-secret-value-9f3K'] } } });
  const view = redactSettings(doc).providers as Record<string, { keys: Array<{ label: string }>; keyCount: number }>;

  assert.equal(view['gemini']?.keyCount, 1);
  assert.equal(view['gemini']?.keys[0]?.label, '…9f3K');
  const serialised = JSON.stringify(view);
  assert.ok(!serialised.includes('AIzaSy'), 'the front of a key must never reach the browser');
  assert.ok(!serialised.includes('secret-value'));
});

test('the runner still gets a single apiKey too, so an older one keeps working', () => {
  const doc = mergeSettings(blank(), { providers: { groq: { addKeys: ['one', 'two'] } } });
  const forRunner = executorSettings(doc).providers as Record<string, { apiKey?: string; apiKeys?: string[] }>;
  assert.equal(forRunner['groq']?.apiKey, 'one');
  assert.deepEqual(forRunner['groq']?.apiKeys, ['one', 'two']);
});
