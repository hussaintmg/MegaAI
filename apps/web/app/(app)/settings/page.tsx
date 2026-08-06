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

interface ProviderKeyView {
  id: string;
  label: string;
  addedAt: number;
}

interface ProviderView {
  enabled: boolean;
  model: string;
  /** Every key saved for this provider — the engine uses all of them. */
  keys: ProviderKeyView[];
  keyCount: number;
  requestsPerMinute: number;
  configured: boolean;
  inChain: boolean;
}

interface SettingsView {
  providers: Record<string, ProviderView>;
  fallbackChain: string[];
  planner: string;
  email: { enabled: boolean; from: string; to: string; apiUrl: string; apiKey: string; smtpHost: string };
  deploy: { target: string; vercelToken: string; configured: boolean };
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  /** Keys marked for removal on the next save, so it can be undone first. */
  const [removing, setRemoving] = useState<Record<string, string[]>>({});
  const [emailKey, setEmailKey] = useState('');
  const [vercelToken, setVercelToken] = useState('');
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
      setRemoving({});
      setEmailKey('');
      setVercelToken('');
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
        // A typed key is *added* to the list rather than replacing it — that is
        // the whole point of holding several.
        const typed = (keys[kind] ?? '').trim();
        providers[kind] = {
          enabled: settings.providers[kind]?.enabled ?? true,
          model: settings.providers[kind]?.model ?? '',
          addKeys: typed ? [typed] : [],
          removeKeyIds: removing[kind] ?? [],
          requestsPerMinute: settings.providers[kind]?.requestsPerMinute ?? 0,
        };
      }
      const body = {
        providers,
        fallbackChain: fallback.split(',').map((s) => s.trim()).filter(Boolean),
        planner: settings.planner,
        email: { ...settings.email, apiKey: emailKey },
        deploy: { target: settings.deploy?.target ?? 'vercel', vercelToken },
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
          Actions runner. <strong>Add as many keys per provider as you like</strong> — free tiers are counted
          per key, so three Gemini keys is three times the allowance, and a key that hits its limit costs a
          key rather than the whole provider: the next one takes over inside the same request.
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
                <div className={`status ${p?.configured ? 'set' : 'unset'}`}>
                  {p?.keyCount ? `${p.keyCount} key${p.keyCount === 1 ? '' : 's'}` : 'no key'}
                </div>
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
              <div>
                {(p?.keys ?? []).map((key) => (
                  <div key={key.id} className="keychip">
                    <span>{key.label}</span>
                    <button
                      type="button"
                      title="remove this key"
                      className={removing[kind]?.includes(key.id) ? 'removing' : ''}
                      onClick={() =>
                        setRemoving((prev) => {
                          const already = prev[kind] ?? [];
                          return {
                            ...prev,
                            [kind]: already.includes(key.id)
                              ? already.filter((id) => id !== key.id)
                              : [...already, key.id],
                          };
                        })
                      }
                    >
                      {removing[kind]?.includes(key.id) ? 'undo' : '×'}
                    </button>
                  </div>
                ))}
                <input
                  type="password"
                  value={keys[kind] ?? ''}
                  placeholder={p?.keyCount ? 'add another key' : 'paste a key'}
                  onChange={(e) => setKeys((prev) => ({ ...prev, [kind]: e.target.value }))}
                />
              </div>
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
          A saved key is only used when its switch is on <em>and</em> the provider appears in the fallback
          order below. When every key of a provider is spent, the next provider in the order takes over.
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
        <h2>Deployment</h2>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          With a token saved, every finished goal is deployed for real and the goal page shows a link you can open.
          Without one the deploy step only describes what it would do, and the URL it reports leads nowhere. Create a
          token at <a href="https://vercel.com/account/tokens" target="_blank" rel="noreferrer noopener">vercel.com/account/tokens</a>{' '}
          — scope it to your own account; MegaAI uploads the delivery&apos;s source files and nothing else.
        </div>
        <div className="grid2">
          <div>
            <label>Vercel token {settings.deploy?.configured && <span style={{ color: 'var(--ok)' }}>· saved</span>}</label>
            <input
              type="password"
              value={vercelToken}
              placeholder={settings.deploy?.vercelToken || 'not set — deploys will be simulated'}
              onChange={(e) => setVercelToken(e.target.value)}
            />
          </div>
          <div>
            <label>Target</label>
            <select
              value={settings.deploy?.target ?? 'vercel'}
              onChange={(e) => setSettings({ ...settings, deploy: { ...settings.deploy, target: e.target.value } })}
            >
              <option value="vercel">vercel (live URL)</option>
              <option value="simulated">simulated (no deploy)</option>
            </select>
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
