/**
 * Platform settings stored in MongoDB (one document). API keys are encrypted
 * at rest; reads mask them, and only the executor endpoint decrypts them for
 * a run. An empty or still-masked key on save means "keep the existing one".
 */

import { getDb } from './db';
import { decryptSecret, encryptSecret, maskSecret } from './crypto';

export const PROVIDER_KINDS = ['anthropic', 'openai', 'gemini', 'openrouter', 'groq'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ProviderSetting {
  enabled: boolean;
  model: string;
  apiKeyEnc: string;
  /** Your plan's allowance. 0 means "use the engine's free-tier default". */
  requestsPerMinute?: number;
}

export interface SettingsDoc {
  _id: string;
  providers: Record<string, ProviderSetting>;
  fallbackChain: string[];
  planner: 'template' | 'model';
  email: { enabled: boolean; from: string; to: string; apiUrl: string; apiKeyEnc: string; smtpHost: string };
  /** Deploying the delivery for real, so the goal ends with a live URL. */
  deploy: { target: string; vercelTokenEnc: string };
}

const DEFAULTS: Omit<SettingsDoc, '_id'> = {
  providers: {},
  fallbackChain: ['gemini', 'openrouter', 'groq', 'mock'],
  planner: 'template',
  email: { enabled: false, from: '', to: '', apiUrl: '', apiKeyEnc: '', smtpHost: '' },
  deploy: { target: 'vercel', vercelTokenEnc: '' },
};

export async function loadSettingsDoc(): Promise<SettingsDoc> {
  const db = await getDb();
  const doc = await db.collection<SettingsDoc>('settings').findOne({ _id: 'settings' });
  return {
    _id: 'settings',
    ...DEFAULTS,
    ...doc,
    email: { ...DEFAULTS.email, ...doc?.email },
    deploy: { ...DEFAULTS.deploy, ...doc?.deploy },
    providers: doc?.providers ?? {},
  };
}

export async function saveSettingsDoc(doc: SettingsDoc): Promise<void> {
  const db = await getDb();
  await db.collection<SettingsDoc>('settings').replaceOne({ _id: 'settings' }, doc, { upsert: true });
}

function isMaskedOrEmpty(value: unknown): boolean {
  return typeof value !== 'string' || value.length === 0 || value.includes('•');
}

/** Merge an untrusted request body over the stored doc, preserving secrets. */
export function mergeSettings(existing: SettingsDoc, body: Record<string, unknown>): SettingsDoc {
  const merged: SettingsDoc = JSON.parse(JSON.stringify(existing)) as SettingsDoc;

  const providersIn = body.providers;
  if (providersIn && typeof providersIn === 'object') {
    for (const kind of PROVIDER_KINDS) {
      const raw = (providersIn as Record<string, unknown>)[kind];
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      const prev = merged.providers[kind] ?? { enabled: true, model: '', apiKeyEnc: '' };
      const rpm = Number(p.requestsPerMinute);
      merged.providers[kind] = {
        enabled: typeof p.enabled === 'boolean' ? p.enabled : prev.enabled,
        model: typeof p.model === 'string' ? p.model.slice(0, 200) : prev.model,
        apiKeyEnc: isMaskedOrEmpty(p.apiKey) ? prev.apiKeyEnc : encryptSecret(String(p.apiKey)),
        // 0 or nonsense means "let the engine use its free-tier default".
        requestsPerMinute: Number.isFinite(rpm) && rpm > 0 ? Math.min(10_000, Math.round(rpm)) : undefined,
      };
    }
  }

  if (Array.isArray(body.fallbackChain)) {
    // Only real provider kinds may enter the chain: the engine rejects its
    // whole config when the chain names a provider that does not exist, which
    // would fail every run at boot. Unknown names are dropped, and an empty
    // result falls back to a chain that always works.
    const allowed = new Set<string>([...PROVIDER_KINDS, 'mock']);
    const chain = body.fallbackChain
      .filter((k): k is string => typeof k === 'string')
      .map((k) => k.trim().toLowerCase())
      .filter((k) => allowed.has(k));
    const deduped = [...new Set(chain)].slice(0, 10);
    if (!deduped.includes('mock')) deduped.push('mock');
    merged.fallbackChain = deduped;
  }
  if (body.planner === 'model' || body.planner === 'template') merged.planner = body.planner;

  const deployIn = body.deploy;
  if (deployIn && typeof deployIn === 'object') {
    const d = deployIn as Record<string, unknown>;
    merged.deploy = {
      target: typeof d.target === 'string' ? d.target.slice(0, 40) : merged.deploy.target,
      vercelTokenEnc: isMaskedOrEmpty(d.vercelToken)
        ? merged.deploy.vercelTokenEnc
        : encryptSecret(String(d.vercelToken)),
    };
  }

  const emailIn = body.email;
  if (emailIn && typeof emailIn === 'object') {
    const e = emailIn as Record<string, unknown>;
    merged.email = {
      enabled: typeof e.enabled === 'boolean' ? e.enabled : merged.email.enabled,
      from: typeof e.from === 'string' ? e.from.slice(0, 200) : merged.email.from,
      to: typeof e.to === 'string' ? e.to.slice(0, 200) : merged.email.to,
      apiUrl: typeof e.apiUrl === 'string' ? e.apiUrl.slice(0, 500) : merged.email.apiUrl,
      apiKeyEnc: isMaskedOrEmpty(e.apiKey) ? merged.email.apiKeyEnc : encryptSecret(String(e.apiKey)),
      smtpHost: typeof e.smtpHost === 'string' ? e.smtpHost.slice(0, 200) : merged.email.smtpHost,
    };
  }
  return merged;
}

/** Redacted view for the settings page. */
export function redactSettings(doc: SettingsDoc): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const kind of PROVIDER_KINDS) {
    const p = doc.providers[kind];
    providers[kind] = {
      enabled: p?.enabled ?? true,
      model: p?.model ?? '',
      apiKey: p ? maskSecret(p.apiKeyEnc) : '',
      requestsPerMinute: p?.requestsPerMinute ?? 0,
      configured: Boolean(p?.apiKeyEnc),
      // The dashboard shows why a stored key still does nothing.
      inChain: doc.fallbackChain.includes(kind),
    };
  }
  return {
    providers,
    fallbackChain: doc.fallbackChain,
    planner: doc.planner,
    email: {
      enabled: doc.email.enabled,
      from: doc.email.from,
      to: doc.email.to,
      apiUrl: doc.email.apiUrl,
      apiKey: maskSecret(doc.email.apiKeyEnc),
      smtpHost: doc.email.smtpHost,
    },
    deploy: {
      target: doc.deploy.target,
      vercelToken: maskSecret(doc.deploy.vercelTokenEnc),
      configured: Boolean(doc.deploy.vercelTokenEnc),
    },
  };
}

/** Decrypted payload for the GitHub Actions runner (executor API only). */
export function executorSettings(doc: SettingsDoc): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const kind of PROVIDER_KINDS) {
    const p = doc.providers[kind];
    if (!p) continue;
    providers[kind] = {
      enabled: p.enabled,
      model: p.model || undefined,
      apiKey: decryptSecret(p.apiKeyEnc) || undefined,
      requestsPerMinute: p.requestsPerMinute || undefined,
    };
  }
  return {
    providers,
    fallbackChain: doc.fallbackChain,
    planner: doc.planner,
    email: doc.email.enabled
      ? {
          from: doc.email.from,
          to: doc.email.to,
          apiUrl: doc.email.apiUrl,
          apiKey: decryptSecret(doc.email.apiKeyEnc) || undefined,
          smtpHost: doc.email.smtpHost,
        }
      : undefined,
    deploy: {
      target: doc.deploy.target,
      vercelToken: decryptSecret(doc.deploy.vercelTokenEnc) || undefined,
    },
  };
}
