import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadSettings, mergeSettings, parseIncoming, redactSettings, saveSettings, settingsToOverrides } from './settings.js';

test('settings persist to and load from disk', () => {
  const dir = mkdtempSync(`${tmpdir()}/megaai-settings-`);
  try {
    assert.deepEqual(loadSettings(dir), {});
    saveSettings(dir, { providers: { groq: { enabled: true, apiKey: 'gsk_secret', model: 'llama-3.3-70b-versatile' } } });
    assert.equal(loadSettings(dir).providers?.groq?.apiKey, 'gsk_secret');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge preserves an existing secret when the incoming key is empty or masked', () => {
  const existing = { providers: { gemini: { enabled: true, apiKey: 'real-key', model: 'gemini-2.5-flash' } } };
  const merged = mergeSettings(existing, { providers: { gemini: { enabled: false, apiKey: '' } } });
  assert.equal(merged.providers?.gemini?.apiKey, 'real-key'); // kept
  assert.equal(merged.providers?.gemini?.enabled, false); // updated
  const masked = mergeSettings(existing, { providers: { gemini: { apiKey: '••••-key' } } });
  assert.equal(masked.providers?.gemini?.apiKey, 'real-key'); // masked value ignored
  const changed = mergeSettings(existing, { providers: { gemini: { apiKey: 'new-key' } } });
  assert.equal(changed.providers?.gemini?.apiKey, 'new-key');
});

test('settingsToOverrides only emits configured pieces', () => {
  const overrides = settingsToOverrides({
    providers: { groq: { enabled: true, apiKey: 'gsk', model: 'llama-3.3-70b-versatile' }, openai: { enabled: false } },
    fallbackChain: ['gemini', 'groq', 'mock'],
    email: { enabled: true, from: 'ai@x.dev', to: 'client@y.dev', apiUrl: 'https://api.mail.test/send', apiKey: 'k' },
  }) as { ai: { providers: Record<string, unknown>; fallbackChain: string[] }; comm: { email: { from: string } } };
  assert.deepEqual(overrides.ai.fallbackChain, ['gemini', 'groq', 'mock']);
  assert.deepEqual(overrides.ai.providers.groq, { enabled: true, apiKey: 'gsk', model: 'llama-3.3-70b-versatile' });
  assert.deepEqual(overrides.ai.providers.openai, { enabled: false });
  assert.equal(overrides.comm.email.from, 'ai@x.dev');

  // Disabled email produces no comm override.
  const noEmail = settingsToOverrides({ email: { enabled: false, from: 'ai@x.dev' } });
  assert.equal((noEmail as { comm?: unknown }).comm, undefined);
});

test('redactSettings masks keys and lists every provider', () => {
  const redacted = redactSettings({ providers: { gemini: { enabled: true, apiKey: 'abcdef1234' } }, email: { enabled: true, from: 'a@b', apiKey: 'secretkey' } });
  assert.equal(redacted.providers?.gemini?.apiKey, '••••1234');
  assert.equal(redacted.providers?.groq?.apiKey, ''); // present but unset
  assert.equal(redacted.email?.apiKey, '••••tkey');
  assert.ok(Object.keys(redacted.providers ?? {}).length >= 5);
});

test('parseIncoming coerces an untrusted body defensively', () => {
  const parsed = parseIncoming({
    providers: { groq: { enabled: true, apiKey: 'x', model: 'm' }, junk: 5 },
    fallbackChain: ['gemini', 42, 'mock'],
    email: { enabled: true, from: 'a@b' },
    policy: { autoApprove: true },
    extra: 'ignored',
  } as Record<string, unknown>);
  assert.equal(parsed.providers?.groq?.apiKey, 'x');
  assert.deepEqual(parsed.fallbackChain, ['gemini', 'mock']);
  assert.equal(parsed.email?.from, 'a@b');
  assert.equal(parsed.policy?.autoApprove, true);
});
