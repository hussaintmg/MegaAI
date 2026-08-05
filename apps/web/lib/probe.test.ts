import test from 'node:test';
import assert from 'node:assert/strict';
import { probeProvider } from './probe.ts';

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Answer the next fetch with `status`/`body` and record what was asked. */
function stubFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    return { status, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

test('a rejected key is reported as rejected, not as "configured"', async () => {
  stubFetch(401, { error: 'bad key' });
  const result = await probeProvider('gemini', 'nope', '');
  assert.equal(result.ok, false);
  assert.match(result.detail, /rejected \(401\/403\)/);
});

test('quota exhaustion is named, since it looks identical in a failed run', async () => {
  stubFetch(429, {});
  assert.match((await probeProvider('groq', 'k', '')).detail, /rate-limited or out of quota/);
});

test('a working key with the configured model available passes', async () => {
  const calls = stubFetch(200, { models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-pro' }] });
  const result = await probeProvider('gemini', 'secret-key', 'gemini-2.5-flash');
  assert.equal(result.ok, true);
  assert.match(result.detail, /key works · gemini-2\.5-flash available/);
  // The key travels as a query parameter for Gemini, and the listing endpoint
  // must be the one the engine's base URL points at.
  assert.match(calls[0]!.url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\?key=secret-key/);
});

test('a key that works but cannot reach the chosen model says which models it can', async () => {
  stubFetch(200, { data: [{ id: 'llama-3.1-8b-instant' }, { id: 'llama-3.3-70b-versatile' }] });
  const result = await probeProvider('groq', 'k', 'gpt-4o');
  assert.equal(result.ok, false);
  assert.match(result.detail, /"gpt-4o" is not in this account's model list/);
  assert.match(result.detail, /llama-3\.1-8b-instant, llama-3\.3-70b-versatile/);
});

test('OpenAI-compatible providers are probed at the base URL the engine uses', async () => {
  const groq = stubFetch(200, { data: [{ id: 'llama-3.3-70b-versatile' }] });
  await probeProvider('groq', 'gsk_x', '');
  assert.equal(groq[0]!.url, 'https://api.groq.com/openai/v1/models');
  assert.equal(groq[0]!.headers.authorization, 'Bearer gsk_x');

  const openrouter = stubFetch(200, { data: [{ id: 'openai/gpt-4o-mini' }] });
  const result = await probeProvider('openrouter', 'sk-or', '');
  assert.equal(openrouter[0]!.url, 'https://openrouter.ai/api/v1/models');
  assert.equal(result.ok, true, 'a namespaced default model id still matches');
});

test('anthropic is probed with its own header scheme', async () => {
  const calls = stubFetch(200, { data: [{ id: 'claude-opus-5' }] });
  await probeProvider('anthropic', 'sk-ant', '');
  assert.equal(calls[0]!.headers['x-api-key'], 'sk-ant');
  assert.equal(calls[0]!.headers['anthropic-version'], '2023-06-01');
});

test('a gateway that does not enumerate models still counts as working', async () => {
  stubFetch(200, {});
  const result = await probeProvider('openrouter', 'k', 'some/custom-model');
  assert.equal(result.ok, true, 'an empty listing must not be read as a missing model');
});

test('a network failure is reported rather than thrown', async () => {
  globalThis.fetch = (async () => {
    throw new Error('getaddrinfo ENOTFOUND api.groq.com');
  }) as typeof fetch;
  const result = await probeProvider('groq', 'k', '');
  assert.equal(result.ok, false);
  assert.match(result.detail, /ENOTFOUND/);

  globalThis.fetch = (async () => {
    throw new Error('The operation was aborted due to timeout');
  }) as typeof fetch;
  assert.match((await probeProvider('groq', 'k', '')).detail, /no response within 8s/);
});
