/**
 * @megaai/code — the code engine (Phase 3).
 *
 * Wraps git so every delivery workspace becomes a real repository:
 * initialised on first commit, versioned per delivery, inspectable through
 * status/log/diff, and now collaborative — branches, merges, and remote
 * pushes. Exposed two ways — a `GitEngine` for trusted core code (the
 * orchestrator versions each finished delivery) and `git.*` tools so agents
 * can work with git through the action pipeline.
 *
 * Safety: commands run via execFile (no shell interpolation), always inside
 * the workspace, from a fixed subcommand set. Ref names are validated so
 * they can't be mistaken for flags. Pushing to a remote is a distinct
 * `git.push` permission the policy engine gates behind human approval by
 * default — see `approvalRequiredPermissions` in `@megaai/config`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonObject, JsonValue } from '@megaai/types';
import { MegaError } from '@megaai/types';
import type { Tool } from '@megaai/contracts';

const execFileAsync = promisify(execFile);

/**
 * Conservative ref/remote name check: must not be empty, must not start
 * with `-` (so it can never be misread as a flag), and only common ref
 * characters are allowed. Rejects everything else rather than trying to
 * enumerate every unsafe git ref rule.
 */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

function assertSafeRef(name: string, what: string): void {
  if (!SAFE_REF.test(name) || name.includes('..') || name.endsWith('.lock')) {
    throw new MegaError('INVALID_INPUT', `Invalid ${what}: "${name}"`);
  }
}

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitEngineOptions {
  /** Identity used for commits made by MegaAI. */
  authorName?: string;
  authorEmail?: string;
  timeoutMs?: number;
}

export class GitEngine {
  private readonly authorName: string;
  private readonly authorEmail: string;
  private readonly timeoutMs: number;

