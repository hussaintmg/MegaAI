/**
 * Starting the coding CLIs on a real machine — which mostly means Windows.
 *
 * Three things break naive `spawn('claude', …)` on Windows and all are handled
 * here:
 *
 *   1. `claude`, `codex` and `opencode` are installed by npm as **shims**:
 *      `claude.cmd` in `%APPDATA%\npm`. `spawn` without a shell looks for a
 *      file called exactly `claude` and fails with ENOENT. So PATH is walked
 *      with PATHEXT, the way the shell would, and the real file is spawned.
 *      This is done rather than `shell: true` on purpose — a prompt full of
 *      quotes, ampersands and newlines is not something to hand to cmd.exe.
 *
 *   2. Killing the process is not enough. A coding agent spawns npm, which
 *      spawns node, which spawns a build; killing the parent orphans all of
 *      them and they keep the fan running. On Windows the tree is killed with
 *      `taskkill /T`, elsewhere by signalling the process group.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { CoderId, CoderLauncher, CoderSpec, RunOutcome } from '@megaai/coders';

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  /** The PATH to search. */
  pathValue?: string;
  /** Windows' list of what counts as executable. */
  pathExt?: string;
  exists?: (candidate: string) => boolean;
  /** Injected so Windows paths can be tested from anywhere. */
  join?: (...parts: string[]) => string;
  delimiter?: string;
}

