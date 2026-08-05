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

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
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

function walkFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, base, out);
    else out.push(relative(base, full));
    if (out.length >= 300) return out;
  }
  return out.sort();
}

// The delivery itself, not just its table of contents. Without this the only
// copy of the work lives inside the Actions artifact zip and the dashboard can
// show nothing but filenames.
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 1_200 * 1024;

function isProbablyText(buffer) {
  // A NUL in the first few KB means binary in every text format we emit.
  const window = buffer.subarray(0, 4096);
  return !window.includes(0);
}

/** Read the delivered files back as text, smallest first, within the caps. */
function collectContents(root, paths) {
  const sized = [];
  for (const path of paths) {
    try {
      sized.push({ path, bytes: statSync(join(root, path)).size });
    } catch {
      // Vanished between the walk and now — nothing to send.
    }
  }
  // Smallest first, so a cap spends its budget on the most files rather than
  // on one big one. Source files are small; a stray asset should not crowd out
  // the index.html the user is actually looking for.
  sized.sort((a, b) => a.bytes - b.bytes);

  const contents = [];
  let total = 0;
  for (const { path, bytes } of sized) {
    if (total >= MAX_TOTAL_BYTES) break;
    let buffer;
    try {
      buffer = readFileSync(join(root, path));
    } catch {
      continue;
    }
    if (!isProbablyText(buffer)) {
      contents.push({ path, bytes, binary: true });
      continue;
    }
    const room = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total);
    const truncated = buffer.length > room;
    const text = buffer.subarray(0, room).toString('utf8');
    total += Buffer.byteLength(text, 'utf8');
    contents.push({ path, bytes, text, ...(truncated ? { truncated: true } : {}) });
  }
  contents.sort((a, b) => a.path.localeCompare(b.path));
  return contents;
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

  // 2. Boot the engine with the platform's provider settings.
  const sdkUrl = new URL('../../packages/sdk/dist/index.js', import.meta.url);
  const { createMegaAI, Events } = await import(sdkUrl.href);

  const providers = {};
  for (const [kind, p] of Object.entries(settings.providers ?? {})) {
    providers[kind] = {
      enabled: p.enabled !== false,
      ...(p.apiKey ? { apiKey: p.apiKey } : {}),
      ...(p.model ? { model: p.model } : {}),
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
  const files = walkFiles(result.workspaceDir);
  const contents = collectContents(result.workspaceDir, files);
  const usage = megaai.sessions.usage();

  // 4. Say who actually wrote this. A run where the mock served every request
  // still finishes every task and still reports "completed" — and hands back
  // generic scaffolding with the goal's words pasted into a <h1>. Reporting
  // that as a success is the bug behind "the run finished, so where is my
  // website?". A delivery nobody's model touched is not a delivery.
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

  const ok = result.project.status === 'completed' && !mockOnly;

  await postFinal({
    status: ok ? 'completed' : 'failed',
    report,
    files,
    contents,
    providers: tallies,
    usage: { requests: usage.requests, tokens: usage.inputTokens + usage.outputTokens, costUsd: usage.estimatedCostUsd },
    ...(ok
      ? {}
      : { error: placeholderError ?? `project finished with status "${result.project.status}"` }),
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
