/**
 * The MegaAI Settings page — a self-contained HTML page for entering provider
 * API keys, the fallback order and email delivery. Talks to GET/POST
 * /api/settings. Secrets are masked on load and stay on the machine.
 */

export const SETTINGS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MegaAI Settings</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #131722; --panel2: #1a1f2e; --text: #e6e9f0;
    --muted: #8b94a7; --border: #232838; --accent: #5b8cff; --ok: #38d39f; --off: #64708a; --warn: #f5a623;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--border); }
  h1 { font-size: 18px; margin: 0; letter-spacing: 1px; }
  a { color: var(--accent); text-decoration: none; }
  main { max-width: 820px; margin: 0 auto; padding: 20px; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 18px; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  .muted { color: var(--muted); }
  .row { display: grid; grid-template-columns: 120px 1fr 1fr 70px; gap: 10px; align-items: center; padding: 7px 0; border-bottom: 1px dashed var(--panel2); }
  .row:last-child { border-bottom: 0; }
  .head { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .5px; }
  label { display: block; margin: 8px 0 4px; color: var(--muted); font-size: 13px; }
  input[type=text], input[type=password] { width: 100%; background: var(--panel2); color: var(--text); border: 1px solid var(--border); border-radius: 7px; padding: 8px 10px; font: inherit; }
  input::placeholder { color: var(--off); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .status { font-size: 12px; }
  .set { color: var(--ok); } .unset { color: var(--off); }
  button { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 10px 18px; font: inherit; font-weight: 600; cursor: pointer; }
  button.ghost { background: transparent; border: 1px solid var(--border); color: var(--text); }
  .bar { display: flex; gap: 10px; align-items: center; margin-top: 6px; }
  #msg { margin-left: 10px; }
  .note { font-size: 12px; color: var(--muted); margin-top: 8px; }
  .chip { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); }
</style>
</head>
<body>
<header>
  <h1>MEGA<span style="color:var(--accent)">AI</span> · Settings</h1>
  <span class="muted">API keys · fallback · email</span>
  <div style="flex:1"></div>
  <a href="/">&larr; dashboard</a>
</header>
<main>
  <section>
    <h2>AI providers <span class="muted" style="font-weight:400">— keys are stored locally in .megaai/settings.json and never sent anywhere but the provider</span></h2>
    <div class="row"><div class="head">Provider</div><div class="head">Model</div><div class="head">API key</div><div class="head">On</div></div>
    <div id="providers"></div>
    <label>Fallback order (comma-separated) — tried left to right; the first configured one runs, the rest cover limits/outages</label>
    <input type="text" id="fallback" placeholder="gemini, openrouter, groq, mock" />
  </section>

  <section>
    <h2>Email delivery</h2>
    <div class="grid2">
      <div><label>From</label><input type="text" id="email_from" placeholder="MegaAI &lt;you@domain.com&gt;" /></div>
      <div><label>Default recipient</label><input type="text" id="email_to" placeholder="client@domain.com" /></div>
      <div><label>HTTP email API URL (SendGrid/Postmark-style)</label><input type="text" id="email_apiUrl" placeholder="https://api.provider.com/send" /></div>
      <div><label>API key (Bearer)</label><input type="password" id="email_apiKey" placeholder="not set" /></div>
      <div><label>or SMTP host (needs nodemailer)</label><input type="text" id="email_smtpHost" placeholder="smtp.gmail.com" /></div>
      <div style="align-self:end"><label><input type="checkbox" id="email_enabled" /> Enable email channel</label></div>
    </div>
  </section>

  <section>
    <h2>Deployment</h2>
    <div class="grid2">
      <div><label>Vercel token</label><input type="password" id="deploy_vercel" placeholder="not set" /></div>
      <div><label>Railway token</label><input type="password" id="deploy_railway" placeholder="not set" /></div>
    </div>
    <p class="note">Tokens are injected into the deploy command and redacted from all logs. Real deploys also need a shell to be enabled.</p>
  </section>

  <section>
    <h2>Autonomy</h2>
    <label><input type="checkbox" id="autoApprove" /> Auto-approve plans and gated actions (no human approval step)</label>
  </section>

  <div class="bar">
    <button id="save">Save &amp; apply</button>
    <button class="ghost" onclick="location.reload()">Reload</button>
    <span id="msg" class="muted"></span>
  </div>
  <p class="note">Saving restarts the engine so new keys take effect immediately. Without any key, MegaAI runs on the offline mock provider.</p>
</main>
<script>
var KINDS = ['anthropic', 'openai', 'gemini', 'openrouter', 'groq'];
var LABELS = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini', openrouter: 'OpenRouter', groq: 'Groq' };
var state = { settings: {}, status: {} };

function el(id) { return document.getElementById(id); }

function providerRow(kind) {
  var p = (state.settings.providers && state.settings.providers[kind]) || {};
  var configured = state.status[kind];
  var wrap = document.createElement('div');
  wrap.className = 'row';
  var name = document.createElement('div');
  name.innerHTML = '<strong>' + LABELS[kind] + '</strong><br><span class="status ' + (configured ? 'set' : 'unset') + '">' + (configured ? 'configured' : 'no key') + '</span>';
  var model = document.createElement('input'); model.type = 'text'; model.id = 'model_' + kind; model.value = p.model || ''; model.placeholder = 'default';
  var key = document.createElement('input'); key.type = 'password'; key.id = 'key_' + kind; key.placeholder = p.apiKey ? p.apiKey : 'not set';
  var on = document.createElement('input'); on.type = 'checkbox'; on.id = 'on_' + kind; on.checked = p.enabled !== false;
  wrap.appendChild(name); wrap.appendChild(model); wrap.appendChild(key); wrap.appendChild(on);
  return wrap;
}

function render() {
  var box = el('providers'); box.innerHTML = '';
  KINDS.forEach(function (k) { box.appendChild(providerRow(k)); });
  el('fallback').value = (state.settings.fallbackChain || []).join(', ');
  var e = state.settings.email || {};
  el('email_from').value = e.from || '';
  el('email_to').value = e.to || '';
  el('email_apiUrl').value = e.apiUrl || '';
  el('email_smtpHost').value = e.smtpHost || '';
  el('email_apiKey').placeholder = e.apiKey ? e.apiKey : 'not set';
  el('email_enabled').checked = !!e.enabled;
  var d = state.settings.deploy || {};
  el('deploy_vercel').placeholder = d.vercelToken ? d.vercelToken : 'not set';
  el('deploy_railway').placeholder = d.railwayToken ? d.railwayToken : 'not set';
  el('autoApprove').checked = !!(state.settings.policy && state.settings.policy.autoApprove);
}

function load() {
  fetch('/api/settings').then(function (r) { return r.json(); }).then(function (data) {
    state.settings = data.settings || {};
    state.status = {};
    (data.providerStatus || []).forEach(function (p) { state.status[p.kind] = p.configured; });
    render();
  });
}

function collect() {
  var providers = {};
  KINDS.forEach(function (k) {
    providers[k] = { enabled: el('on_' + k).checked, model: el('model_' + k).value.trim(), apiKey: el('key_' + k).value };
  });
  var fallback = el('fallback').value.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
  return {
    providers: providers,
    fallbackChain: fallback,
    email: {
      enabled: el('email_enabled').checked,
      from: el('email_from').value.trim(),
      to: el('email_to').value.trim(),
      apiUrl: el('email_apiUrl').value.trim(),
      apiKey: el('email_apiKey').value,
      smtpHost: el('email_smtpHost').value.trim()
    },
    deploy: { vercelToken: el('deploy_vercel').value, railwayToken: el('deploy_railway').value },
    policy: { autoApprove: el('autoApprove').checked }
  };
}

el('save').addEventListener('click', function () {
  el('msg').textContent = 'Saving and restarting the engine…';
  fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(collect()) })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.ok) { state.settings = data.settings || state.settings; var cfg = (data.configured || []); el('msg').textContent = cfg.length ? 'Saved — engine restarted. Active: ' + cfg.join(', ') : 'Saved — engine restarted.'; setTimeout(load, 500); }
      else { el('msg').textContent = 'Error: ' + (data.error || 'unknown'); }
    })
    .catch(function (err) { el('msg').textContent = 'Error: ' + err; });
});

load();
</script>
</body>
</html>`;