/** The file the shell would actually run for this command, if there is one. */
export function resolveCommand(command: string, options: ResolveOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const isWindows = platform === 'win32';
  const exists = options.exists ?? existsSync;
  const join = options.join ?? ((...parts: string[]) => (isWindows ? parts.join('\\') : parts.join('/')));
  const delimiter = options.delimiter ?? (isWindows ? ';' : ':');
  const pathValue = options.pathValue ?? process.env['PATH'] ?? '';
  const extensions = isWindows
    ? (options.pathExt ?? process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter(Boolean)
        .map((extension) => extension.toLowerCase())
    : [''];

  // An explicit path is used as given — the caller knows better than PATH.
  if (command.includes('/') || command.includes('\\')) {
    if (exists(command)) return command;
    for (const extension of extensions) {
      if (extension && exists(command + extension)) return command + extension;
    }
    return undefined;
  }

  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const base = join(directory, command);
    if (!isWindows && exists(base)) return base;
    for (const extension of extensions) {
      const candidate = extension ? base + extension : base;
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Which coding agents are actually installed on this machine. */
export function detectCoders(
  specs: readonly CoderSpec[],
  options: ResolveOptions = {},
): { installed: CoderId[]; paths: Record<string, string> } {
  const installed: CoderId[] = [];
  const paths: Record<string, string> = {};
  for (const spec of specs) {
    const resolved = resolveCommand(spec.command, options);
    if (resolved) {
      installed.push(spec.id);
      paths[spec.id] = resolved;
    }
  }
  return { installed, paths };
}

/**
 * The JavaScript an npm `.cmd` shim actually runs.
 *
 * npm generates a batch file whose last line is roughly
 *
 *     … & "%_prog%"  "%dp0%\\node_modules\\@scope\\pkg\\cli.js" %*
 *
 * so the entry point is sitting right there. Pulling it out lets us run the
 * program with the node we already have rather than asking Windows to run a
 * batch file it now refuses to run.
 *
 * Returns nothing if the shim does not look like npm's — better to fall back
 * than to spawn something guessed.
 */
export function resolveShimTarget(contents: string, shimDir: string): string | undefined {
  // Take the last .js mentioned: earlier lines reference node.exe and the
  // shim's own directory, and the entry point is on the exec line at the end.
  const matches = [...contents.matchAll(/"([^"]*?\.[cm]?js)"/g)].map((match) => match[1] ?? '');
  const target = matches[matches.length - 1];
  if (!target) return undefined;
  // %dp0% is the shim's own folder, with a trailing separator of its own.
  const expanded = target.replace(/%~?dp0%[\\/]*/gi, `${shimDir}\\`).replace(/\\{2,}/g, '\\');
  return expanded;
}

/* ------------------------------------------------------------------ *
 * Running one
 * ------------------------------------------------------------------ */

export interface ProcessLauncherOptions {
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
  resolve?: (command: string) => string | undefined;
  /** Keep only the tail beyond this; a long build can print megabytes. */
  maxOutputChars?: number;
  /** A turn that has said nothing for this long is stuck, not thinking. */
  silenceTimeoutMs?: number;
  /** Hard ceiling on a single turn. */
  timeoutMs?: number;
  /** Extra environment for the child (tokens, `CI=1`, …). */
  env?: NodeJS.ProcessEnv;
  onKill?: (pid: number, why: string) => void;
  /** Injected for tests; defaults to reading the shim off disk. */
  readShim?: (file: string) => string | undefined;
  /** The node to run a resolved shim target with. */
  nodePath?: string;
  onNote?: (message: string) => void;
}

/**
 * What to actually spawn, given what PATH resolved to.
 *
 * On Windows a `.cmd` cannot be spawned at all any more, so it is unwrapped
 * into the node + script it was always going to run. Everywhere else — and for
 * a real `.exe` — the file is spawned as found.
 */
export function planSpawn(
  file: string,
  args: string[],
  options: { platform: NodeJS.Platform; readShim?: (file: string) => string | undefined; nodePath?: string; dirname?: (p: string) => string },
): { file: string; args: string[]; note?: string } {
  if (options.platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args };

  const dirname = options.dirname ?? path.win32.dirname;
  const contents = options.readShim?.(file);
  const target = contents ? resolveShimTarget(contents, dirname(file)) : undefined;
  if (!target) {
    // Nothing safe left to try. Spawning the .cmd will fail with EINVAL, and
    // saying why beats letting the driver's error stand on its own.
    return {
      file,
      args,
      note:
        `${file} is a batch shim that could not be unwrapped. Node refuses to run .cmd files directly ` +
        '(the fix for CVE-2024-27980), so this will fail with EINVAL. Installing the agent so that a real ' +
        '.exe is on PATH avoids it.',
    };
  }
  return { file: options.nodePath ?? process.execPath, args: [target, ...args] };
}

/**
 * A `CoderLauncher` backed by real processes.
 *
 * stdout and stderr are merged on purpose: these CLIs print progress to one
 * and errors to the other with no consistency, and the quota message we are
 * watching for can arrive on either.
 */
export function createProcessLauncher(options: ProcessLauncherOptions = {}): CoderLauncher {
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawn;
  const resolve = options.resolve ?? ((command: string) => resolveCommand(command, { platform }));
  const maxOutputChars = options.maxOutputChars ?? 200_000;
  const silenceTimeoutMs = options.silenceTimeoutMs ?? 20 * 60_000;
  const timeoutMs = options.timeoutMs ?? 90 * 60_000;

  const readShim =
    options.readShim ??
    ((file: string) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    });

  return async (command, args, cwd, onChunk) =>
    new Promise<RunOutcome>((resolveOutcome) => {
      const resolved = resolve(command) ?? command;
      const plan = planSpawn(resolved, args, {
        platform,
        readShim,
        ...(options.nodePath ? { nodePath: options.nodePath } : {}),
      });
      if (plan.note) options.onNote?.(plan.note);
      const file = plan.file;
      const child = spawnProcess(file, plan.args, {
        cwd,
        // detached gives us a process group to kill on POSIX; on Windows the
        // group comes from taskkill /T instead, and detaching only hurts.
        detached: platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...options.env },
      });

      let output = '';
      let settled = false;
      let killedFor: string | undefined;

      const absorb = (chunk: Buffer | string): void => {
        const text = chunk.toString();
        output += text;
        if (output.length > maxOutputChars) output = output.slice(-maxOutputChars);
        onChunk?.(text);
        bumpSilence();
      };

      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(silenceTimer);
        clearTimeout(hardTimer);
        const note = killedFor ? `\n[megaai] stopped this turn: ${killedFor}` : '';
        resolveOutcome({ exitCode, output: output + note });
      };

      const killTree = (why: string): void => {
        killedFor = why;
        const pid = child.pid;
        if (pid === undefined) return;
        options.onKill?.(pid, why);
        try {
          if (platform === 'win32') {
            // Killing the shim leaves npm, node and the build it started
            // running — and a laptop with a fan at full speed.
            spawnProcess('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          } else {
            process.kill(-pid, 'SIGTERM');
          }
        } catch {
          child.kill('SIGKILL');
        }
      };

      // These are deliberately *not* unref'd: while a coding agent is running,
      // the watchdog that will stop it is the last thing that should be
      // allowed to disappear.
      let silenceTimer: NodeJS.Timeout;
      const bumpSilence = (): void => {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(
          () => killTree(`it printed nothing for ${Math.round(silenceTimeoutMs / 60_000)} minutes`),
          silenceTimeoutMs,
        );
      };
      bumpSilence();

      const hardTimer = setTimeout(
        () => killTree(`it ran past the ${Math.round(timeoutMs / 60_000)} minute limit for a single turn`),
        timeoutMs,
      );

      child.stdout?.on('data', absorb);
      child.stderr?.on('data', absorb);
      child.on('error', (error) => {
        output += `\n[megaai] could not start ${file}: ${error.message}`;
        finish(127);
      });
      child.on('close', (code) => finish(code ?? 1));
    });
}

/**
 * Open the project where the agent has been working.
 *
 * Small, but it is what makes coming back to the laptop make sense: the folder
 * the night's work happened in is already open, rather than left for you to
 * find.
 */
export function openInEditor(
  directory: string,
  options: { platform?: NodeJS.Platform; spawnProcess?: typeof spawn; resolve?: (c: string) => string | undefined } = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawn;
  const resolve = options.resolve ?? ((command: string) => resolveCommand(command, { platform }));
  const code = resolve('code');
  if (!code) return false;
  try {
    const child = spawnProcess(code, ['-n', path.normalize(directory)], {
      stdio: 'ignore',
      windowsHide: true,
      detached: platform !== 'win32',
    });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
