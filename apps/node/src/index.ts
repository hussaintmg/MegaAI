#!/usr/bin/env node
/**
 * megaai-node — the agent for your own machine.
 *
 *   megaai-node run                    join the mesh and work
 *   megaai-node status                 what it can see right now
 *   megaai-node add "<task>" --project <dir> [--goal "<goal>"] [--urgent]
 *   megaai-node install [--dry-run]    make it start by itself at logon
 *   megaai-node uninstall              undo that
 *
 * With no `MEGAAI_MONGODB_URI` it keeps its queue in a file here, which is
 * enough to leave it running overnight on one laptop. Point it at a MongoDB
 * connection string and the same queue is shared with the phone and the cloud.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { BUILTIN_CODERS, CoderPool } from '@megaai/coders';
import { Mesh, type MeshStore, type MeshTask } from '@megaai/mesh';
import type { JsonObject } from '@megaai/types';
import { FileMeshStore } from '@megaai/mesh/file';
import {
  NodeAgent,
  ResourceGuard,
  StateFile,
  autostartPlan,
  coderLockKey,
  createCoderHandler,
  createProbe,
  createProcessLauncher,
  createSampler,
  detectCoders,
  listProjectFiles,
  openInEditor,
  parseGitStatus,
  type CoderTaskPayload,
} from '@megaai/node-agent';
import { loadNodeConfig, type NodeConfig } from './config.js';

const useColor = process.stdout.isTTY && !process.env['NO_COLOR'];
const paint = (code: string, text: string): string => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = (text: string) => paint('1', text);
const dim = (text: string) => paint('2', text);
const green = (text: string) => paint('32', text);
const yellow = (text: string) => paint('33', text);
const red = (text: string) => paint('31', text);

function say(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

async function openStore(config: NodeConfig): Promise<{ store: MeshStore; close: () => Promise<void>; where: string }> {
  if (!config.mongoUri) {
    const store = new FileMeshStore(config.queueFile, { onError: (message) => say(yellow(message)) });
    await store.open();
    return { store, close: () => store.flush(), where: config.queueFile };
  }

  // Only needed when a connection string is configured, so the driver stays
  // optional for someone running this on one laptop.
  const { MongoClient } = await import('mongodb');
  const { MongoMeshStore, ensureMeshIndexes, meshCollections } = await import('@megaai/mesh/mongo');
  const client = new MongoClient(config.mongoUri);
  await client.connect();
  const collections = meshCollections(client.db(config.dbName) as never);
  await ensureMeshIndexes(collections);
  return {
    store: new MongoMeshStore(collections),
    close: () => client.close(),
    where: `${config.dbName} on the shared database`,
  };
}

function buildAgent(config: NodeConfig, mesh: Mesh, log: (line: string) => void) {
  const probe = createProbe();
  const sample = createSampler({ probe });
  const guard = new ResourceGuard({ thresholds: config.thresholds });
  const pool = new CoderPool({ onEvent: (event) => log(event.message) });
  const found = detectCoders(BUILTIN_CODERS);
  pool.setInstalled(found.installed);

  const launcher = createProcessLauncher({ onKill: (pid, why) => log(`stopped process ${pid}: ${why}`) });
  const state = new StateFile(config.stateFile);

  const agent = new NodeAgent({
    mesh,
    name: config.name,
    kind: config.kind,
    capabilities: config.capabilities,
    guard,
    sample,
    state,
    tickMs: config.tickMs,
    log,
    lockKeyFor: (task: MeshTask) => coderLockKey(task.payload),
    handlers: {
      coder: createCoderHandler({
        pool,
        launcher,
        changedFiles: async (projectDir) => parseGitStatus(gitStatus(projectDir)),
        projectFiles: async (projectDir) => listProjectFiles(projectDir),
        onFinished: (payload) => {
          if (payload.openEditor && openInEditor(payload.projectDir)) {
            log(`opened ${payload.projectDir} in your editor`);
          }
        },
      }),
    },
  });

  return { agent, pool, guard, sample, found, probe };
}

function gitStatus(projectDir: string): string {
  const result = spawnSync('git', ['status', '--short'], { cwd: projectDir, encoding: 'utf8' });
  return result.stdout ?? '';
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

async function run(config: NodeConfig): Promise<void> {
  const stamp = () => dim(new Date().toISOString().slice(11, 19));
  const log = (line: string) => say(`${stamp()} ${line}`);

  const { store, close, where } = await openStore(config);
  const mesh = new Mesh({ store, onEvent: (event) => log(dim(event.message)) });
  const { agent, found } = buildAgent(config, mesh, log);

  const node = await agent.start();
  say(`${bold('MegaAI')} is running as ${bold(node.name)} — queue: ${where}`);
  say(
    found.installed.length > 0
      ? `Coding agents on this machine: ${green(found.installed.join(', '))}`
      : yellow('No coding agent found (claude, codex or opencode). Coding tasks will wait until one is installed.'),
  );
  for (const notice of config.notices) say(yellow(notice));
  say(dim('Leave this running. Ctrl-C puts anything in flight back on the queue.'));

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    say(`\n${signal} — putting work back on the queue…`);
    void agent
      .stop('this machine is shutting down')
      .then(close)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function status(config: NodeConfig): Promise<void> {
  const { store, close, where } = await openStore(config);
  const mesh = new Mesh({ store });
  const probe = createProbe();
  const sample = createSampler({ probe });
  const guard = new ResourceGuard({ thresholds: config.thresholds });
  const found = detectCoders(BUILTIN_CODERS);

  // One reading tells us nothing about CPU load; the second is the real one.
  sample();
  await new Promise((resolve) => setTimeout(resolve, 700));
  const reading = sample();
  const decision = guard.decide(reading);
  probe.stop();

  say(bold(`${config.name} — ${config.kind}`));
  say(`  queue        ${where}`);
  say(`  can do       ${config.capabilities.join(', ')}`);
  say(
    `  right now    ${decision.gear === 'full' ? green(decision.gear) : decision.gear === 'stop' ? red(decision.gear) : yellow(decision.gear)} — ${decision.reason}`,
  );
  say(
    `  machine      cpu ${Math.round(reading.cpuLoad * 100)}%, memory ${Math.round(reading.memUsedPct * 100)}%` +
      (reading.temperatureC !== undefined ? `, ${Math.round(reading.temperatureC)}°C` : ', temperature not readable') +
      (reading.batteryPct !== undefined ? `, battery ${Math.round(reading.batteryPct)}%` : '') +
      (reading.idleSeconds !== undefined ? `, idle ${Math.round(reading.idleSeconds)}s` : ', idle time not readable'),
  );
  say(
    `  coders       ${found.installed.length > 0 ? green(found.installed.join(', ')) : red('none installed — coding tasks will wait')}`,
  );

  const snapshot = await mesh.snapshot();
  say();
  say(bold('Queue'));
  const counts = Object.entries(snapshot.counts).filter(([, count]) => count > 0);
  say(`  ${counts.length > 0 ? counts.map(([state, count]) => `${count} ${state}`).join(', ') : 'nothing queued'}`);
  for (const task of snapshot.tasks.filter((entry) => entry.state === 'pending').slice(0, 10)) {
    const why = await mesh.explainWait(task.id);
    say(`  · ${task.title}${why ? dim(` — ${why}`) : ''}`);
  }
  say();
  say(bold('Nodes'));
  for (const entry of snapshot.nodes) {
    say(`  ${entry.online ? green('●') : dim('○')} ${entry.name} (${entry.kind}) — ${entry.gear}`);
  }
  await close();
}

async function add(config: NodeConfig, args: string[]): Promise<void> {
  const description = args.find((entry) => !entry.startsWith('--'));
  const projectDir = valueOf(args, '--project');
  if (!description || !projectDir) {
    say(red('Usage: megaai-node add "<what to do>" --project <folder> [--goal "<the bigger goal>"] [--urgent]'));
    process.exitCode = 1;
    return;
  }

  const resolved = path.resolve(projectDir);
  mkdirSync(resolved, { recursive: true });
  const { store, close, where } = await openStore(config);
  const mesh = new Mesh({ store });
  const payload: CoderTaskPayload = {
    kind: 'coder',
    goal: valueOf(args, '--goal') ?? description,
    task: description,
    projectDir: resolved,
    openEditor: args.includes('--open'),
  };
  const task = await mesh.enqueue({
    title: description,
    payload: payload as unknown as JsonObject,
    requires: ['shell'],
    urgent: args.includes('--urgent'),
  });
  await close();

  say(`${green('Queued')} "${task.title}" in ${resolved}`);
  say(dim(`It is in ${where}. Run "megaai-node run" (or leave it running) and it will be picked up.`));
}

function install(config: NodeConfig, args: string[]): void {
  const plan = autostartPlan({
    execPath: process.execPath,
    scriptPath: path.resolve(process.argv[1] ?? 'index.js'),
    args: ['run'],
    workingDir: process.cwd(),
    stateDir: config.stateDir,
  });

  say(bold(`Setting up MegaAI to start by itself (${plan.platform})`));
  for (const file of plan.files) say(dim(`  write ${file.path}`));
  for (const command of plan.commands) say(dim(`  ${command.command} ${command.args.join(' ')}`));

  if (args.includes('--dry-run')) {
    say(yellow('\n--dry-run: nothing was changed.'));
    return;
  }

  for (const file of plan.files) {
    mkdirSync(path.dirname(file.path), { recursive: true });
    // schtasks reads task XML as UTF-16; anything else is rejected outright.
    writeFileSync(file.path, file.contents, plan.platform === 'win32' ? 'utf16le' : 'utf8');
  }
  for (const command of plan.commands) {
    const result = spawnSync(command.command, command.args, { stdio: 'inherit' });
    if (result.status !== 0 && result.status !== null) {
      say(yellow(`  ${command.command} exited with ${result.status} — see above`));
    }
  }
  say(green(`\n${plan.summary}`));
  if (plan.removeCommand) {
    say(dim(`Undo with: megaai-node uninstall`));
  }
}

function uninstall(config: NodeConfig): void {
  const plan = autostartPlan({
    execPath: process.execPath,
    scriptPath: path.resolve(process.argv[1] ?? 'index.js'),
    stateDir: config.stateDir,
  });
  if (!plan.removeCommand) {
    say(yellow('Nothing to remove on this platform.'));
    return;
  }
  const result = spawnSync(plan.removeCommand.command, plan.removeCommand.args, { stdio: 'inherit' });
  say(result.status === 0 ? green('Removed. It will not start on its own again.') : yellow('It may already be gone.'));
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const [command = 'run', ...args] = process.argv.slice(2);
  const config = loadNodeConfig(process.env, process.platform, os.hostname());

  switch (command) {
    case 'run':
      await run(config);
      break;
    case 'status':
      await status(config);
      break;
    case 'add':
      await add(config, args);
      break;
    case 'install':
      install(config, args);
      break;
    case 'uninstall':
      uninstall(config);
      break;
    default:
      say(`Unknown command "${command}".`);
      say('Try: run · status · add · install · uninstall');
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  say(red(`\n${(error as Error).message}`));
  process.exitCode = 1;
});
