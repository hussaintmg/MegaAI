#!/usr/bin/env node
/**
 * megaai-node — the agent for your own machine.
 *
 *   megaai-node run                    join the mesh and work
 *   megaai-node status                 what it can see right now
 *   megaai-node tasks                  everything in the queue, with ids
 *   megaai-node plan "<goal>" --project <dir>   plan it properly, then build it in parallel
 *   megaai-node add "<task>" --project <dir> [--goal "<goal>"] [--interactive] [--urgent]
 *   megaai-node gui --project <dir> [--coder codex --prompt "…"] [--dry-run]
 *   megaai-node retry <id|title>|--all queue a failed task again, as it was
 *   megaai-node cancel <id|title>      take one off the queue
 *   megaai-node set KEY VALUE          remember a setting across restarts
 *   megaai-node install [--dry-run]    make it start by itself at logon
 *   megaai-node uninstall              undo that
 *
 * With no `MEGAAI_MONGODB_URI` it keeps its queue in a file here, which is
 * enough to leave it running overnight on one laptop. Point it at a MongoDB
 * connection string and the same queue is shared with the phone and the cloud.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  createGuiHandler,
  createPlanHandler,
  lockKeysCollide,
  createProbe,
  createProcessLauncher,
  createSampler,
  defaultStateDir,
  detectCoders,
  listProjectFiles,
  openInEditor,
  parseGitStatus,
  planGuiSteps,
  renderGuiScript,
  type CoderTaskPayload,
  type GuiStep,
  type GuiTaskPayload,
} from '@megaai/node-agent';
import { checkProjectDir, loadNodeConfig, type NodeConfig } from './config.js';
import { createThinker } from './thinker.js';
import { envFilePath, loadEnvFile, maskValue, parseEnv, writeEnvFile } from './env.js';
import { explainMongoFailure, type MongoTrouble } from './mongo-trouble.js';

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

interface OpenedStore {
  store: MeshStore;
  close: () => Promise<void>;
  where: string;
  /** Set when the shared queue was wanted but could not be reached. */
  degraded?: MongoTrouble;
}

async function openLocalStore(config: NodeConfig): Promise<OpenedStore> {
  const store = new FileMeshStore(config.queueFile, { onError: (message) => say(yellow(message)) });
  await store.open();
  return { store, close: () => store.flush(), where: config.queueFile };
}

/**
 * Open the queue — the shared one if it is reachable, this machine's own if
 * it is not.
 *
 * The database being unreachable must never stop the agent. A laptop that
 * refuses to work because a cluster in another country is having a bad evening
 * is precisely the panic this whole system exists to avoid: the coding agents
 * are here, the projects are here, and the night can happen without Atlas.
 * What it must not do is pretend — so the fall back is announced, with what
 * went wrong and what fixes it.
 */
async function openStore(config: NodeConfig): Promise<OpenedStore> {
  if (!config.mongoUri) return openLocalStore(config);

  try {
    // Only imported when a connection string is configured, so the driver
    // stays optional for someone running this on one laptop.
    const { MongoClient } = await import('mongodb');
    const { MongoMeshStore, ensureMeshIndexes, meshCollections } = await import('@megaai/mesh/mongo');
    const client = new MongoClient(config.mongoUri, {
      // The default is 30 seconds of silence before it admits anything is
      // wrong, which reads as a hang rather than a problem.
      serverSelectionTimeoutMS: 8_000,
      connectTimeoutMS: 8_000,
    });
    await client.connect();
    const collections = meshCollections(client.db(config.dbName) as never);
    await ensureMeshIndexes(collections);
    return {
      store: new MongoMeshStore(collections),
      close: () => client.close(),
      where: `${config.dbName} on the shared database`,
    };
  } catch (error) {
    const local = await openLocalStore(config);
    return { ...local, degraded: explainMongoFailure(error, config.mongoUri) };
  }
}

