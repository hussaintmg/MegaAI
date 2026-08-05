'use client';

import { useEffect, useState } from 'react';
import { apiGet, SessionExpired } from '@/lib/client';

const KINDS = ['anthropic', 'openai', 'gemini', 'openrouter', 'groq'] as const;
const LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  groq: 'Groq',
};

interface ProviderView {
  enabled: boolean;
  model: string;
  apiKey: string;
  requestsPerMinute: number;
  configured: boolean;
  inChain: boolean;
}

interface SettingsView {
  providers: Record<string, ProviderView>;
  fallbackChain: string[];
  planner: string;
  email: { enabled: boolean; from: string; to: string; apiUrl: string; apiKey: string; smtpHost: string };
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [emailKey, setEmailKey] = useState('');
  const [fallback, setFallback] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [checks, setChecks] = useState<Array<{ name: string; ok: boolean; detail: string }> | null>(null);
  const [checking, setChecking] = useState(false);

  async function runDiagnostics() {
    setChecking(true);
    try {
      const data = await apiGet<{ checks: Array<{ name: string; ok: boolean; detail: string }> }>('/api/diagnostics');
      setChecks(data.checks);
    } catch (err) {
      if (err instanceof SessionExpired) return;
      setChecks([{ name: 'Diagnostics', ok: false, detail: err instanceof Error ? err.message : 'failed' }]);
    } finally {
      setChecking(false);
    }
  }

