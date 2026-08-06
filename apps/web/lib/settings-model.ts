/**
 * The shape of platform settings, and every pure transform over it.
 *
 * Deliberately free of any database import. `settings.ts` next door reads and
 * writes the document; this file only decides what a saved document *means* —
 * which is the part worth testing, and the part that cannot be tested at all
 * while loading the module drags MongoDB in with it.
 */

import { decryptSecret, encryptSecret, maskSecret } from './crypto.ts';

export const PROVIDER_KINDS = ['anthropic', 'openai', 'gemini', 'openrouter', 'groq'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * One API key. Several per provider is the normal case, not the exception:
 * free tiers are per key, so three Gemini keys is three times the allowance —
 * and the engine rotates through them so a spent key costs a key rather than
 * the whole provider.
 */
export interface ProviderKey {
  id: string;
  /** Your own name for it ("personal", "work"), or the last four characters. */
  label: string;
  apiKeyEnc: string;
  enabled: boolean;
  addedAt: number;
}

export interface ProviderSetting {
  enabled: boolean;
  model: string;
  /** Kept only so a settings document written before multi-key still works. */
  apiKeyEnc?: string;
  keys?: ProviderKey[];
  /** Your plan's allowance. 0 means "use the engine's free-tier default". */
  requestsPerMinute?: number;
}

/**
 * Every usable key for a provider, oldest first.
 *
 * Reads through the old single-key field as well, so upgrading does not lose
 * the key someone pasted months ago.
 */
export function providerKeys(setting: ProviderSetting | undefined): ProviderKey[] {
  if (!setting) return [];
  const keys = (setting.keys ?? []).filter((key) => key.enabled !== false && key.apiKeyEnc);
  if (keys.length > 0) return keys;
  return setting.apiKeyEnc
    ? [{ id: 'legacy', label: 'saved key', apiKeyEnc: setting.apiKeyEnc, enabled: true, addedAt: 0 }]
    : [];
}

function newKeyId(): string {
  return `k_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** The last four characters — enough to tell keys apart, useless to steal. */
export function keyLabel(raw: string, index: number): string {
  const tail = raw.trim().slice(-4);
  return tail.length === 4 ? `…${tail}` : `key ${index + 1}`;
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

export const DEFAULTS: Omit<SettingsDoc, '_id'> = {
  providers: {},
  fallbackChain: ['gemini', 'openrouter', 'groq', 'mock'],
  planner: 'template',
  email: { enabled: false, from: '', to: '', apiUrl: '', apiKeyEnc: '', smtpHost: '' },
  deploy: { target: 'vercel', vercelTokenEnc: '' },
};

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
      const prev = merged.providers[kind] ?? { enabled: true, model: '', keys: [] };
      const rpm = Number(p.requestsPerMinute);

      // Start from whatever is stored, folding a pre-multi-key document into
      // the list so nobody's existing key disappears on upgrade.
      let keys: ProviderKey[] = prev.keys ?? [];
      if (keys.length === 0 && prev.apiKeyEnc) {
        keys = [{ id: newKeyId(), label: 'saved key', apiKeyEnc: prev.apiKeyEnc, enabled: true, addedAt: 0 }];
      }

      // Removals first, so "remove then add" in one save does what it says.
      if (Array.isArray(p.removeKeyIds)) {
        const removing = new Set(p.removeKeyIds.filter((id): id is string => typeof id === 'string'));
        keys = keys.filter((key) => !removing.has(key.id));
      }
      if (Array.isArray(p.addKeys)) {
        for (const entry of p.addKeys) {
          const raw = typeof entry === 'string' ? entry : (entry as Record<string, unknown>)?.apiKey;
          if (typeof raw !== 'string' || isMaskedOrEmpty(raw)) continue;
          const label =
            typeof entry === 'object' && typeof (entry as Record<string, unknown>).label === 'string'
              ? String((entry as Record<string, unknown>).label).slice(0, 60)
              : keyLabel(raw, keys.length);
          keys.push({ id: newKeyId(), label, apiKeyEnc: encryptSecret(raw.trim()), enabled: true, addedAt: Date.now() });
        }
      }
      // The single-field form still works, and adds rather than replaces.
      if (!isMaskedOrEmpty(p.apiKey)) {
        const raw = String(p.apiKey).trim();
        keys.push({ id: newKeyId(), label: keyLabel(raw, keys.length), apiKeyEnc: encryptSecret(raw), enabled: true, addedAt: Date.now() });
      }

      merged.providers[kind] = {
        enabled: typeof p.enabled === 'boolean' ? p.enabled : prev.enabled,
        model: typeof p.model === 'string' ? p.model.slice(0, 200) : prev.model,
        keys: keys.slice(0, 20),
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
    const keys = providerKeys(p);
    providers[kind] = {
      enabled: p?.enabled ?? true,
      model: p?.model ?? '',
      // Never the key, and never enough of it to be worth stealing.
      keys: keys.map((key) => ({ id: key.id, label: key.label, addedAt: key.addedAt })),
      keyCount: keys.length,
      requestsPerMinute: p?.requestsPerMinute ?? 0,
      configured: keys.length > 0,
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
    const keys = providerKeys(p)
      .map((key) => decryptSecret(key.apiKeyEnc))
      .filter((key): key is string => Boolean(key));
    providers[kind] = {
      enabled: p.enabled,
      model: p.model || undefined,
      // Both: `apiKey` keeps an older runner working, `apiKeys` is what the
      // engine rotates through so one spent key does not cost the provider.
      apiKey: keys[0],
      apiKeys: keys.length > 0 ? keys : undefined,
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