/** Say what went wrong with the shared queue, and what to do about it. */
function reportTrouble(trouble: MongoTrouble, queueFile: string): void {
  say(yellow(`The shared queue is not reachable: ${trouble.summary}`));
  say(`Working from this machine's own queue instead (${queueFile}) — nothing stops.`);
  say(trouble.transient ? dim('If this is the network, it will work again as soon as it comes back.') : '');
  say(bold('To fix it:'));
  for (const fix of trouble.fixes) say(`  · ${fix}`);
  say();
}

function buildAgent(config: NodeConfig, mesh: Mesh, log: (line: string) => void) {
  const probe = createProbe();
  const sample = createSampler({ probe });
  const guard = new ResourceGuard({ thresholds: config.thresholds });
  const pool = new CoderPool({ onEvent: (event) => log(event.message) });
  const found = detectCoders(BUILTIN_CODERS);
  pool.setInstalled(found.installed);

  const launcher = createProcessLauncher({
    onKill: (pid, why) => log(`stopped process ${pid}: ${why}`),
    onNote: (message) => log(yellow(message)),
  });
  const state = new StateFile(config.stateFile);

  const thinker = createThinker();

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
    // The keys are paths, so `app/api` and `app/api/cars/route.ts` have to be
    // recognised as the same place. String equality would let both run.
    lockConflict: lockKeysCollide,
    // Planning uses a model in the cloud and a few kilobytes here. Making it
    // queue behind two builds would mean a busy machine stops handing out work
    // at exactly the moment there is most of it to hand out.
    lightweight: (task: MeshTask) => task.payload['kind'] === 'plan',
    // Heat and CPU say what the machine could take; the coding agents say what
    // it can actually do. Two out of quota and one broken means one.
    capacity: () => Math.max(1, pool.available().length),
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
      plan: createPlanHandler({
        mesh,
        think: (prompt) => thinker.think(prompt),
        listFiles: (projectDir) => listProjectFiles(projectDir, { limit: 150 }),
        coders: () => pool.available().map((spec) => spec.name),
        // A goal typed on a phone cannot name a folder on a laptop it has
        // never seen, so the machine that picks it up decides — named after
        // the goal, because a workspace of `project-1`, `project-2` is
        // unreadable a week later.
        resolveProjectDir: (goal) => path.join(config.workspaceDir, folderNameFor(goal)),
        ensureDir: (dir) => mkdirSync(dir, { recursive: true }),
      }),
      gui: createGuiHandler({
        scratchDir: config.stateDir,
        writeFile: (file, contents) => writeFileSync(file, contents, { encoding: 'utf8' }),
        run: async (file, args) => launcher(file, args, config.workspaceDir),
      }),
    },
  });

  return { agent, pool, guard, sample, found, probe, thinker };
}