  async function load() {
    try {
      const data = await apiGet<{ settings: SettingsView }>('/api/settings');
      setSettings(data.settings);
      setFallback(data.settings.fallbackChain.join(', '));
      setKeys({});
      setEmailKey('');
      setLoadError('');
    } catch (err) {
      if (err instanceof SessionExpired) return; // redirecting to /login
      setLoadError(err instanceof Error ? err.message : 'could not load settings');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (!settings) {
    return (
      <div className="panel">
        {loadError ? <div className="msg err" style={{ marginLeft: 0 }}>{loadError}</div> : <span className="muted">Loading…</span>}
      </div>
    );
  }

  function setProvider(kind: string, patch: Partial<ProviderView>) {
    setSettings((prev) =>
      prev ? { ...prev, providers: { ...prev.providers, [kind]: { ...prev.providers[kind], ...patch } } } : prev,
    );
  }

  function setEmail(patch: Partial<SettingsView['email']>) {
    setSettings((prev) => (prev ? { ...prev, email: { ...prev.email, ...patch } } : prev));
  }

  async function save() {
    if (!settings) return;
    setBusy(true);
    setMessage(null);
    try {
      const providers: Record<string, unknown> = {};
      for (const kind of KINDS) {
        providers[kind] = {
          enabled: settings.providers[kind]?.enabled ?? true,
          model: settings.providers[kind]?.model ?? '',
          apiKey: keys[kind] ?? '',
          requestsPerMinute: settings.providers[kind]?.requestsPerMinute ?? 0,
        };
      }
      const body = {
        providers,
        fallbackChain: fallback.split(',').map((s) => s.trim()).filter(Boolean),
        planner: settings.planner,
        email: { ...settings.email, apiKey: emailKey },
      };
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) setMessage({ ok: false, text: data.error ?? 'save failed' });
      else {
        setMessage({ ok: true, text: 'Saved — next runs use these settings.' });
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="panel">
        <h2>AI providers</h2>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          Keys are encrypted (AES-256) before they reach the database and only decrypted for your own GitHub
          Actions runner. Leave a key blank to keep the stored one.
        </div>
        <div className="provider-row" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="muted" style={{ fontSize: 11 }}>PROVIDER</div>
          <div className="muted" style={{ fontSize: 11 }}>MODEL (optional)</div>
          <div className="muted" style={{ fontSize: 11 }}>API KEY</div>
          <div className="muted" style={{ fontSize: 11 }}>REQ/MIN</div>
          <div className="muted" style={{ fontSize: 11 }}>ON</div>
        </div>
        {KINDS.map((kind) => {
          const p = settings.providers[kind];
          return (
            <div className="provider-row" key={kind}>
              <div>
                <strong>{LABELS[kind]}</strong>
                <div className={`status ${p?.configured ? 'set' : 'unset'}`}>{p?.configured ? 'configured' : 'no key'}</div>
                {p?.configured && !p.inChain && (
                  <div className="status" style={{ color: 'var(--err)' }}>not in fallback order</div>
                )}
                {p?.configured && p.enabled === false && (
                  <div className="status" style={{ color: 'var(--err)' }}>switched off</div>
                )}
              </div>
              <input
                type="text"
                value={p?.model ?? ''}
                placeholder="default"
                onChange={(e) => setProvider(kind, { model: e.target.value })}
              />
              <input
                type="password"
                value={keys[kind] ?? ''}
                placeholder={p?.apiKey || 'not set'}
                onChange={(e) => setKeys((prev) => ({ ...prev, [kind]: e.target.value }))}
              />
              <input
                type="number"
                min={0}
                value={p?.requestsPerMinute || ''}
                placeholder="auto"
                title="Your plan's requests-per-minute allowance. Blank uses a safe free-tier default."
                onChange={(e) => setProvider(kind, { requestsPerMinute: Number(e.target.value) || 0 })}
              />
              <input
                type="checkbox"
                checked={p?.enabled ?? true}
                onChange={(e) => setProvider(kind, { enabled: e.target.checked })}
              />
            </div>
          );
        })}
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          A saved key is only used when its switch is on <em>and</em> it appears in the fallback order below.
          Leave REQ/MIN blank unless you pay for a higher rate — the engine queues against it instead of
          bursting past your limit and losing the run to a 429.
        </div>
        <label>Fallback order (tried left to right; unconfigured providers are skipped)</label>
        <input type="text" value={fallback} onChange={(e) => setFallback(e.target.value)} placeholder="gemini, openrouter, groq, mock" />
        <label>Planner</label>
        <select value={settings.planner} onChange={(e) => setSettings({ ...settings, planner: e.target.value })}>
          <option value="template">template (deterministic)</option>
          <option value="model">model (AI generates the plan)</option>
        </select>
      </div>

      <div className="panel">
        <h2>Email delivery</h2>
        <div className="grid2">
          <div>
            <label>From</label>
            <input type="text" value={settings.email.from} onChange={(e) => setEmail({ from: e.target.value })} placeholder="MegaAI <you@domain.com>" />
          </div>
          <div>
            <label>Default recipient</label>
            <input type="text" value={settings.email.to} onChange={(e) => setEmail({ to: e.target.value })} placeholder="client@domain.com" />
          </div>
          <div>
            <label>HTTP email API URL</label>
            <input type="text" value={settings.email.apiUrl} onChange={(e) => setEmail({ apiUrl: e.target.value })} placeholder="https://api.provider.com/send" />
          </div>
          <div>
            <label>API key (Bearer)</label>
            <input type="password" value={emailKey} placeholder={settings.email.apiKey || 'not set'} onChange={(e) => setEmailKey(e.target.value)} />
          </div>
          <div>
            <label>or SMTP host</label>
            <input type="text" value={settings.email.smtpHost} onChange={(e) => setEmail({ smtpHost: e.target.value })} placeholder="smtp.example.com" />
          </div>
          <div style={{ alignSelf: 'end' }}>
            <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={settings.email.enabled} onChange={(e) => setEmail({ enabled: e.target.checked })} />
              Enable email channel
            </label>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Setup check</h2>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          Verifies the database, GitHub wiring (token, repo, branch, workflow) and provider keys — run this first
          whenever a goal fails to start.
        </div>
        <div className="row">
          <button className="ghost" onClick={runDiagnostics} disabled={checking}>
            {checking ? 'Checking…' : 'Run setup check'}
          </button>
        </div>
        {checks && (
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr><th>Check</th><th>Result</th></tr>
            </thead>
            <tbody>
              {checks.map((check) => (
                <tr key={check.name}>
                  <td style={{ width: 170 }}>
                    <span className={`chip ${check.ok ? 'completed' : 'failed'}`}>{check.ok ? 'ok' : 'fix'}</span>{' '}
                    {check.name}
                  </td>
                  <td className="muted">{check.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="row">
        <button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
        {message && <span className={`msg ${message.ok ? 'ok' : 'err'}`}>{message.text}</span>}
      </div>
    </>
  );
}
