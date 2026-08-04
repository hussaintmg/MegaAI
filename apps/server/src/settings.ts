/**
 * Runtime settings for the server — the bits a human enters in the dashboard:
 * provider API keys, the fallback order, and email delivery. Persisted to
 * `${dataDir}/settings.json` (local only, gitignored), merged into
 * `createMegaAI` as config overrides on boot and whenever they are saved.
 *
 * Secrets never leave the machine and are redacted (masked) on read.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JsonObject, JsonValue } from '@megaai/types';

export interface ProviderSettings {
  enabled?: boolean;
  apiKey?: string;
  model?: string;
}

export interface EmailSettings {
  enabled?: boolean;
  from?: string;
  to?: string;
  apiUrl?: string;
  apiKey?: string;
  smtpHost?: string;
}

export interface DeploySettings {
  vercelToken?: string;
  railwayToken?: string;
}

export interface Settings {
  providers?: Record<string, ProviderSettings>;
  fallbackChain?: string[];
  email?: EmailSettings;
  deploy?: DeploySettings;
  policy?: { autoApprove?: boolean };
}

export const PROVIDER_KINDS = ['anthropic', 'openai', 'gemini', 'openrouter', 'groq'] as const;

export function settingsPath(dataDir: string): string {
  return join(dataDir, 'settings.json');
}

export function loadSettings(dataDir: string): Settings {
  const path = settingsPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Settings;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveSettings(dataDir: string, settings: Settings): void {
  const path = settingsPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/** A key that is empty or still masked (contains •) means "leave unchanged". */
function realKey(incoming: string | undefined): string | undefined {
  if (!incoming || incoming.length === 0 || incoming.includes('•')) return undefined;
  return incoming;
}

/** Merge incoming (partial) settings over existing, preserving unchanged secrets. */
export function mergeSettings(existing: Settings, incoming: Settings): Settings {
  const merged: Settings = { ...existing, providers: { ...existing.providers } };
  for (const [kind, prov] of Object.entries(incoming.providers ?? {})) {
    const prev = merged.providers![kind] ?? {};
    merged.providers![kind] = {
      enabled: prov.enabled ?? prev.enabled,
      model: prov.model ?? prev.model,
      apiKey: realKey(prov.apiKey) ?? prev.apiKey,
    };
  }
  if (incoming.fallbackChain) merged.fallbackChain = incoming.fallbackChain.filter((k) => typeof k === 'string' && k.length > 0);
  if (incoming.email) {
    const prev = existing.email ?? {};
    merged.email = {
      enabled: incoming.email.enabled ?? prev.enabled,
      from: incoming.email.from ?? prev.from,
      to: incoming.email.to ?? prev.to,
      apiUrl: incoming.email.apiUrl ?? prev.apiUrl,
      smtpHost: incoming.email.smtpHost ?? prev.smtpHost,
      apiKey: realKey(incoming.email.apiKey) ?? prev.apiKey,
    };
  }
  if (incoming.deploy) {
    const prev = existing.deploy ?? {};
    merged.deploy = {
      vercelToken: realKey(incoming.deploy.vercelToken) ?? prev.vercelToken,
      railwayToken: realKey(incoming.deploy.railwayToken) ?? prev.railwayToken,
    };
  }
  if (incoming.policy) merged.policy = { ...existing.policy, ...incoming.policy };
  return merged;
}

