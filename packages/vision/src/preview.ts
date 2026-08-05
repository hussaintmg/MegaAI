/**
 * app.preview — install it, build it, start it, and look at it.
 *
 * Every other check in the system inspects files. This one runs the product:
 * `npm install`, the real build command, the real start command, then loads
 * each route in Chromium and photographs it. A delivery that compiles but
 * serves a 500, or renders nothing, fails here and nowhere else.
 *
 * Screenshots are written into the workspace so they travel with the delivery
 * and end up in front of the person who asked for the thing.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve, sep } from 'node:path';
import type { JsonObject, JsonValue } from '@megaai/types';
import { MegaError } from '@megaai/types';
import type { Tool } from '@megaai/contracts';
import type { AuditReport } from './index.js';
import type { VisionTester } from './index.js';

export const PREVIEW_DIR = '.megaai/preview';

export interface PreviewRunnerOptions {
  /** Shell must be enabled and the binary allowlisted, same rule as shell.exec. */
  enabled: boolean;
  allowlist: string[];
  /** Whole-tool ceiling. Installing and building a real app is slow. */
  timeoutMs?: number;
}

export interface PreviewStep {
  name: string;
  command: string;
  exitCode: number;
  ok: boolean;
  output: string;
}

export interface PreviewPage {
  route: string;
  url: string;
  status?: number;
  ok: boolean;
  title?: string;
  screenshot?: string;
  audit?: AuditReport;
  error?: string;
}

export interface PreviewResult {
  ok: boolean;
  url?: string;
  steps: PreviewStep[];
  pages: PreviewPage[];
  note?: string;
}

function insideWorkspace(workspaceRoot: string, relative: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new MegaError('PERMISSION_DENIED', `Path escapes the workspace: ${relative}`);
  }
  return target;
}

