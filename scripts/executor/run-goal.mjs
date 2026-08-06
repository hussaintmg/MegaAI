#!/usr/bin/env node
/**
 * MegaAI cloud executor — runs inside a GitHub Actions runner.
 *
 * Fetches the goal + decrypted provider settings from the platform
 * (EXECUTOR_TOKEN), boots the full MegaAI engine, executes the goal with the
 * real providers, streams progress events back, and reports the final result
 * (report, files, usage). The workflow uploads the whole workspace as an
 * artifact afterwards.
 *
 * Env: PLATFORM_URL, EXECUTOR_TOKEN, GOAL_ID
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { collectContents, walkFiles } from './collect.mjs';
import { finalizeDelivery } from './finalize.mjs';
import process from 'node:process';

const PLATFORM_URL = (process.env.PLATFORM_URL ?? '').replace(/\/+$/, '');
const EXECUTOR_TOKEN = process.env.EXECUTOR_TOKEN ?? '';
const GOAL_ID = process.env.GOAL_ID ?? '';

if (!PLATFORM_URL || !EXECUTOR_TOKEN || !GOAL_ID) {
  console.error('executor: PLATFORM_URL, EXECUTOR_TOKEN and GOAL_ID are required');
  process.exit(2);
}

const headers = { authorization: `Bearer ${EXECUTOR_TOKEN}`, 'content-type': 'application/json' };
const api = (path) => `${PLATFORM_URL}/api/executor/goals/${GOAL_ID}${path}`;

// Progress events are posted without awaiting (so they never slow the run
// down), but every in-flight post is tracked here and drained before exit —
// otherwise process.exit would discard the last few task updates.
const pending = new Set();

function postEvent(event, message) {
  const promise = fetch(api('/events'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'event', event, message: String(message).slice(0, 900) }),
  })
    .catch((err) => console.error('executor: event post failed:', String(err)))
    .finally(() => pending.delete(promise));
  pending.add(promise);
  return promise;
}

async function drainEvents() {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

async function postFinal(payload) {
  const res = await fetch(api('/events'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'final', ...payload }),
  });
  if (!res.ok) console.error(`executor: final post failed (HTTP ${res.status})`);
}

async function main() {
  // 1. Pick up the job (goal + decrypted settings).
  const pickupRes = await fetch(api(''), { headers });
  if (!pickupRes.ok) {
    throw new Error(`could not fetch goal from platform (HTTP ${pickupRes.status})`);
  }
  const { goal, settings } = await pickupRes.json();
  console.log(`executor: goal = ${goal}`);
  await postEvent('engine', 'Booting the MegaAI engine on the runner');

  // Print exactly what the platform sent, before the engine touches it.
  // "gemini never answered" said nothing about the OpenRouter key that was
  // also saved — and there was no way to tell whether the platform failed to
  // send it, or the engine failed to use it. This line separates the two.
  const chain = Array.isArray(settings.fallbackChain) && settings.fallbackChain.length > 0
    ? settings.fallbackChain
    : ['(platform sent no fallback order — the engine default applies)'];
  const received = Object.entries(settings.providers ?? {}).map(([kind, p]) => {
    const inChain = chain.includes(kind);
    const flags = [
      p?.apiKey ? 'key' : 'NO KEY',
      p?.enabled === false ? 'OFF' : 'on',
      inChain ? 'in chain' : 'NOT IN CHAIN',
    ];
    return `${kind} [${flags.join(', ')}]`;
  });
  const keyed = Object.entries(settings.providers ?? {}).filter(([, p]) => p?.apiKey);
  const usable = keyed.filter(([kind, p]) => p?.enabled !== false && chain.includes(kind));
  const settingsLine =
    `Platform sent — order: ${chain.join(' → ')} · ` +
    (received.length > 0 ? received.join(' · ') : 'no provider settings at all');
  console.log(`executor: ${settingsLine}`);
  await postEvent('settings', settingsLine);

  // Name the mismatch rather than leaving it to be inferred from a later
  // failure: a saved key that is off, or missing from the order, is silent.
  for (const [kind, p] of keyed) {
    if (p?.enabled === false) {
      await postEvent('settings', `${kind} has a key but its switch is OFF in Settings — it will not be used.`);
    } else if (!chain.includes(kind)) {
      await postEvent(
        'settings',
        `${kind} has a key but is missing from the fallback order ("${chain.join(', ')}") — it will never be tried. Add it in Settings.`,
      );
    }
  }
  if (usable.length === 0) {
    await postEvent(
      'settings',
      keyed.length > 0
        ? 'Every saved key is either switched off or absent from the fallback order — this run has no usable provider.'
        : 'The platform sent no API keys at all. Save one under Settings, then run the goal again.',
    );
  }

  // 2. Boot the engine with the platform's provider settings.
  const sdkUrl = new URL('../../packages/sdk/dist/index.js', import.meta.url);
  const { createMegaAI, Events } = await import(sdkUrl.href);

  const providers = {};
  for (const [kind, p] of Object.entries(settings.providers ?? {})) {
    providers[kind] = {
      enabled: p.enabled !== false,
      ...(p.apiKey ? { apiKey: p.apiKey } : {}),
      ...(p.model ? { model: p.model } : {}),
      ...(p.requestsPerMinute ? { requestsPerMinute: p.requestsPerMinute } : {}),
    };
  }

  const megaai = createMegaAI({
    persistent: false,
    quiet: true,
    configOverrides: {
      ai: {
        ...(Object.keys(providers).length > 0 ? { providers } : {}),
        ...(Array.isArray(settings.fallbackChain) && settings.fallbackChain.length > 0
          ? { fallbackChain: settings.fallbackChain }
          : {}),
      },
      policy: { autoApprove: true },
      security: { allowShell: true, allowBrowser: true },
      meta: { planner: settings.planner === 'model' ? 'model' : 'template' },
      // A real deployment when a Vercel token is saved, so the goal ends with
      // a URL that opens. Without one every target simulates and the "URL" it
      // reports leads nowhere.
      deploy: {
        defaultTarget: settings.deploy?.vercelToken ? (settings.deploy.target || 'vercel') : 'simulated',
        vercelToken: settings.deploy?.vercelToken ?? '',
      },
      ...(settings.email?.from
        ? {
            comm: {
              email: {
                from: settings.email.from,
                to: settings.email.to ?? '',
                apiUrl: settings.email.apiUrl ?? '',
                apiKey: settings.email.apiKey ?? '',
                smtpHost: settings.email.smtpHost ?? '',
              },
            },
          }
        : {}),
    },
  });
  await megaai.start();

  // Say plainly when nothing is usable — a run with no provider fails on its
  // first task, and "mock only" would have hidden the actual cause.
  const configured = megaai.sessions
    .providerStatus()
    .filter((p) => p.configured && p.kind !== 'mock')
    .map((p) => p.kind);
  const providerLine =
    configured.length > 0
      ? `Providers ready: ${configured.join(', ')}`
      : 'No AI provider is configured — add an API key in Settings. This run can only produce placeholder scaffolding.';
  console.log(`executor: ${providerLine}`);
  await postEvent('providers', providerLine);

  // Say whether the trained vision models are actually running. onnxruntime is
  // an optional dependency, so a failed download of its native binary is
  // skipped in silence — and every audit then quietly falls back to the DOM.
  try {
    const modelsUrl = new URL('../../packages/models/dist/index.js', import.meta.url).href;
    const { defaultModelDirs, loadDeepModels } = await import(modelsUrl);
    // The same directory list the SDK will search, so "ready" here means the
    // audits will really find them.
    const models = await loadDeepModels(defaultModelDirs());
    const loaded = ['detector', 'screenClassifier', 'defectDetector'].filter((key) => models[key]);
    const visionLine = models.unavailable
      ? `Trained vision models are NOT running: ${models.unavailable}`
      : `Vision models ready: ${loaded.join(', ')}`;
    console.log(`executor: ${visionLine}`);
    await postEvent('vision', visionLine);
  } catch (err) {
    await postEvent('vision', `Could not check the vision models: ${err instanceof Error ? err.message : String(err)}`);
  }

  megaai.bus.on(Events.TaskUpdated, (event) => {
    const task = event.payload?.task;
    if (!task) return;
    if (task.state === 'in-progress') postEvent('task', `▶ ${task.title} (${task.agentKind})`);
    else if (task.state === 'completed') postEvent('task', `✔ ${task.title}`);
    else if (task.state === 'failed' || task.state === 'blocked') postEvent('task', `✖ ${task.title} (${task.state})`);
  });

  // 3. Run the goal.
  const result = await megaai.submitGoal(goal);
  // Flush queued progress events before the final report so the dashboard
  // timeline is complete and in order.
  await drainEvents();

  let report;
  const reportPath = join(result.workspaceDir, 'MEGAAI_REPORT.md');
  if (existsSync(reportPath)) report = readFileSync(reportPath, 'utf8');

  // Build it, photograph it and put it online — here, not inside an agent's
  // discretion. Leaving these to a model meant a run could finish with no
  // picture and no link and nothing saying why.
  const { PreviewRunner, VisionTester } = await import(
    new URL('../../packages/vision/dist/index.js', import.meta.url).href
  );
  const { collectDeployFiles, deployToVercel } = await import(
    new URL('../../packages/deploy/dist/index.js', import.meta.url).href
  );
  const finalLog = (event, message) => {
    console.log(`executor: ${message}`);
    return postEvent(event, message);
  };
  const finalized = await finalizeDelivery({
    workspaceDir: result.workspaceDir,
    vercelToken: settings.deploy?.vercelToken,
    log: finalLog,
    previewRunner: new PreviewRunner(
      { enabled: true, allowlist: ['node', 'npm', 'git', 'ls', 'cat'] },
      new VisionTester({ preferBrowser: true }),
    ),
    deploy: {
      collect: collectDeployFiles,
      run: deployToVercel,
      projectName: (goal || 'megaai-app')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 52) || 'megaai-app',
    },
  }).catch(async (err) => {
    await postEvent('finalize', `Could not finish the delivery: ${err instanceof Error ? err.message : String(err)}`);
    return { preview: undefined, deployment: undefined };
  });

  let deployment = finalized.deployment;
  // An agent may have recorded its own (usually simulated) deploy; only fall
  // back to it when the real one did not happen.
  if (!deployment) {
    const deployPath = join(result.workspaceDir, '.megaai-deploy.json');
    if (existsSync(deployPath)) {
      try {
        const record = JSON.parse(readFileSync(deployPath, 'utf8'));
        if (record?.url) {
          deployment = {
            url: String(record.url),
            target: String(record.target ?? ''),
            simulated: record.simulated !== false,
          };
        }
      } catch {
        // A malformed record is not worth failing the run over.
      }
    }
  }
  const usage = megaai.sessions.usage();

  // 4. Say who actually wrote this. A run where the mock served every request
  // still finishes every task and still reports "completed" — and hands back
  // generic scaffolding with the goal's words pasted into a <h1>. Reporting
  // that as a success is the bug behind "the run finished, so where is my
  // website?". A delivery nobody's model touched is not a delivery.
  // Walked after finalisation, so the screenshots it just took are included.
  const files = walkFiles(result.workspaceDir);
  const contents = collectContents(result.workspaceDir, files);

  const tallies = megaai.sessions.providerTallies();
  const real = tallies.filter((t) => t.kind !== 'mock');
  const mockRequests = tallies.find((t) => t.kind === 'mock')?.requests ?? 0;
  const mockOnly = usage.requests > 0 && real.length === 0;
  const servedBy = tallies.map((t) => `${t.kind} ×${t.requests}`).join(', ') || 'nobody';
  console.log(`executor: served by ${servedBy}`);
  await postEvent('providers', `Served by: ${servedBy}`);

  const failures = megaai.sessions.providerFailures().filter((f) => f.kind !== 'mock');
  for (const failure of failures) {
    console.log(`executor: ${failure.kind} refused (${failure.code}): ${failure.message}`);
    await postEvent('provider-failed', `${failure.kind} refused (${failure.code}): ${failure.message}`);
  }

  let placeholderError;
  if (mockOnly) {
    placeholderError =
      configured.length === 0
        ? `No AI provider answered, so all ${mockRequests} requests fell through to the built-in offline mock. ` +
          'These files are placeholder scaffolding, not the thing you asked for. ' +
          'Add a Gemini, OpenRouter or Groq API key in Settings and run the goal again.'
        : `Every request fell through to the offline mock — ${configured.join(', ')} never answered. ` +
          'These files are placeholder scaffolding, not the thing you asked for. ' +
          `Reason: ${failures.map((f) => `${f.kind}: ${f.message}`).join(' · ') || 'the key is set but the provider was skipped (disabled, rate-limited, or the model name is wrong).'}`;
    console.error(`executor: ${placeholderError}`);
  }

  // A delivery that does not build is not a delivery, whatever the tasks
  // reported. This is checked here because it is the only place that actually
  // ran `npm install` and the real build command.
  const buildStep = finalized.preview?.steps.find((step) => step.name === 'build' || step.name === 'install');
  const buildBroken = Boolean(buildStep && !buildStep.ok);
  if (buildBroken) {
    await postEvent(
      'build',
      `The delivered app does not ${buildStep.name === 'install' ? 'install' : 'build'} — reporting this run as failed.`,
    );
  }

  const ok = result.project.status === 'completed' && !mockOnly && !buildBroken;

  await postFinal({
    status: ok ? 'completed' : 'failed',
    report,
    files,
    contents,
    providers: tallies,
    ...(deployment ? { deployment } : {}),
    usage: { requests: usage.requests, tokens: usage.inputTokens + usage.outputTokens, costUsd: usage.estimatedCostUsd },
    ...(ok
      ? {}
      : {
          error:
            placeholderError ??
            (buildBroken
              ? `The delivered app does not ${buildStep.name === 'install' ? 'install' : 'build'}: ${(buildStep.output ?? '').slice(-800)}`
              : `project finished with status "${result.project.status}"`),
        }),
  });
  await drainEvents();

  await megaai.stop();
  console.log(
    `executor: done — reported ${ok ? 'completed' : 'failed'}` +
      (mockOnly ? ` (tasks all ran, but only the mock answered)` : '') +
      `, ${files.length} files`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err);
  // The stack goes to the workflow log — a bare "Invalid URL" with no frames
  // told us nothing about which setting was at fault.
  console.error('executor: fatal:', err instanceof Error ? (err.stack ?? message) : message);
  await drainEvents().catch(() => undefined);
  await postFinal({ status: 'failed', error: message }).catch(() => undefined);
  process.exit(1);
});