/** Give the machine probe a chance to say something before judging it silent. */
async function waitForProbe(probe: { latest: () => Record<string, unknown> }, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (Object.keys(probe.latest()).length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return Object.keys(probe.latest()).length > 0;
}

/** Break a long error across lines so a terminal does not swallow the end. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let current = '';
    for (const word of paragraph.split(/\s+/)) {
      if (current && current.length + word.length + 1 > width) {
        lines.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/** Where MegaAI itself lives — `apps/node/dist/index.js` is three deep. */
function megaaiRoot(): string {
  return path.resolve(path.dirname(path.resolve(process.argv[1] ?? '.')), '..', '..', '..');
}

/** A folder name from a sentence: short, lowercase, and safe on Windows. */
export function folderNameFor(goal: string): string {
  const words = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    // "build me a website that…" — the first few words are never the subject.
    .filter((word) => !['build', 'make', 'create', 'me', 'a', 'an', 'the', 'my', 'please'].includes(word))
    .slice(0, 4);
  return words.join('-') || 'project';
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

  const opened = await openStore(config);
  const { store, close, where } = opened;
  const mesh = new Mesh({ store, onEvent: (event) => log(dim(event.message)) });
  const { agent, found, probe } = buildAgent(config, mesh, log);

  // Wait for the machine probe before the first reading, for the same reason
  // `status` does: on Windows it is a PowerShell that compiles a P/Invoke
  // before its first line, so starting immediately makes the opening log line
  // announce "this machine cannot report idle time" on a machine that reports
  // it perfectly well ten seconds later. It corrects itself, but the first
  // thing you read should not be wrong.
  if (!(await waitForProbe(probe, 20_000))) {
    // Not final: the probe keeps trying, and the very next reading uses it if
    // it arrives. Saying "falling back" without that reads as a verdict.
    log(dim('the machine probe has not reported yet — judging activity by CPU load until it does'));
  }

  const node = await agent.start();
  say(`${bold('MegaAI')} is running as ${bold(node.name)}`);
  say(`Queue: ${where}`);
  if (opened.degraded) reportTrouble(opened.degraded, config.queueFile);
  else if (!config.mongoUri) {
    // Not a failure — a local queue is a perfectly good way to run one laptop.
    // It only needs saying because the dashboard reads the shared one, so
    // without this the website looks broken rather than pointed elsewhere.
    say(
      dim(
        'This queue is on this machine only, so the website cannot see it. To share it, run once:\n' +
          '  megaai-node set MEGAAI_MONGODB_URI "<the same connection string the website uses>"',
      ),
    );
  }
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
  const opened = await openStore(config);
  const { store, close, where } = opened;
  const mesh = new Mesh({ store });
  const probe = createProbe();
  const sample = createSampler({ probe });
  const guard = new ResourceGuard({ thresholds: config.thresholds });
  const found = detectCoders(BUILTIN_CODERS);

  // One reading tells us nothing about CPU load; the second is the real one.
  sample();
  // And on Windows the probe is a PowerShell that has to compile a P/Invoke
  // before its first line — a fixed short wait reports "idle time not
  // readable" on a machine that reads it perfectly well, which is a lie about
  // the one signal the gear depends on.
  const probeAnswered = await waitForProbe(probe, 12_000);
  const reading = sample();
  const decision = guard.decide(reading);
  probe.stop();

  say(bold(`${config.name} — ${config.kind}`));
  say(`  queue        ${where}`);
  if (opened.degraded) {
    say(red(`               the shared queue is not reachable: ${opened.degraded.summary}`));
    for (const fix of opened.degraded.fixes) say(dim(`               · ${fix}`));
  } else if (!config.mongoUri) {
    say(dim('               on this machine only — the website reads the shared queue, not this file'));
    say(dim('               megaai-node set MEGAAI_MONGODB_URI "<the string the website uses>"'));
  }
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
  if (!probeAnswered) {
    say(
      yellow(
        '  probe        nothing reported in 12s — this machine cannot tell whether you are at the keyboard,\n' +
          '               so the agent falls back to judging by CPU load. That works; it is just less exact.',
      ),
    );
  }

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
    say(red('Usage: megaai-node add "<what to do>" --project <folder> [--goal "<the bigger goal>"] [--interactive] [--urgent]'));
    process.exitCode = 1;
    return;
  }

  // Checked *before* mkdir: creating the folder first is what turned a mangled
  // path into a real directory nobody asked for.
  const check = checkProjectDir(projectDir, megaaiRoot());
  if (!check.ok) {
    say(red(check.error ?? 'that project folder cannot be used'));
    process.exitCode = 1;
    return;
  }
  const resolved = check.resolved;
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
  // Interactive means "needs the mouse, keyboard or screen" — the only kind of
  // work that has to wait while you are using the machine. Everything else
  // runs regardless, because a background process does not disturb anyone.
  const interactive = args.includes('--interactive');
  const task = await mesh.enqueue({
    title: description,
    payload: payload as unknown as JsonObject,
    requires: ['shell'],
    interactive,
    urgent: args.includes('--urgent'),
  });
  await close();

  say(`${green('Queued')} "${task.title}" in ${resolved}`);
  if (interactive) {
    say(dim('It needs the screen, so it waits until you step away from the machine (--urgent overrides that).'));
  }
  say(dim(`It is in ${where}. Run "megaai-node run" (or leave it running) and it will be picked up.`));
}

/**
 * Hand over a goal rather than a task.
 *
 * The difference is the whole point: `add` gives one instruction to one coding
 * agent, `plan` gives a sentence to a planner that works out what the thing
 * actually needs — backend, frontend, database, security, look, motion — and
 * then keeps Claude Code, Codex and OpenCode busy on it in parallel until it
 * is finished.
 */
