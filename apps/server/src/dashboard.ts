/**
 * The MegaAI dashboard — a single self-contained HTML page served by the
 * API server. Polls /api/overview and tails /api/stream (SSE).
 */

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MegaAI Dashboard</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #131722; --panel2: #1a1f2e; --text: #e6e9f0;
    --muted: #8b93a7; --accent: #6ea8fe; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171;
    --border: #232a3b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 2; }
  header h1 { font-size: 16px; margin: 0; letter-spacing: 1px; }
  header .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 8px var(--ok); }
  header .spacer { flex: 1; }
  main { display: grid; grid-template-columns: repeat(12, 1fr); gap: 14px; padding: 16px 20px; max-width: 1400px; margin: 0 auto; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; overflow: hidden; }
  section h2 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--muted); }
  .col-4 { grid-column: span 4; } .col-6 { grid-column: span 6; } .col-8 { grid-column: span 8; } .col-12 { grid-column: span 12; }
  @media (max-width: 900px) { .col-4, .col-6, .col-8 { grid-column: span 12; } }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 13px; }
  th { color: var(--muted); font-weight: 500; }
  .bar { height: 7px; background: var(--panel2); border-radius: 4px; overflow: hidden; min-width: 90px; }
  .bar > i { display: block; height: 100%; background: var(--accent); border-radius: 4px; transition: width .4s; }
  .chip { display: inline-block; padding: 2px 9px; border-radius: 20px; font-size: 12px; border: 1px solid var(--border); margin: 2px 4px 2px 0; }
  .chip.ok { color: var(--ok); border-color: var(--ok); }
  .chip.off { color: var(--muted); }
  .chip.bad { color: var(--bad); border-color: var(--bad); }
  .stat { display: inline-block; margin-right: 18px; }
  .stat b { display: block; font-size: 20px; }
  .stat span { color: var(--muted); font-size: 12px; }
  #events, #logs { max-height: 320px; overflow-y: auto; font-size: 12px; }
  #events div, #logs div { padding: 2px 0; border-bottom: 1px dashed var(--panel2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #events .t, #logs .t { color: var(--muted); margin-right: 8px; }
  .goalbox { display: flex; gap: 8px; }
  .goalbox input { flex: 1; background: var(--panel2); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px; font: inherit; }
  button { background: var(--accent); color: #0b0e14; border: 0; border-radius: 8px; padding: 9px 16px; font: inherit; font-weight: 700; cursor: pointer; }
  button.ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); }
  button.small { padding: 4px 10px; font-size: 12px; }
  .status-completed { color: var(--ok); } .status-failed { color: var(--bad); } .status-active { color: var(--warn); }
  .empty { color: var(--muted); font-style: italic; padding: 8px 0; }
</style>
</head>
<body>
<header>
  <div class="dot" id="statusDot"></div>
  <h1>MEGA<span style="color:var(--accent)">AI</span></h1>
  <span style="color:var(--muted)" id="subtitle">autonomous delivery team</span>
  <div class="spacer"></div>
  <span class="chip off" id="pressureChip">pressure: …</span>
</header>
<main>
  <section class="col-12">
    <h2>New goal</h2>
    <div class="goalbox">
      <input id="goalInput" placeholder='e.g. "Build this client a complete ecommerce store"' />
      <button id="goalBtn">Run</button>
    </div>
  </section>

  <section class="col-8">
    <h2>Projects</h2>
    <div id="projects"><div class="empty">no projects yet — submit a goal above</div></div>
  </section>

  <section class="col-4">
    <h2>System</h2>
    <div id="stats"></div>
    <h2 style="margin-top:14px">Providers</h2>
    <div id="providers"></div>
    <h2 style="margin-top:14px">Resources</h2>
    <div id="resources" class="empty">sampling…</div>
  </section>

  <section class="col-6">
    <h2>Agents</h2>
    <div id="agents"><div class="empty">idle</div></div>
    <h2 style="margin-top:14px">Approvals</h2>
    <div id="approvals"><div class="empty">nothing pending</div></div>
  </section>

  <section class="col-6">
    <h2>Live events</h2>
    <div id="events"></div>
  </section>

  <section class="col-12">
    <h2>Learning (per agent)</h2>
    <div id="learning" class="empty">no outcomes recorded yet</div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

