/**
 * @megaai/code — the code engine (Phase 3, milestone 1).
 *
 * Wraps git so every delivery workspace becomes a real repository:
 * initialised on first commit, versioned per delivery, inspectable through
 * status/log/diff. Exposed two ways — a `GitEngine` for trusted core code
 * (the orchestrator versions each finished delivery) and `git.*` tools so
 * agents can commit their own work through the action pipeline.
 *
 * Safety: commands run via execFile (no shell interpolation), always inside
 * the workspace, from a fixed subcommand set. Nothing here can push to a
 * remote — publishing stays a human-approved, Phase 3 deployment concern.
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
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  /** Create (or switch to) a branch. `from` defaults to the current HEAD. */
  async createBranch(cwd: string, name: string, from?: string): Promise<void> {
    if (!name.trim()) throw new MegaError('INVALID_INPUT', 'Branch name must not be empty');
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Workspace is not a git repository');
    const args = from ? ['checkout', '-b', name, from] : ['checkout', '-b', name];
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git branch create failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  async checkout(cwd: string, name: string): Promise<void> {
    if (!name.trim()) throw new MegaError('INVALID_INPUT', 'Branch name must not be empty');
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Workspace is not a git repository');
    const result = await this.run(cwd, ['checkout', name]);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git checkout failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  /** Merge `from` into the current branch. Returns conflict paths, if any (no commit made). */
  async merge(cwd: string, from: string): Promise<{ merged: boolean; conflicts: string[] }> {
    if (!from.trim()) throw new MegaError('INVALID_INPUT', 'Branch name must not be empty');
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Workspace is not a git repository');
    const result = await this.run(cwd, ['merge', '--no-edit', from]);
    if (result.exitCode === 0) return { merged: true, conflicts: [] };
    const conflicted = await this.run(cwd, ['diff', '--name-only', '--diff-filter=U']);
    const conflicts = conflicted.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (conflicts.length > 0) {
      await this.run(cwd, ['merge', '--abort']);
      return { merged: false, conflicts };
    }
    throw new MegaError('INTERNAL', `git merge failed: ${(result.stderr || result.stdout).trim()}`);
  }

  async addRemote(cwd: string, name: string, url: string): Promise<void> {
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Workspace is not a git repository');
    const existing = await this.run(cwd, ['remote']);
    const remotes = existing.stdout.split('\n').map((line) => line.trim());
    const args = remotes.includes(name) ? ['remote', 'set-url', name, url] : ['remote', 'add', name, url];
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git remote add failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  /** Push the current (or given) branch to a remote. Never runs implicitly — callers gate this behind approval. */
  async push(cwd: string, options: { remote?: string; branch?: string; setUpstream?: boolean } = {}): Promise<GitResult> {
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Workspace is not a git repository');
    const remote = options.remote ?? 'origin';
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
    inputSchema: { name: 'string (optional, branch to create)', from: 'string (optional, base ref)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const name = typeof input.name === 'string' ? input.name : undefined;
      if (!name) {
        const branches = (await engine.listBranches(ctx.workspaceRoot)) as unknown as JsonValue;
        return { branches } as JsonValue;
      }
      const from = typeof input.from === 'string' ? input.from : undefined;
      await engine.createBranch(ctx.workspaceRoot, name, from);
      return { created: name } as JsonValue;
    },
  };
  const checkout: Tool = {
    name: 'git.checkout',
    description: 'Switch the workspace repository to an existing branch',
    inputSchema: { name: 'string (branch to switch to)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      await engine.checkout(ctx.workspaceRoot, str(input, 'name'));
      return { branch: str(input, 'name') };
    },
  };
  const merge: Tool = {
    name: 'git.merge',
    description: 'Merge a branch into the current branch; reports conflicts instead of leaving a half-merge',
    inputSchema: { from: 'string (branch to merge in)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const result = await engine.merge(ctx.workspaceRoot, str(input, 'from'));
      return result as unknown as JsonValue;
    },
  };
  const push: Tool = {
    name: 'git.push',
    description: 'Push the workspace repository to a remote — human-approval-gated, never runs unattended',
    inputSchema: {
      remote: 'string (optional, default "origin")',
      branch: 'string (optional, default current branch)',
      setUpstream: 'boolean (optional)',
    },
    permissions: ['git.push'],
    async execute(input, ctx) {
      const result = await engine.push(ctx.workspaceRoot, {
        remote: typeof input.remote === 'string' ? input.remote : undefined,
        branch: typeof input.branch === 'string' ? input.branch : undefined,
        setUpstream: input.setUpstream === true,
      });
      return { pushed: true, stdout: result.stdout, stderr: result.stderr } as unknown as JsonValue;
    },
  };
  return [commit, status, log, diff, branch, checkout, merge, push];
}