async function plan(config: NodeConfig, args: string[]): Promise<void> {
  const goal = args.find((entry) => !entry.startsWith('--'));
  const projectDir = valueOf(args, '--project');
  if (!goal || !projectDir) {
    say(red('Usage: megaai-node plan "<what to build>" --project <folder> [--parallel 3] [--verify "npm run build"]'));
    process.exitCode = 1;
    return;
  }

  const check = checkProjectDir(projectDir, megaaiRoot());
  if (!check.ok) {
    say(red(check.error ?? 'that project folder cannot be used'));
    process.exitCode = 1;
    return;
  }

  const thinker = createThinker();
  const parallel = Number(valueOf(args, '--parallel') ?? '3');
  mkdirSync(check.resolved, { recursive: true });
  const { store, close, where } = await openStore(config);
  const mesh = new Mesh({ store });
  const task = await mesh.enqueue({
    title: `Plan and build: ${goal}`.slice(0, 300),
    requires: ['shell'],
    payload: {
      kind: 'plan',
      goal,
      projectDir: check.resolved,
      maxParallel: Number.isFinite(parallel) ? Math.max(1, Math.trunc(parallel)) : 3,
      ...(valueOf(args, '--verify') ? { verifyCommand: valueOf(args, '--verify') } : {}),
    } as JsonObject,
  });
  await close();

  say(`${green('Queued')} "${task.title}"`);
  say(dim(`Planning with: ${thinker.describe()}`));
  say(dim('The plan decides the work; Claude Code, Codex and OpenCode write every line of it.'));
  say(dim(`It is in ${where}. Run "megaai-node run" (or leave it running) and it will start.`));
}

/**
 * Work that has to happen on screen.
 *
 * `--dry-run` prints the steps and the script without touching the mouse,
 * because the first thing anyone sensibly wants to know about a program that
 * drives their keyboard is exactly what it is going to press.
 */
async function gui(config: NodeConfig, args: string[]): Promise<void> {
  const projectDir = valueOf(args, '--project');
  const command = valueOf(args, '--coder');
  const prompt = valueOf(args, '--prompt');
  if (!projectDir) {
    say(red('Usage: megaai-node gui --project <folder> [--coder codex --prompt "<brief>"] [--urgent] [--dry-run]'));
    say(dim('With no --coder it opens the folder in VS Code; with one it opens that agent inside the editor.'));
    process.exitCode = 1;
    return;
  }
  const check = checkProjectDir(projectDir, megaaiRoot());
  if (!check.ok) {
    say(red(check.error ?? 'that project folder cannot be used'));
    process.exitCode = 1;
    return;
  }

  const payload: GuiTaskPayload = {
    kind: 'gui',
    action: command ? 'coder' : 'editor',
    projectDir: check.resolved,
    ...(command ? { command } : {}),
    ...(prompt ? { prompt } : {}),
  };

  if (args.includes('--dry-run')) {
    const planned = planGuiSteps(payload, path.join(config.stateDir, 'gui-preview.prompt.txt'));
    if (planned.error) {
      say(red(planned.error));
      process.exitCode = 1;
      return;
    }
    say(bold('It would do this, in order:'));
    for (const [index, step] of planned.steps.entries()) {
      say(`  ${String(index + 1).padStart(2)}. ${describeStep(step)}`);
    }
    say();
    say(dim('The PowerShell it renders to:'));
    say(dim(renderGuiScript(planned.steps)));
    return;
  }

  const { store, close, where } = await openStore(config);
  const mesh = new Mesh({ store });
  const task = await mesh.enqueue({
    title: command ? `Open ${command} in VS Code on ${check.resolved}` : `Open ${check.resolved} in VS Code`,
    requires: ['shell', 'browser'],
    // It takes over the mouse and the keyboard, so it waits until you are not
    // using the machine — unless you say you want it now.
    interactive: true,
    urgent: args.includes('--urgent'),
    payload: payload as unknown as JsonObject,
  });
  await close();

  say(`${green('Queued')} "${task.title}"`);
  say(dim('It drives the real mouse and keyboard, so it waits until you step away (--urgent overrides that).'));
  say(dim(`It is in ${where}.`));
}

