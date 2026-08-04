/**
 * @megaai/code — the code engine (Phase 3).
 *
 * Wraps git so every delivery workspace becomes a real repository:
 * initialised on first commit, versioned per delivery, inspectable through
 * status/log/diff, and — milestone 2 — collaborative through branches,
 * merges and remote pushes. Exposed two ways — a `GitEngine` for trusted
 * core code (the orchestrator versions each finished delivery) and `git.*`
 * tools so agents can work through the action pipeline.
 *
 * Safety: commands run via execFile (no shell interpolation), always inside
 * the workspace, from a fixed subcommand set. Publishing to a remote goes
 * through `git.push`, whose `git.push` permission is approval-gated by
 * default config — nothing reaches a remote without a human saying yes.
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

  async listBranches(cwd: string): Promise<string[]> {
    if (!this.isRepo(cwd)) return [];
    const result = await this.run(cwd, ['branch', '--list', '--format=%(refname:short)']);
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /** Create a branch (from `from`, defaulting to HEAD) and, unless declined, switch to it. */
  async createBranch(cwd: string, name: string, options: { from?: string; checkout?: boolean } = {}): Promise<void> {
    if (!name.trim()) throw new MegaError('INVALID_INPUT', 'Branch name must not be empty');
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Not a git repository');
    const args =
      options.checkout === false
        ? ['branch', name, ...(options.from ? [options.from] : [])]
        : ['checkout', '-b', name, ...(options.from ? [options.from] : [])];
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git branch failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  async checkout(cwd: string, name: string): Promise<void> {
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Not a git repository');
    const result = await this.run(cwd, ['checkout', name]);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git checkout failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  /** Merge `branch` into the current branch. Aborts and reports rather than leaving a conflicted tree. */
  async merge(cwd: string, branch: string, options: { message?: string } = {}): Promise<GitMergeResult> {
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Not a git repository');
    const args = options.message ? ['merge', '-m', options.message, branch] : ['merge', '--no-edit', branch];
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      const status = await this.run(cwd, ['status', '--porcelain']);
      const conflicted = /^(UU|AA|DD|AU|UA|UD|DU) /m.test(status.stdout);
      if (conflicted) {
        await this.run(cwd, ['merge', '--abort']);
        return { merged: false, conflict: true };
      }
      throw new MegaError('INTERNAL', `git merge failed: ${(result.stderr || result.stdout).trim()}`);
    }
    const sha = await this.run(cwd, ['rev-parse', 'HEAD']);
    return { merged: true, conflict: false, sha: sha.stdout.trim() || undefined };
  }

  /** Push the current (or given) branch to a remote. This is the only operation that reaches outside the workspace. */
  async push(cwd: string, options: { remote?: string; branch?: string; setUpstream?: boolean } = {}): Promise<GitPushResult> {
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Not a git repository');
    const remote = options.remote ?? 'origin';
    const branch = options.branch ?? (await this.currentBranch(cwd));
    if (!branch) throw new MegaError('INVALID_INPUT', 'No branch to push (detached HEAD?)');
    const args = ['push', ...(options.setUpstream ? ['-u'] : []), remote, branch];
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git push failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return { pushed: true, remote, branch };
  }
}

export interface GitMergeResult {
  merged: boolean;
  conflict: boolean;
  sha?: string;
}

export interface GitPushResult {
  pushed: true;
  remote: string;
  branch: string;
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
  const branches: Tool = {
    name: 'git.branches',
    description: 'List branches and the current branch in the workspace repository',
    inputSchema: {},
    permissions: ['git.read'],
    async execute(_input, ctx) {
      const [all, current] = await Promise.all([
        engine.listBranches(ctx.workspaceRoot),
        engine.currentBranch(ctx.workspaceRoot),
      ]);
      return { branches: all as unknown as JsonValue, current: current ?? null };
    },
  };
  const branch: Tool = {
    name: 'git.branch',
    description: 'Create a branch (initialises the repo on first use), switching to it unless checkout is false',
    inputSchema: { name: 'string', from: 'string (optional base ref)', checkout: 'boolean (optional, default true)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const name = str(input, 'name');
      if (ctx.dryRun) {
        const preview: JsonValue = { wouldCreate: name, checkout: input.checkout !== false };
        return preview;
      }
      if (!engine.isRepo(ctx.workspaceRoot)) await engine.init(ctx.workspaceRoot);
      await engine.createBranch(ctx.workspaceRoot, name, {
        from: typeof input.from === 'string' ? input.from : undefined,
        checkout: input.checkout !== false,
      });
      return { created: name };
    },
  };
  const checkout: Tool = {
    name: 'git.checkout',
    description: 'Switch the workspace repository to an existing branch',
    inputSchema: { name: 'string' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const name = str(input, 'name');
      if (ctx.dryRun) {
        const preview: JsonValue = { wouldCheckout: name };
        return preview;
      }
      await engine.checkout(ctx.workspaceRoot, name);
      return { checkedOut: name };
    },
  };
  const merge: Tool = {
    name: 'git.merge',
    description: 'Merge a branch into the current branch; aborts cleanly and reports conflict instead of leaving one',
    inputSchema: { branch: 'string', message: 'string (optional commit message)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const branchName = str(input, 'branch');
      if (ctx.dryRun) {
        const preview: JsonValue = { wouldMerge: branchName };
        return preview;
      }
      const result = await engine.merge(ctx.workspaceRoot, branchName, {
        message: typeof input.message === 'string' ? input.message : undefined,
      });
      return result as unknown as JsonValue;
    },
  };
  const push: Tool = {
    name: 'git.push',
    description: 'Push the current (or given) branch to a remote — the only operation that reaches outside the workspace',
    inputSchema: {
      remote: 'string (optional, default "origin")',
      branch: 'string (optional, default current branch)',
      setUpstream: 'boolean (optional)',
    },
    permissions: ['git.push'],
    async execute(input, ctx) {
      const remote = typeof input.remote === 'string' ? input.remote : undefined;
      const branch = typeof input.branch === 'string' ? input.branch : undefined;
      if (ctx.dryRun) {
        const preview: JsonValue = { wouldPush: { remote: remote ?? 'origin', branch: branch ?? '(current)' } };
        return preview;
      }
      const result = await engine.push(ctx.workspaceRoot, {
        remote,
        branch,
        setUpstream: input.setUpstream === true,
      });
      return result as unknown as JsonValue;
    },
  };
  return [commit, status, log, diff, branches, branch, checkout, merge, push];
}
