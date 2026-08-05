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
    .filter((p) => p.configured)
    .map((p) => p.kind);
  await postEvent(
    'providers',
    configured.length > 0
      ? `Providers ready: ${configured.join(', ')}`
      : 'No AI provider is configured — add an API key in Settings, or enable the offline mock. This run will fail.',
  );

  megaai.bus.on(Events.TaskUpdated, (event) => {
    const task = event.payload?.task;
    if (!task) return;
    if (task.state === 'in-progress') postEvent('task', `▶ ${task.title} (${task.agentKind})`);
    else if (task.state === 'completed') postEvent('task', `✔ ${task.title}`);
    else if (task.state === 'failed' || task.state === 'blocked') postEvent('task', `✖ ${task.title} (${task.state})`);
  });

  // 3. Run the goal.
  const result = await megaai.submitGoal(goal);
  const ok = result.project.status === 'completed';
  // Flush queued progress events before the final report so the dashboard
  // timeline is complete and in order.
  await drainEvents();

  let report;
  const reportPath = join(result.workspaceDir, 'MEGAAI_REPORT.md');
  if (existsSync(reportPath)) report = readFileSync(reportPath, 'utf8');
  const files = walkFiles(result.workspaceDir);
  const usage = megaai.sessions.usage();

  await postFinal({
    status: ok ? 'completed' : 'failed',
    report,
    files,
    usage: { requests: usage.requests, tokens: usage.inputTokens + usage.outputTokens, costUsd: usage.estimatedCostUsd },
    ...(ok ? {} : { error: `project finished with status "${result.project.status}"` }),
  });

  await megaai.stop();
  console.log(`executor: done — ${result.project.status}, ${files.length} files`);
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('executor: fatal:', message);
  await drainEvents().catch(() => undefined);
  await postFinal({ status: 'failed', error: message }).catch(() => undefined);
  process.exit(1);
});