async function refresh() {
  try {
    const res = await fetch('/api/overview');
    const data = await res.json();
    $('statusDot').style.background = 'var(--ok)';

    const pressure = data.pressure ?? 'ok';
    const chip = $('pressureChip');
    chip.textContent = 'pressure: ' + pressure;
    chip.className = 'chip ' + (pressure === 'ok' ? 'ok' : pressure === 'elevated' ? '' : 'bad');

    const usage = data.aiUsage ?? {};
    $('stats').innerHTML =
      '<span class="stat"><b>' + (usage.requests ?? 0) + '</b><span>AI requests</span></span>' +
      '<span class="stat"><b>' + ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)) + '</b><span>tokens</span></span>' +
      '<span class="stat"><b>$' + Number(usage.estimatedCostUsd ?? 0).toFixed(3) + '</b><span>est. cost</span></span>';

    $('providers').innerHTML = (data.providers ?? []).map((p) =>
      '<span class="chip ' + (p.exhausted ? 'bad' : p.configured ? 'ok' : 'off') + '">' + esc(p.kind) +
      (p.exhausted ? ' ⌛' : p.configured ? '' : ' (no key)') + '</span>').join('') || '<div class="empty">none</div>';

    const r = data.resources;
    $('resources').innerHTML = r ?
      '<div>cpu load ' + Number(r.cpuLoad).toFixed(2) + ' × ' + r.cpuCount + ' cores</div>' +
      '<div class="bar" style="margin:4px 0"><i style="width:' + Math.min(100, r.memUsedPct) + '%"></i></div>' +
      '<div style="color:var(--muted)">mem ' + Math.round(r.memUsedPct) + '%' +
      (r.diskUsedPct != null ? ' · disk ' + Math.round(r.diskUsedPct) + '%' : '') + '</div>'
      : '<div class="empty">no sample yet</div>';

    const projects = data.projects ?? [];
    $('projects').innerHTML = projects.length === 0 ? '<div class="empty">no projects yet — submit a goal above</div>' :
      '<table><tr><th>Project</th><th>Status</th><th>Tasks</th><th style="width:130px">Progress</th></tr>' +
      projects.map((p) =>
        '<tr><td>' + esc(p.name) + '</td>' +
        '<td class="status-' + esc(p.status) + '">' + esc(p.status) + '</td>' +
        '<td>' + p.tasksCompleted + '/' + p.tasksTotal + (p.tasksFailed ? ' <span style="color:var(--bad)">(' + p.tasksFailed + ' failed)</span>' : '') + '</td>' +
        '<td><div class="bar"><i style="width:' + p.progress + '%"></i></div></td></tr>').join('') + '</table>';

    const agents = (data.agents ?? []).filter((a) => a.state === 'running' || a.state === 'paused');
    $('agents').innerHTML = agents.length === 0 ? '<div class="empty">idle</div>' :
      agents.map((a) => '<span class="chip ok">' + esc(a.kind) + ' · ' + esc(a.state) + '</span>').join('');

    const approvals = data.pendingApprovals ?? [];
    $('approvals').innerHTML = approvals.length === 0 ? '<div class="empty">nothing pending</div>' :
      approvals.map((a) =>
        '<div style="margin-bottom:8px">' + esc(a.description) +
        ' <button class="small" onclick="decide(\\'' + a.id + '\\', true)">approve</button> ' +
        '<button class="small ghost" onclick="decide(\\'' + a.id + '\\', false)">reject</button></div>').join('');

    const learning = data.learning ?? { byAgent: {} };
    const kinds = Object.keys(learning.byAgent ?? {});
    $('learning').innerHTML = kinds.length === 0 ? 'no outcomes recorded yet' :
      '<table><tr><th>Agent</th><th>Runs</th><th>Success</th><th>Avg duration</th></tr>' +
      kinds.map((k) => {
        const s = learning.byAgent[k];
        return '<tr><td>' + esc(k) + '</td><td>' + s.runs + '</td><td>' + Math.round(s.successRate * 100) + '%</td><td>' + s.avgDurationMs + 'ms</td></tr>';
      }).join('') + '</table>';
  } catch (err) {
    $('statusDot').style.background = 'var(--bad)';
  }
}

async function decide(id, approved) {
  await fetch('/api/approvals/' + id, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved }),
  });
  refresh();
}

$('goalBtn').addEventListener('click', async () => {
  const goal = $('goalInput').value.trim();
  if (!goal) return;
  $('goalBtn').disabled = true;
  await fetch('/api/goals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal }),
  });
  $('goalInput').value = '';
  $('goalBtn').disabled = false;
  refresh();
});

const eventsEl = $('events');
const source = new EventSource('/api/stream');
source.onmessage = (message) => {
  try {
    const event = JSON.parse(message.data);
    const div = document.createElement('div');
    const time = new Date(event.timestamp).toISOString().slice(11, 19);
    div.innerHTML = '<span class="t">' + time + '</span>' + esc(event.type);
    eventsEl.prepend(div);
    while (eventsEl.childElementCount > 200) eventsEl.lastChild.remove();
    if (event.type.startsWith('planning.') || event.type.startsWith('workflow.') || event.type.startsWith('orchestrator.')) refresh();
  } catch {}
};

refresh();
setInterval(refresh, 2500);
</script>
</body>
</html>
`;
