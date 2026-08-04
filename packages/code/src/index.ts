/**
 * @megaai/code — the code engine (Phase 3).
 *
 * Wraps git so every delivery workspace becomes a real repository:
 * initialised on first commit, versioned per delivery, inspectable through
 * status/log/diff, and collaborative — branches, merges, and pushes to a
 * remote. Exposed two ways — a `GitEngine` for trusted core code (the
 * orchestrator versions each finished delivery) and `git.*` tools so agents
 * can do the same through the action pipeline.
 *
 * Safety: commands run via execFile (no shell interpolation), always inside
 * the workspace, from a fixed subcommand set. `git.push` is the one operation
 * that reaches outside the workspace, so it carries the `git.push`
 * permission — approval-gated by default (see `defaultConfig()` in
 * `@megaai/config`), same as `deploy` and `shell.exec`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonObject, JsonValue } from '@megaai/types';
import { MegaError } from '@megaai/types';
import type { Tool } from '@megaai/contracts';

const execFileAsync = promisify(execFile);

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
      .map((line) => ({ current: line.startsWith('*'), name: line.replace(/^\*?\s+/, '').trim() }));
  }

  /** Create a branch (optionally from a given base) and switch to it. */
  async createBranch(cwd: string, name: string, options: { from?: string } = {}): Promise<void> {
    if (!name.trim()) throw new MegaError('INVALID_INPUT', 'Branch name must not be empty');
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Not a git repository');
    const args = options.from ? ['checkout', '-b', name, options.from] : ['checkout', '-b', name];
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git branch create failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  /** Switch to an existing branch. Refuses to switch with uncommitted changes. */
  async checkout(cwd: string, branch: string): Promise<void> {
    if (!branch.trim()) throw new MegaError('INVALID_INPUT', 'Branch name must not be empty');
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Not a git repository');
    const result = await this.run(cwd, ['checkout', branch]);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git checkout failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  /**
   * Merge `branch` into the current branch. On conflict, aborts the merge
   * and reports it rather than leaving the workspace mid-conflict.
   */
  async merge(cwd: string, branch: string, message?: string): Promise<{ merged: boolean; sha?: string; conflict: boolean; output: string }> {
    if (!branch.trim()) throw new MegaError('INVALID_INPUT', 'Branch name must not be empty');
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Not a git repository');
    const args = ['merge', '--no-ff', branch, '-m', message ?? `Merge branch '${branch}'`];
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      await this.run(cwd, ['merge', '--abort']);
      const conflict = /conflict/i.test(result.stdout + result.stderr);
      return { merged: false, conflict, output: (result.stderr || result.stdout).trim() };
    }
    const sha = await this.run(cwd, ['rev-parse', 'HEAD']);
    return { merged: true, conflict: false, sha: sha.stdout.trim() || undefined, output: result.stdout.trim() };
  }

  /** Add a remote, or repoint it if it already exists. */
  async setRemote(cwd: string, name: string, url: string): Promise<void> {
    if (!name.trim() || !url.trim()) throw new MegaError('INVALID_INPUT', 'Remote name and url must not be empty');
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Not a git repository');
    const add = await this.run(cwd, ['remote', 'add', name, url]);
    if (add.exitCode !== 0) {
      const setUrl = await this.run(cwd, ['remote', 'set-url', name, url]);
      if (setUrl.exitCode !== 0) {
        throw new MegaError('INTERNAL', `git remote add/set-url failed: ${(setUrl.stderr || setUrl.stdout).trim()}`);
      }
    }
  }

  /**
   * Push the given (or current) branch to a remote. This is the one
   * operation here that reaches outside the workspace, which is why the
   * `git.push` tool is registered under a permission gated by approval —
   * see `defaultConfig().policy.approvalRequiredPermissions`.
   */
  async push(cwd: string, options: { remote?: string; branch?: string; remoteUrl?: string; setUpstream?: boolean } = {}): Promise<GitResult> {
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Not a git repository');
    const remote = options.remote ?? 'origin';
    if (options.remoteUrl) await this.setRemote(cwd, remote, options.remoteUrl);
    const branch = options.branch ?? (await this.currentBranch(cwd));
    if (!branch) throw new MegaError('INVALID_INPUT', 'No branch to push (detached HEAD?)');
    const args = options.setUpstream ? ['push', '-u', remote, branch] : ['push', remote, branch];
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git push failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return result;
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
    description: 'List branches, or create (and switch to) a new one when "name" is given',
    inputSchema: { name: 'string (optional, new branch name)', from: 'string (optional base ref)' },
    permissions: ['git.write'],
    async execute(input, ctx): Promise<JsonValue> {
      const name = typeof input.name === 'string' ? input.name : undefined;
      if (!name) {
        return { branches: (await engine.listBranches(ctx.workspaceRoot)) as unknown as JsonValue };
      }
      await engine.createBranch(ctx.workspaceRoot, name, {
        from: typeof input.from === 'string' ? input.from : undefined,
      });
      return { created: true, branch: name };
    },
  };
  const checkout: Tool = {
    name: 'git.checkout',
    description: 'Switch the workspace to an existing branch',
    inputSchema: { branch: 'string (branch name)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      await engine.checkout(ctx.workspaceRoot, str(input, 'branch'));
      return { checkedOut: str(input, 'branch') };
    },
  };
  const merge: Tool = {
    name: 'git.merge',
    description: 'Merge a branch into the current branch; aborts and reports on conflict',
    inputSchema: { branch: 'string (branch to merge in)', message: 'string (optional commit message)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const message = typeof input.message === 'string' ? input.message : undefined;
      const result = await engine.merge(ctx.workspaceRoot, str(input, 'branch'), message);
      return result as unknown as JsonValue;
    },
  };
  const push: Tool = {
    name: 'git.push',
    description: 'Push the current (or given) branch to a remote — requires human approval',
    inputSchema: {
      remote: 'string (optional, default "origin")',
      remoteUrl: 'string (optional, sets/adds the remote before pushing)',
      branch: 'string (optional, defaults to the current branch)',
      setUpstream: 'boolean (optional)',
    },
    permissions: ['git.push'],
    async execute(input, ctx) {
      const result = await engine.push(ctx.workspaceRoot, {
        remote: typeof input.remote === 'string' ? input.remote : undefined,
        remoteUrl: typeof input.remoteUrl === 'string' ? input.remoteUrl : undefined,
        branch: typeof input.branch === 'string' ? input.branch : undefined,
        setUpstream: input.setUpstream === true,
      });
      return { pushed: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
    },
  };
  return [commit, status, log, diff, branch, checkout, merge, push];
}
