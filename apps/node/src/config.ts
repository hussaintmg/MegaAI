/**
 * What this machine is, and how careful it should be.
 *
 * Everything has a default that works, so `megaai-node run` does something
 * sensible with no configuration at all. Anything the machine gets wrong for
 * you — running too hot, taking too long to notice you have gone, running too
 * many builds at once — is turned down with an environment variable rather
 * than by editing code, because the person who needs to change it is the one
 * whose fan is loud.
 */

import path from 'node:path';
import type { Capability, NodeKind } from '@megaai/mesh';
import type { GuardThresholds } from '@megaai/node-agent';
import { defaultStateDir } from '@megaai/node-agent';

export interface NodeConfig {
  name: string;
  kind: NodeKind;
  capabilities: Capability[];
  stateDir: string;
  /** Where the queue lives when there is no shared database yet. */
  queueFile: string;
  stateFile: string;
  /** Set → the shared queue on MongoDB; unset → the local file. */
  mongoUri?: string;
  dbName: string;
  thresholds: Partial<GuardThresholds>;
  tickMs: number;
  /** Where new projects are created when a task does not name a folder. */
  workspaceDir: string;
  /** Warnings about the configuration itself — shown, never swallowed. */
  notices: string[];
}

const ALL_CAPABILITIES: Capability[] = [
  'shell',
  'browser',
  'gpu',
  'always-on',
  'sms',
  'whatsapp',
  'camera',
  'location',
  'email',
];

function readNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  notices: string[],
  bounds?: { min?: number; max?: number },
): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    notices.push(`${key} is "${raw}", which is not a number — ignoring it and using the default`);
    return undefined;
  }
  if (bounds?.min !== undefined && value < bounds.min) {
    notices.push(`${key} is ${value}, below the sensible minimum of ${bounds.min} — using ${bounds.min}`);
    return bounds.min;
  }
  if (bounds?.max !== undefined && value > bounds.max) {
    notices.push(`${key} is ${value}, above the sensible maximum of ${bounds.max} — using ${bounds.max}`);
    return bounds.max;
  }
  return value;
}

export function loadNodeConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  hostname = 'this machine',
): NodeConfig {
  const notices: string[] = [];
  const stateDir = env['MEGAAI_STATE_DIR'] ?? defaultStateDir(env, platform);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;

  const capabilities = (env['MEGAAI_CAPABILITIES'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean) as Capability[];
  const unknown = capabilities.filter((capability) => !ALL_CAPABILITIES.includes(capability));
  if (unknown.length > 0) {
    notices.push(
      `MEGAAI_CAPABILITIES lists ${unknown.join(', ')}, which nothing asks for — tasks will never be routed by them`,
    );
  }

  const thresholds: Partial<GuardThresholds> = {};
  const hotC = readNumber(env, 'MEGAAI_HOT_C', notices, { min: 50, max: 105 });
  if (hotC !== undefined) {
    thresholds.hotC = hotC;
    // Leaving `coolC` at its default while lowering `hotC` below it would mean
    // "stop above 60, resume above 72" — a machine that never restarts.
    thresholds.coolC = Math.min(hotC - 5, 72);
  }
  const idle = readNumber(env, 'MEGAAI_IDLE_SECONDS', notices, { min: 10, max: 3_600 });
  if (idle !== undefined) thresholds.idleAfterSeconds = idle;
  const maxTasks = readNumber(env, 'MEGAAI_MAX_TASKS', notices, { min: 1, max: 8 });
  if (maxTasks !== undefined) thresholds.fullConcurrency = maxTasks;
  const lowBattery = readNumber(env, 'MEGAAI_LOW_BATTERY_PCT', notices, { min: 0, max: 90 });
  if (lowBattery !== undefined) thresholds.lowBatteryPct = lowBattery;

  const mongoUri = env['MEGAAI_MONGODB_URI'] ?? env['MONGODB_URI'];
  if (!mongoUri) {
    notices.push(
      'no MEGAAI_MONGODB_URI is set, so the queue lives in a file on this machine only — set one to share it with the phone and the cloud',
    );
  }

  return {
    name: env['MEGAAI_NODE_NAME'] ?? hostname,
    kind: (env['MEGAAI_NODE_KIND'] as NodeKind) ?? 'laptop',
    capabilities: capabilities.length > 0 ? capabilities : ['shell', 'browser', 'gpu', 'whatsapp'],
    stateDir,
    queueFile: join(stateDir, 'queue.json'),
    stateFile: join(stateDir, 'node.json'),
    ...(mongoUri ? { mongoUri } : {}),
    dbName: env['MEGAAI_DB_NAME'] ?? 'megaai',
    thresholds,
    tickMs: readNumber(env, 'MEGAAI_TICK_MS', notices, { min: 1_000, max: 120_000 }) ?? 5_000,
    workspaceDir: env['MEGAAI_WORKSPACE'] ?? join(stateDir, 'projects'),
    notices,
  };
}