/** Turn stored settings into `createMegaAI` config overrides. */
export function settingsToOverrides(settings: Settings): JsonObject {
  const providers: JsonObject = {};
  for (const [kind, prov] of Object.entries(settings.providers ?? {})) {
    const entry: JsonObject = {};
    if (prov.enabled !== undefined) entry.enabled = prov.enabled;
    if (prov.apiKey) entry.apiKey = prov.apiKey;
    if (prov.model) entry.model = prov.model;
    if (Object.keys(entry).length > 0) providers[kind] = entry;
  }
  const ai: JsonObject = {};
  if (Object.keys(providers).length > 0) ai.providers = providers;
  if (settings.fallbackChain && settings.fallbackChain.length > 0) ai.fallbackChain = settings.fallbackChain as JsonValue;

  const overrides: JsonObject = {};
  if (Object.keys(ai).length > 0) overrides.ai = ai;
  if (settings.email?.enabled && settings.email.from) {
    overrides.comm = {
      email: {
        from: settings.email.from,
        to: settings.email.to ?? '',
        apiUrl: settings.email.apiUrl ?? '',
        apiKey: settings.email.apiKey ?? '',
        smtpHost: settings.email.smtpHost ?? '',
      },
    };
  }
  if (settings.deploy && (settings.deploy.vercelToken || settings.deploy.railwayToken)) {
    overrides.deploy = { vercelToken: settings.deploy.vercelToken ?? '', railwayToken: settings.deploy.railwayToken ?? '' };
  }
  if (settings.policy?.autoApprove !== undefined) overrides.policy = { autoApprove: settings.policy.autoApprove };
  return overrides;
}

function maskKey(key: string): string {
  return key.length <= 4 ? '••••' : `••••${key.slice(-4)}`;
}

/** Redact secrets for API responses — masked keys, complete provider list. */
export function redactSettings(settings: Settings): Settings {
  const providers: Record<string, ProviderSettings> = {};
  for (const kind of PROVIDER_KINDS) {
    const prov = settings.providers?.[kind] ?? {};
    providers[kind] = { enabled: prov.enabled ?? true, model: prov.model ?? '', apiKey: prov.apiKey ? maskKey(prov.apiKey) : '' };
  }
  const email = settings.email ?? {};
  const deploy = settings.deploy ?? {};
  return {
    providers,
    fallbackChain: settings.fallbackChain ?? [],
    email: {
      enabled: email.enabled ?? false,
      from: email.from ?? '',
      to: email.to ?? '',
      apiUrl: email.apiUrl ?? '',
      smtpHost: email.smtpHost ?? '',
      apiKey: email.apiKey ? maskKey(email.apiKey) : '',
    },
    deploy: {
      vercelToken: deploy.vercelToken ? maskKey(deploy.vercelToken) : '',
      railwayToken: deploy.railwayToken ? maskKey(deploy.railwayToken) : '',
    },
    policy: { autoApprove: settings.policy?.autoApprove ?? false },
  };
}

/** Coerce an untrusted request body into a `Settings` object. */
export function parseIncoming(body: Record<string, unknown>): Settings {
  const out: Settings = {};
  const providersIn = body.providers;
  if (providersIn && typeof providersIn === 'object') {
    out.providers = {};
    for (const [kind, raw] of Object.entries(providersIn as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      out.providers[kind] = {
        enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined,
        apiKey: typeof p.apiKey === 'string' ? p.apiKey : undefined,
        model: typeof p.model === 'string' ? p.model : undefined,
      };
    }
  }
  if (Array.isArray(body.fallbackChain)) out.fallbackChain = body.fallbackChain.filter((k): k is string => typeof k === 'string');
  const emailIn = body.email;
  if (emailIn && typeof emailIn === 'object') {
    const e = emailIn as Record<string, unknown>;
    out.email = {
      enabled: typeof e.enabled === 'boolean' ? e.enabled : undefined,
      from: typeof e.from === 'string' ? e.from : undefined,
      to: typeof e.to === 'string' ? e.to : undefined,
      apiUrl: typeof e.apiUrl === 'string' ? e.apiUrl : undefined,
      apiKey: typeof e.apiKey === 'string' ? e.apiKey : undefined,
      smtpHost: typeof e.smtpHost === 'string' ? e.smtpHost : undefined,
    };
  }
  const deployIn = body.deploy;
  if (deployIn && typeof deployIn === 'object') {
    const d = deployIn as Record<string, unknown>;
    out.deploy = {
      vercelToken: typeof d.vercelToken === 'string' ? d.vercelToken : undefined,
      railwayToken: typeof d.railwayToken === 'string' ? d.railwayToken : undefined,
    };
  }
  const policyIn = body.policy;
  if (policyIn && typeof policyIn === 'object') {
    const p = policyIn as Record<string, unknown>;
    if (typeof p.autoApprove === 'boolean') out.policy = { autoApprove: p.autoApprove };
  }
  return out;
}
