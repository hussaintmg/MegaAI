/**
 * @megaai/code — the code engine (Phase 3, milestone 1).
 *
 * Wraps git so every delivery workspace becomes a real repository:
 * initialised on first commit, versioned per delivery, inspectable through
 * status/log/diff, and collaborable through branches/merge/remote push.
 * Exposed two ways — a `GitEngine` for trusted core code (the orchestrator
 * versions each finished delivery) and `git.*` tools so agents can work
 * through the action pipeline.
 *
 * Safety: commands run via execFile (no shell interpolation), always inside
 * the workspace, from a fixed subcommand set. Pushing is the one operation
 * that leaves the workspace: `git.push` carries the `git.push` permission
 * (approval-gated by default, see `policy.approvalRequiredPermissions`) and
 * is additionally checked against a remote allowlist before it runs —
 * neither gate alone is enough, both must agree.
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

  async createBranch(cwd: string, name: string, from?: string): Promise<void> {
    if (!name.trim()) throw new MegaError('INVALID_INPUT', 'Branch name must not be empty');
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Cannot branch: workspace has no commits yet');
    const result = await this.run(cwd, from ? ['branch', name, from] : ['branch', name]);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git branch failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  async checkout(cwd: string, branch: string, options: { create?: boolean } = {}): Promise<void> {
    if (!branch.trim()) throw new MegaError('INVALID_INPUT', 'Branch name must not be empty');
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Cannot checkout: workspace has no commits yet');
    const result = await this.run(cwd, options.create ? ['checkout', '-b', branch] : ['checkout', branch]);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git checkout failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  /** Merges `branch` into HEAD; leaves no half-merged state behind on conflict. */
  async merge(
    cwd: string,
    branch: string,
    options: { noFf?: boolean } = {},
  ): Promise<{ merged: boolean; conflict: boolean; sha?: string; message: string }> {
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Cannot merge: workspace has no commits yet');
    const args = ['merge', '--no-edit'];
    if (options.noFf) args.push('--no-ff');
    args.push(branch);
    const result = await this.run(cwd, args);
    if (result.exitCode === 0) {
      const sha = await this.run(cwd, ['rev-parse', 'HEAD']);
      return { merged: true, conflict: false, sha: sha.stdout.trim() || undefined, message: result.stdout.trim() };
    }
    await this.run(cwd, ['merge', '--abort']);
    return { merged: false, conflict: true, message: (result.stderr || result.stdout).trim() };
  }

  async remoteUrl(cwd: string, name: string): Promise<string | undefined> {
    if (!this.isRepo(cwd)) return undefined;
    const result = await this.run(cwd, ['remote', 'get-url', name]);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  async addRemote(cwd: string, name: string, url: string): Promise<void> {
    if (!name.trim() || !url.trim()) throw new MegaError('INVALID_INPUT', 'Remote name and url must not be empty');
    if (!this.isRepo(cwd)) await this.init(cwd);
    const existing = await this.remoteUrl(cwd, name);
    const args = existing !== undefined ? ['remote', 'set-url', name, url] : ['remote', 'add', name, url];
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git remote failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  /** Pushes `branch` to `remote`. Callers are responsible for allowlist checks. */
  async push(
    cwd: string,
    options: { remote: string; branch: string; setUpstream?: boolean },
  ): Promise<GitResult> {
    const args = ['push'];
    if (options.setUpstream) args.push('-u');
    args.push(options.remote, options.branch);
    return this.run(cwd, args);
  }
}

/** Host of a remote URL, covering https(s)/git/ssh and scp-like (`user@host:path`) forms. */
function remoteHost(url: string): string | undefined {
  const scp = /^[^@\s/]+@([^:\s]+):/.exec(url);
  if (scp) return scp[1];
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Matches http-allowlist semantics: exact host or subdomain; local paths must match literally. */
function isAllowedRemote(url: string, allowedRemotes: string[]): boolean {
  const host = remoteHost(url);
  if (host) return allowedRemotes.some((entry) => host === entry || host.endsWith(`.${entry}`));
  return allowedRemotes.includes(url);
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

export interface GitToolOptions {
  /** Remote hosts `git.push` may target (or, for local-path remotes, exact URLs). Empty = deny all pushes. */
  allowedRemotes: string[];
}

/** The git tool set agents may use inside their workspace. */
export function createGitTools(
  engine: GitEngine = new GitEngine(),
  options: GitToolOptions = { allowedRemotes: [] },
): Tool[] {
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
    description: 'Create a new branch in the workspace repository',
    inputSchema: { name: 'string', from: 'string (optional, defaults to current HEAD)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const name = str(input, 'name');
      await engine.createBranch(ctx.workspaceRoot, name, typeof input.from === 'string' ? input.from : undefined);
      return { created: true, name };
    },
  };
  const branches: Tool = {
    name: 'git.branches',
    description: 'List branches in the workspace repository',
    inputSchema: {},
    permissions: ['git.read'],
    async execute(_input, ctx) {
      return { branches: (await engine.listBranches(ctx.workspaceRoot)) as unknown as JsonValue };
    },
  };
  const checkout: Tool = {
    name: 'git.checkout',
    description: 'Switch the workspace repository to a branch, optionally creating it',
    inputSchema: { branch: 'string', create: 'boolean (optional)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const target = str(input, 'branch');
      await engine.checkout(ctx.workspaceRoot, target, { create: input.create === true });
      return { branch: target };
    },
  };
  const merge: Tool = {
    name: 'git.merge',
    description: 'Merge a branch into the current branch; aborts cleanly and reports conflict instead of throwing',
    inputSchema: { branch: 'string', noFf: 'boolean (optional)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const result = await engine.merge(ctx.workspaceRoot, str(input, 'branch'), { noFf: input.noFf === true });
      return result as unknown as JsonValue;
    },
  };
  const remoteAdd: Tool = {
    name: 'git.remoteAdd',
    description: 'Configure (or update) a named remote for the workspace repository',
    inputSchema: { name: 'string', url: 'string' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      await engine.addRemote(ctx.workspaceRoot, str(input, 'name'), str(input, 'url'));
      return { configured: true };
    },
  };
  const push: Tool = {
    name: 'git.push',
    description: 'Push the current branch to an allowlisted remote (requires human approval)',
    inputSchema: {
      remote: 'string (optional, default "origin")',
      branch: 'string (optional, default current branch)',
      setUpstream: 'boolean (optional)',
    },
    permissions: ['git.push'],
    async execute(input, ctx) {
      const remoteName = typeof input.remote === 'string' ? input.remote : 'origin';
      const url = await engine.remoteUrl(ctx.workspaceRoot, remoteName);
      if (!url) throw new MegaError('NOT_FOUND', `Remote "${remoteName}" is not configured`);
      if (!isAllowedRemote(url, options.allowedRemotes)) {
        throw new MegaError('PERMISSION_DENIED', `Remote "${remoteName}" (${url}) is not on the git push allowlist`);
      }
      const targetBranch =
        typeof input.branch === 'string' ? input.branch : await engine.currentBranch(ctx.workspaceRoot);
      if (!targetBranch) throw new MegaError('INVALID_INPUT', 'No current branch to push');
      const result = await engine.push(ctx.workspaceRoot, {
        remote: remoteName,
        branch: targetBranch,
        setUpstream: input.setUpstream === true,
      });
      return { pushed: result.exitCode === 0, stdout: result.stdout.slice(0, 4_000), stderr: result.stderr.slice(0, 4_000) };
    },
  };
  return [commit, status, log, diff, branch, branches, checkout, merge, remoteAdd, push];
}