function describeStep(step: GuiStep): string {
  switch (step.do) {
    case 'launch':
      return `start ${step.file}${step.args?.length ? ` ${step.args.join(' ')}` : ''}`;
    case 'focus':
      return `wait for the window called "…${step.titleContains}…" and bring it to the front`;
    case 'move':
      return `move the pointer to ${step.x},${step.y}`;
    case 'click':
      return `${step.double ? 'double-' : ''}${step.button ?? 'left'} click${
        step.x !== undefined ? ` at ${step.x},${step.y}` : ' where the pointer is'
      }`;
    case 'keys':
      return `press ${step.keys}`;
    case 'type':
      return `type ${JSON.stringify(step.text)}`;
    case 'paste':
      return `paste the brief from ${step.path}`;
    case 'wait':
      return `wait ${step.ms}ms`;
  }
}

async function tasks(config: NodeConfig): Promise<void> {
  const { store, close } = await openStore(config);
  const mesh = new Mesh({ store });
  const all = await store.listTasks();
  if (all.length === 0) {
    say(dim('Nothing in the queue.'));
    await close();
    return;
  }
  for (const task of all) {
    const mark =
      task.state === 'completed' ? green('✓') : task.state === 'failed' ? red('✗') : task.state === 'cancelled' ? dim('–') : yellow('·');
    say(`${mark} ${dim(task.id)}  ${task.title}  ${dim(`(${task.state})`)}`);

    if (task.state === 'pending') {
      const why = await mesh.explainWait(task.id);
      if (why) say(dim(`           ${why}`));
    }

    // A failed task's error is the single most useful line on this screen —
    // it is the whole reason you came to look — and it was not being shown at
    // all, so eight failures looked identical to eight mysteries.
    if (task.state === 'failed' && task.error) {
      for (const line of wrap(task.error, 92)) say(red(`           ${line}`));
      say(dim(`           gave up after ${task.attempts} of ${task.maxAttempts} attempts`));
    }
    if (task.state === 'completed' && task.result) {
      const by = task.result['finishedBy'];
      const handoffs = Number(task.result['handoffs'] ?? 0);
      if (typeof by === 'string') {
        say(dim(`           finished by ${by}${handoffs > 0 ? ` after ${handoffs} handoff(s)` : ''}`));
      }
    }
  }

  const failed = all.filter((task) => task.state === 'failed');
  if (failed.length > 0) {
    say();
    say(yellow(`${failed.length} task(s) failed. Their errors are above — that is what to fix.`));
    say(dim('Put them back with: megaai-node retry --all  (or retry <id> for one)'));
  }
  say();
  say(dim('Remove one with: megaai-node cancel <id or part of the title>'));
  await close();
}

async function cancel(config: NodeConfig, args: string[]): Promise<void> {
  const needle = args.find((entry) => !entry.startsWith('--'));
  if (!needle) {
    say(red('Usage: megaai-node cancel <id or part of the title>'));
    process.exitCode = 1;
    return;
  }

  const { store, close } = await openStore(config);
  const mesh = new Mesh({ store });
  const open = (await store.listTasks()).filter((task) => task.state !== 'completed' && task.state !== 'cancelled');
  const matches = open.filter((task) => task.id.startsWith(needle) || task.title.includes(needle));

  if (matches.length === 0) {
    say(yellow(`Nothing open matches "${needle}". Run "megaai-node tasks" to see what is there.`));
    process.exitCode = 1;
  } else if (matches.length > 1) {
    // Cancelling the wrong task silently is worse than asking again.
    say(yellow(`"${needle}" matches ${matches.length} tasks — be more specific:`));
    for (const task of matches) say(`  ${dim(task.id)}  ${task.title}`);
    process.exitCode = 1;
  } else {
    const task = matches[0]!;
    await mesh.cancel(task.id, 'cancelled from the command line');
    say(`${green('Cancelled')} "${task.title}"`);
  }
  await close();
}