  constructor(options: GitEngineOptions = {}) {
    this.authorName = options.authorName ?? 'MegaAI';
    this.authorEmail = options.authorEmail ?? 'megaai@localhost';
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Run one git subcommand inside `cwd`; never throws on non-zero exit. */
  async run(cwd: string, args: string[]): Promise<GitResult> {
    try {
      const { stdout, stderr } = await execFileAsync(
        'git',
        [
          // Per-invocation identity so no global git config is required.
          '-c', `user.name=${this.authorName}`,
          '-c', `user.email=${this.authorEmail}`,
          '-c', 'commit.gpgsign=false',
          ...args,
        ],
        { cwd, timeout: this.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      );
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      if (e.code === 'ENOENT') {
        throw new MegaError('PROVIDER_UNAVAILABLE', 'git is not installed on this machine');
      }
      return {
        exitCode: typeof e.code === 'number' ? e.code : 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? '',
      };
    }
  }

  static isAvailable(): Promise<boolean> {
    return execFileAsync('git', ['--version'])
      .then(() => true)
      .catch(() => false);
  }

  isRepo(cwd: string): boolean {
    return existsSync(join(cwd, '.git'));
  }

  async init(cwd: string): Promise<void> {
    const result = await this.run(cwd, ['init', '--initial-branch=main']);
    if (result.exitCode !== 0) {
      // Older git without --initial-branch: plain init.
      const fallback = await this.run(cwd, ['init']);
      if (fallback.exitCode !== 0) {
        throw new MegaError('INTERNAL', `git init failed: ${fallback.stderr.trim()}`);
      }
    }
  }

  /** Stage everything and commit; returns undefined when nothing changed. */
  async commitAll(cwd: string, message: string): Promise<string | undefined> {
    if (!message.trim()) throw new MegaError('INVALID_INPUT', 'Commit message must not be empty');
    if (!this.isRepo(cwd)) await this.init(cwd);
    await this.run(cwd, ['add', '-A']);
    const status = await this.run(cwd, ['status', '--porcelain']);
    if (status.stdout.trim().length === 0) return undefined;
    const commit = await this.run(cwd, ['commit', '-m', message]);
    if (commit.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git commit failed: ${(commit.stderr || commit.stdout).trim()}`);
    }
    const sha = await this.run(cwd, ['rev-parse', 'HEAD']);
    return sha.stdout.trim() || undefined;
  }

  async status(cwd: string): Promise<Array<{ state: string; path: string }>> {
    if (!this.isRepo(cwd)) return [];
    const result = await this.run(cwd, ['status', '--porcelain']);
    return result.stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ state: line.slice(0, 2).trim() || '??', path: line.slice(3) }));
  }

  async log(cwd: string, limit = 20): Promise<Array<{ sha: string; message: string }>> {
    if (!this.isRepo(cwd)) return [];
    const result = await this.run(cwd, ['log', `-${Math.max(1, Math.min(limit, 100))}`, '--pretty=%h %s']);
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const space = line.indexOf(' ');
        return { sha: line.slice(0, space), message: line.slice(space + 1) };
      });
  }

  async diff(cwd: string, options: { staged?: boolean } = {}): Promise<string> {
    if (!this.isRepo(cwd)) return '';
    const args = options.staged ? ['diff', '--staged', '--stat'] : ['diff', '--stat'];
    const result = await this.run(cwd, args);
    return result.stdout.slice(0, 20_000);
  }

  async currentBranch(cwd: string): Promise<string | undefined> {
    if (!this.isRepo(cwd)) return undefined;
    const result = await this.run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  async listBranches(cwd: string): Promise<Array<{ name: string; current: boolean }>> {
    if (!this.isRepo(cwd)) return [];
    const result = await this.run(cwd, ['branch', '--list']);
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ current: line.startsWith('*'), name: line.replace(/^\*?\s*/, '').trim() }));
  }

  /** Create a branch (optionally from a start point) without switching to it. */
  async createBranch(cwd: string, name: string, from?: string): Promise<void> {
    assertSafeRef(name, 'branch name');
    if (from) assertSafeRef(from, 'start point');
    if (!this.isRepo(cwd)) await this.init(cwd);
    const args = from ? ['branch', name, from] : ['branch', name];
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git branch failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  async checkout(cwd: string, branch: string, options: { create?: boolean } = {}): Promise<void> {
    assertSafeRef(branch, 'branch name');
    const args = options.create ? ['checkout', '-b', branch] : ['checkout', branch];
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git checkout failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  /** Merge `branch` into the current branch. Returns false on conflicts (and aborts the merge). */
  async merge(cwd: string, branch: string, options: { message?: string } = {}): Promise<{ merged: boolean; conflicted: string[] }> {
    assertSafeRef(branch, 'branch name');
    const args = ['merge', '--no-ff', branch];
    if (options.message) args.push('-m', options.message);
    const result = await this.run(cwd, args);
    if (result.exitCode === 0) return { merged: true, conflicted: [] };

    const status = await this.status(cwd);
    const conflicted = status.filter((entry) => entry.state.includes('U')).map((entry) => entry.path);
    if (conflicted.length > 0) {
      await this.run(cwd, ['merge', '--abort']);
    }
    return { merged: false, conflicted };
  }

  /**
   * Push a branch to a remote. Restricted to the `origin` remote and to
   * plain (non-force) pushes — this is the one operation in the engine that
   * reaches outside the local workspace, so callers gate it behind approval.
   */
  async push(cwd: string, branch: string, options: { remote?: string; setUpstream?: boolean } = {}): Promise<GitResult> {
    const remote = options.remote ?? 'origin';
    if (remote !== 'origin') {
      throw new MegaError('PERMISSION_DENIED', 'Pushes are only allowed to the "origin" remote');
    }
    assertSafeRef(branch, 'branch name');
    const args = options.setUpstream ? ['push', '-u', remote, branch] : ['push', remote, branch];
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git push failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return result;
  }

  async hasRemote(cwd: string, name = 'origin'): Promise<boolean> {
    if (!this.isRepo(cwd)) return false;
    const result = await this.run(cwd, ['remote']);
    return result.stdout.split('\n').map((line) => line.trim()).includes(name);
  }
}

/* ------------------------------------------------------------------ *
 * Agent-facing tools
 * ------------------------------------------------------------------ */

function str(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') {
    throw new MegaError('INVALID_INPUT', `Tool input "${key}" must be a string`);
  }
  return value;
}

/** The git tool set agents may use inside their workspace. */
export function createGitTools(engine: GitEngine = new GitEngine()): Tool[] {
  const commit: Tool = {
    name: 'git.commit',
    description: 'Stage all workspace changes and create a commit (initialises the repo on first use)',
    inputSchema: { message: 'string (commit message)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const sha = await engine.commitAll(ctx.workspaceRoot, str(input, 'message'));
      const out: JsonValue = sha ? { committed: true, sha } : { committed: false, reason: 'nothing to commit' };
      return out;
    },
  };
  const status: Tool = {
    name: 'git.status',
    description: 'List uncommitted changes in the workspace repository',
    inputSchema: {},
    permissions: ['git.read'],
    async execute(_input, ctx) {
      const entries = await engine.status(ctx.workspaceRoot);
      return { entries: entries as unknown as JsonValue, clean: entries.length === 0 };
    },
  };
  const log: Tool = {
    name: 'git.log',
    description: 'Show recent commits in the workspace repository',
    inputSchema: { limit: 'number (optional, default 20)' },
    permissions: ['git.read'],
    async execute(input, ctx) {
      const limit = typeof input.limit === 'number' ? input.limit : 20;
      return { commits: (await engine.log(ctx.workspaceRoot, limit)) as unknown as JsonValue };
    },
  };
  const diff: Tool = {
    name: 'git.diff',
    description: 'Summarise uncommitted changes (diffstat) in the workspace repository',
    inputSchema: { staged: 'boolean (optional)' },
    permissions: ['git.read'],
    async execute(input, ctx) {
      return { diff: await engine.diff(ctx.workspaceRoot, { staged: input.staged === true }) };
    },
  };
  const branch: Tool = {
    name: 'git.branch',
    description: 'List branches, or create a new one (optionally from a start point) without switching to it',
    inputSchema: { name: 'string (optional; create this branch if given)', from: 'string (optional start point)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const name = typeof input.name === 'string' ? input.name : undefined;
      if (!name) {
        const branches = (await engine.listBranches(ctx.workspaceRoot)) as unknown as JsonValue;
        const out: JsonValue = { branches };
        return out;
      }
      const from = typeof input.from === 'string' ? input.from : undefined;
      await engine.createBranch(ctx.workspaceRoot, name, from);
      const out: JsonValue = { created: name };
      return out;
    },
  };
  const checkout: Tool = {
    name: 'git.checkout',
    description: 'Switch the workspace to a branch, optionally creating it first',
    inputSchema: { branch: 'string', create: 'boolean (optional)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const branchName = str(input, 'branch');
      await engine.checkout(ctx.workspaceRoot, branchName, { create: input.create === true });
      return { branch: branchName };
    },
  };
  const merge: Tool = {
    name: 'git.merge',
    description: 'Merge a branch into the current branch; aborts cleanly and reports conflicts instead of leaving one in progress',
    inputSchema: { branch: 'string', message: 'string (optional commit message)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const message = typeof input.message === 'string' ? input.message : undefined;
      const result = await engine.merge(ctx.workspaceRoot, str(input, 'branch'), { message });
      return result as unknown as JsonValue;
    },
  };
  const push: Tool = {
    name: 'git.push',
    description: 'Push a branch to the "origin" remote (approval-gated: reaches outside the local workspace)',
    inputSchema: { branch: 'string', setUpstream: 'boolean (optional)' },
    permissions: ['git.push'],
    async execute(input, ctx) {
      const branchName = str(input, 'branch');
      await engine.push(ctx.workspaceRoot, branchName, { setUpstream: input.setUpstream === true });
      return { pushed: branchName };
    },
  };
  return [commit, status, log, diff, branch, checkout, merge, push];
}
