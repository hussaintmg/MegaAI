/**
 * Live provider probes for the setup check.
 *
 * A stored key is not a working key. A run whose only "configured" provider
 * rejects every call falls through to the offline mock and hands back
 * placeholder scaffolding, so the setup check asks each provider directly
 * rather than reporting that a key exists.
 *
 * Probes list models rather than generating text: it costs no tokens, and it
 * also lets the configured model name be checked against what the account can
 * actually reach — the second most common reason a key "works" but the run
 * still falls through.
 */

import type { ProviderKind } from './settings';

export interface ProbeResult {
  kind: ProviderKind;
  ok: boolean;
  detail: string;
}

/** Base URLs must match what the engine uses, or the probe tests nothing. */
const OPENAI_COMPATIBLE: Partial<Record<ProviderKind, string>> = {
  openai: 'https://api.openai.com',
  openrouter: 'https://openrouter.ai/api',
  groq: 'https://api.groq.com/openai',
};

const DEFAULT_MODELS: Record<ProviderKind, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
  openrouter: 'openai/gpt-4o-mini',
  groq: 'llama-3.3-70b-versatile',
};

const TIMEOUT_MS = 8_000;

async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

/** Model ids from either the OpenAI-style or the Gemini-style listing. */
function modelIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  const list = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  return list
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const item = entry as Record<string, unknown>;
      // Gemini returns "models/gemini-2.5-flash"; strip the prefix.
      const id = String(item.id ?? item.name ?? '');
      return id.startsWith('models/') ? id.slice(7) : id;
    })
    .filter(Boolean);
}

function explain(status: number): string {
  if (status === 401 || status === 403) return 'the key was rejected (401/403) — copy it again';
  if (status === 429) return 'rate-limited or out of quota (429)';
  if (status === 400) return 'the request was rejected (400) — the key may be malformed';
  return `HTTP ${status}`;
}

/** Ask one provider whether this key works, and whether the model is reachable. */
export async function probeProvider(kind: ProviderKind, apiKey: string, model: string): Promise<ProbeResult> {
  const wanted = model || DEFAULT_MODELS[kind];
  try {
    let status: number;
    let body: unknown;

    if (kind === 'gemini') {
      ({ status, body } = await getJson(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`,
        {},
      ));
    } else if (kind === 'anthropic') {
      ({ status, body } = await getJson('https://api.anthropic.com/v1/models?limit=100', {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      }));
    } else {
      const base = OPENAI_COMPATIBLE[kind];
      if (!base) return { kind, ok: false, detail: 'no probe for this provider' };
      ({ status, body } = await getJson(`${base}/v1/models`, { authorization: `Bearer ${apiKey}` }));
    }

    if (status !== 200) return { kind, ok: false, detail: explain(status) };

    const ids = modelIds(body);
    // An empty listing is not a failure — some gateways do not enumerate.
    if (ids.length > 0 && !ids.some((id) => id === wanted || id.endsWith(`/${wanted}`))) {
      return {
        kind,
        ok: false,
        detail: `key works, but "${wanted}" is not in this account's model list — pick one of: ${ids.slice(0, 4).join(', ')}`,
      };
    }
    return { kind, ok: true, detail: `key works · ${wanted} available` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind, ok: false, detail: /timeout|abort/i.test(message) ? 'no response within 8s' : message };
  }
}