/**
 * Remember a setting for every future run.
 *
 * This exists because `$env:MEGAAI_MONGODB_URI = "..."` lasts exactly as long
 * as the PowerShell you typed it in, and the Scheduled Task starts with no
 * shell at all — so the one place people naturally put it is the one place it
 * cannot be read from.
 */
/**
 * Queue a failed task again, exactly as it was.
 *
 * A failed task is deliberately not retried on its own — three attempts at
 * something genuinely broken is enough, and an endless loop is worse than a
 * stop. But when the *machine* was at fault rather than the work, re-typing
 * eight two-thousand-character briefs by hand is not a reasonable thing to ask
 * of anyone, and copying them back out of a JSON file by hand is worse.
 */
async function retry(config: NodeConfig, args: string[]): Promise<void> {
  const all = args.includes('--all');
  const needle = args.find((entry) => !entry.startsWith('--'));
  if (!all && !needle) {
    say(red('Usage: megaai-node retry <id or part of the title>   |   megaai-node retry --all'));
    process.exitCode = 1;
    return;
  }

  const { store, close } = await openStore(config);
  const mesh = new Mesh({ store });
  const failed = (await store.listTasks()).filter((task) => task.state === 'failed');
  const chosen = all ? failed : failed.filter((task) => task.id.startsWith(needle!) || task.title.includes(needle!));

  if (chosen.length === 0) {
    say(yellow(all ? 'Nothing has failed.' : `No failed task matches "${needle}".`));
    process.exitCode = 1;
  } else {
    for (const task of chosen) {
      // A fresh task rather than a reset one: the old attempt is part of what
      // happened, and rewriting history to hide it would be a lie about the
      // night. The checkpoint travels, so a coder handoff resumes rather than
      // starting the work again.
      const queued = await mesh.enqueue({
        title: task.title,
        payload: task.payload,
        requires: task.requires,
        interactive: task.interactive,
        urgent: task.urgent,
      });
      if (task.checkpoint) await store.putTask({ ...queued, checkpoint: task.checkpoint });
      say(`${green('Queued again')} ${dim(queued.id)}  ${task.title.slice(0, 70)}${task.title.length > 70 ? '…' : ''}`);
    }
    say();
    say(dim(`${chosen.length} task(s) back on the queue. Run "megaai-node run" and leave the machine.`));
  }
  await close();
}

function setSetting(config: NodeConfig, args: string[]): void {
  const file = envFilePath(config.stateDir);
  const [key, ...rest] = args;
  const value = rest.join(' ').trim();

  if (!key) {
    const saved = parseEnv(existsSync(file) ? readFileSync(file, 'utf8') : '');
    say(bold('Saved settings'));
    say(dim(file));
    if (saved.length === 0) {
      say(dim('  nothing saved yet'));
    } else {
      for (const entry of saved) say(`  ${entry.key} = ${maskValue(entry.key, entry.value)}`);
    }
    say();
    say(dim('Set one with:  megaai-node set MEGAAI_MONGODB_URI "mongodb+srv://…"'));
    say(dim('Remove one with an empty value:  megaai-node set MEGAAI_MONGODB_URI ""'));
    return;
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    say(red(`"${key}" is not a settings name. They look like MEGAAI_MONGODB_URI.`));
    process.exitCode = 1;
    return;
  }

  // Checked here rather than at the next `run`, because a connection string
  // pasted with the placeholder still in it is the single most common way this
  // goes wrong, and finding out hours later is the expensive part.
  if (key === 'MEGAAI_MONGODB_URI' && value) {
    if (!/^mongodb(\+srv)?:\/\//.test(value)) {
      say(red('That does not look like a MongoDB connection string — it should start with mongodb:// or mongodb+srv://'));
      process.exitCode = 1;
      return;
    }
    if (/<password>|<db_password>|<username>/i.test(value)) {
      say(red('That connection string still has a <password> placeholder in it. Replace it with the real password first.'));
      process.exitCode = 1;
      return;
    }
  }

  writeEnvFile(file, key, value);
  if (value) {
    say(`${green('Saved')} ${key} = ${maskValue(key, value)}`);
    say(dim(`in ${file} — every run from now on uses it, including the Scheduled Task.`));
    if (key === 'MEGAAI_MONGODB_URI') {
      say(dim('Check it worked with: megaai-node status — the queue line should name the database, not a file.'));
    }
  } else {
    say(`${green('Removed')} ${key}`);
  }
}