/** Run one command to completion, capturing its output. Never uses a shell. */
function runOnce(
  options: PreviewRunnerOptions,
  cwd: string,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; output: string }> {
  if (!options.enabled) {
    throw new MegaError('PERMISSION_DENIED', 'Shell execution is disabled by configuration');
  }
  if (!options.allowlist.includes(command)) {
    throw new MegaError('PERMISSION_DENIED', `Binary "${command}" is not on the shell allowlist`);
  }
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer) => {
      // Keep the tail: a build failure's cause is at the end, not the start.
      output = (output + chunk.toString()).slice(-20_000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      output += `\n[timed out after ${timeoutMs}ms]`;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: 127, output: `${output}\n${String(err)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code ?? 1, output });
    });
  });
}

/** Resolve once the port accepts a TCP connection, or reject on deadline. */
async function waitForPort(port: number, deadlineMs: number, isDead: () => boolean): Promise<void> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (isDead()) throw new MegaError('INTERNAL', 'the server process exited before it started listening');
    const open = await new Promise<boolean>((done) => {
      const socket = connect({ port, host: '127.0.0.1' });
      const finish = (value: boolean) => {
        socket.destroy();
        done(value);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(1_000, () => finish(false));
    });
    if (open) return;
    if (Date.now() > until) throw new MegaError('TIMEOUT', `nothing was listening on port ${port} in time`);
    await new Promise((done) => setTimeout(done, 500));
  }
}

/** Kill the server and everything it spawned (`next start` forks workers). */
function stopServer(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    // Negative pid targets the whole process group, so a framework's child
    // workers go down with it instead of holding the port open.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

export class PreviewRunner {
  constructor(
    private readonly options: PreviewRunnerOptions,
    private readonly tester: VisionTester,
  ) {}

  async run(input: JsonObject, workspaceRoot: string): Promise<PreviewResult> {
    const dir = insideWorkspace(workspaceRoot, typeof input.dir === 'string' ? input.dir : '.');
    if (!existsSync(join(dir, 'package.json'))) {
      throw new MegaError('NOT_FOUND', 'no package.json in that directory — nothing to install, build or start');
    }
    const port = Number.isFinite(input.port) ? Number(input.port) : 3000;
    const routes = (Array.isArray(input.routes) ? input.routes.map(String) : ['/'])
      .filter((route) => route.startsWith('/'))
      .slice(0, 10);
    const start = Array.isArray(input.start) && input.start.length > 0 ? input.start.map(String) : ['npm', 'run', 'start'];
    const stepTimeout = Number.isFinite(input.timeoutMs) ? Number(input.timeoutMs) : 600_000;

    const steps: PreviewStep[] = [];
    const runStep = async (name: string, argv: string[]): Promise<boolean> => {
      const [command, ...args] = argv;
      if (!command) return false;
      const outcome = await runOnce(this.options, dir, command, args, stepTimeout);
      steps.push({
        name,
        command: argv.join(' '),
        exitCode: outcome.exitCode,
        ok: outcome.exitCode === 0,
        output: outcome.output.slice(-4_000),
      });
      return outcome.exitCode === 0;
    };

    if (input.install !== false) {
      const argv = Array.isArray(input.install) ? input.install.map(String) : ['npm', 'install', '--no-audit', '--no-fund'];
      if (!(await runStep('install', argv))) return { ok: false, steps, pages: [], note: 'dependency install failed' };
    }
    if (input.build !== false) {
      const argv = Array.isArray(input.build) ? input.build.map(String) : ['npm', 'run', 'build'];
      if (!(await runStep('build', argv))) return { ok: false, steps, pages: [], note: 'build failed' };
    }

    const [startCommand, ...startArgs] = start;
    if (!startCommand) throw new MegaError('INVALID_INPUT', 'start command is empty');
    if (!this.options.enabled) throw new MegaError('PERMISSION_DENIED', 'Shell execution is disabled by configuration');
    if (!this.options.allowlist.includes(startCommand)) {
      throw new MegaError('PERMISSION_DENIED', `Binary "${startCommand}" is not on the shell allowlist`);
    }

    const server = spawn(startCommand, startArgs, {
      cwd: dir,
      // Its own process group, so stopServer can take the workers down too.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
    });
    let serverLog = '';
    const collect = (chunk: Buffer) => {
      serverLog = (serverLog + chunk.toString()).slice(-8_000);
    };
    server.stdout?.on('data', collect);
    server.stderr?.on('data', collect);

    const base = `http://127.0.0.1:${port}`;
    const pages: PreviewPage[] = [];
    try {
      await waitForPort(port, 90_000, () => server.exitCode !== null);
      steps.push({ name: 'start', command: start.join(' '), exitCode: 0, ok: true, output: serverLog.slice(-2_000) });

      const shotDir = join(workspaceRoot, PREVIEW_DIR);
      mkdirSync(shotDir, { recursive: true });

      for (const route of routes) {
        const url = `${base}${route}`;
        try {
          const audit = await this.tester.audit({ url, label: route });
          const shot = await this.tester.screenshot({ url, label: route });
          let screenshot: string | undefined;
          if (shot?.base64) {
            const name = `${route === '/' ? 'home' : route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}.png`;
            writeFileSync(join(shotDir, name), Buffer.from(shot.base64, 'base64'));
            screenshot = `${PREVIEW_DIR}/${name}`;
          }
          // The audit reaches the page through the browser; a route that 404s
          // or 500s still "loads", so check the status separately.
          const status = await fetch(url, { redirect: 'manual' })
            .then((res) => res.status)
            .catch(() => undefined);
          pages.push({
            route,
            url,
            status,
            ok: status !== undefined && status < 400 && audit.console.errors.length === 0,
            screenshot,
            audit,
          });
        } catch (err) {
          pages.push({ route, url, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err) {
      steps.push({
        name: 'start',
        command: start.join(' '),
        exitCode: 1,
        ok: false,
        output: `${err instanceof Error ? err.message : String(err)}\n${serverLog.slice(-3_000)}`,
      });
      return { ok: false, url: base, steps, pages, note: 'the app never started listening' };
    } finally {
      stopServer(server);
    }

    return {
      ok: pages.length > 0 && pages.every((page) => page.ok),
      url: base,
      steps,
      pages,
      ...(pages.every((page) => page.ok) ? {} : { note: 'one or more routes failed — see pages[]' }),
    };
  }
}

export function createAppPreviewTool(options: PreviewRunnerOptions, tester: VisionTester): Tool {
  const runner = new PreviewRunner(options, tester);
  return {
    name: 'app.preview',
    description:
      'Install, build, start and photograph the real app: runs each route in headless Chromium and returns its HTTP status, full audit and screenshot path',
    inputSchema: {
      dir: 'string (workspace-relative app root, default ".")',
      install: 'false to skip, or string[] argv (default ["npm","install","--no-audit","--no-fund"])',
      build: 'false to skip, or string[] argv (default ["npm","run","build"])',
      start: 'string[] argv (default ["npm","run","start"])',
      port: 'number (default 3000)',
      routes: 'string[] paths to load (default ["/"])',
      timeoutMs: 'number per step (default 600000)',
    },
    permissions: ['shell.exec', 'vision'],
    async execute(input, ctx) {
      return (await runner.run(input, ctx.workspaceRoot)) as unknown as JsonValue;
    },
  };
}