function install(config: NodeConfig, args: string[]): void {
  const domain = process.env['USERDOMAIN'];
  const user = process.env['USERNAME'];
  const plan = autostartPlan({
    execPath: process.execPath,
    scriptPath: path.resolve(process.argv[1] ?? 'index.js'),
    args: ['run'],
    workingDir: process.cwd(),
    stateDir: config.stateDir,
    ...(user ? { userId: domain ? `${domain}\\${user}` : user } : {}),
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
    // The byte-order mark is what tells schtasks the file is UTF-16 at all.
    // Without it, it reads the bytes as ANSI and rejects the task as malformed
    // at line 1, column 2 — which is `<` followed by a NUL.
    const contents = file.encoding === 'utf16le-bom' ? `\uFEFF${file.contents}` : file.contents;
    writeFileSync(file.path, contents, file.encoding === 'utf16le-bom' ? 'utf16le' : 'utf8');
  }

  const failed: string[] = [];
  for (const command of plan.commands) {
    const result = spawnSync(command.command, command.args, { stdio: 'inherit' });
    if (result.error) failed.push(`${command.command}: ${result.error.message}`);
    else if (result.status !== 0 && result.status !== null) failed.push(`${command.command} exited with ${result.status}`);
  }

  // Ask the operating system whether it worked, rather than assuming that
  // reaching the end of the function means it did. An installer that prints
  // "Registered ..." over the top of two errors is worse than one that fails.
  let installed = failed.length === 0;
  if (plan.verifyCommand) {
    const check = spawnSync(plan.verifyCommand.command, plan.verifyCommand.args, { stdio: 'ignore' });
    installed = check.status === 0;
  }

  if (installed) {
    say(green(`\n${plan.summary}`));
    if (failed.length > 0) say(yellow(`(${failed.join('; ')} — but it is registered, so this looks harmless.)`));
    say(dim('Undo with: megaai-node uninstall'));
    return;
  }

  say(red('\nIt is NOT installed. Nothing will start on its own.'));
  for (const failure of failed) say(red(`  · ${failure}`));
  if (plan.platform === 'win32') {
    say(
      dim(
        '\nIf schtasks says "Access is denied", run this from a PowerShell started with "Run as administrator".\n' +
          `The task file it tried to register is ${plan.files[0]?.path} — it can also be imported by hand from\n` +
          'Task Scheduler → Action → Import Task.',
      ),
    );
  }
  process.exitCode = 1;
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

  // Read the saved settings *before* the config, so a connection string
  // written once with `set` is in force for every future run — including the
  // Scheduled Task, which starts with no shell and therefore no `$env:`.
  const stateDir = process.env['MEGAAI_STATE_DIR'] ?? defaultStateDir(process.env, process.platform);
  const fromFile = loadEnvFile(envFilePath(stateDir, process.platform));

  const config = loadNodeConfig(process.env, process.platform, os.hostname());
  if (fromFile.length > 0 && command !== 'set') {
    say(dim(`Using saved settings: ${fromFile.join(', ')}`));
  }

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
    case 'plan':
      await plan(config, args);
      break;
    case 'gui':
      await gui(config, args);
      break;
    case 'tasks':
      await tasks(config);
      break;
    case 'cancel':
      await cancel(config, args);
      break;
    case 'retry':
      await retry(config, args);
      break;
    case 'set':
      setSetting(config, args);
      break;
    case 'install':
      install(config, args);
      break;
    case 'uninstall':
      uninstall(config);
      break;
    default:
      say(`Unknown command "${command}".`);
      say('Try: run · status · tasks · plan · add · gui · retry · cancel · set · install · uninstall');
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  say(red(`\n${(error as Error).message}`));
  process.exitCode = 1;
});
