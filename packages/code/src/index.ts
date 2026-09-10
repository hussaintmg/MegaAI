/**
 * @megaai/code — the code engine (Phase 3, milestones 1 and 5).
 *
 * Wraps git so every delivery workspace becomes a real repository:
 * initialised on first commit, versioned per delivery, inspectable through
 * status/log/diff. Exposed two ways — a `GitEngine` for trusted core code
 * (the orchestrator versions each finished delivery) and `git.*` tools so
 * agents can commit their own work through the action pipeline.
 *
 * Safety: commands run via execFile (no shell interpolation), always inside
 * the workspace, from a fixed subcommand set. Branching/merging is local and
 * ungated (`git.write`); publishing to a remote (`git.push`) is a distinct,
 * approval-gated permission and — when a remote allowlist is configured —
 * the target host is checked before the push runs.
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
  /**
   * Hosts a `push` is allowed to target, e.g. `['github.com']` (subdomains
   * match too). Empty (the default) means unrestricted — the approval gate
   * on the `git.push` permission is the primary control either way.
   */
  remoteAllowlist?: string[];
}

export interface MergeResult {
  merged: boolean;
  sha?: string;
  conflict?: boolean;
  message?: string;
}

export class GitEngine {
  private readonly authorName: string;
  private readonly authorEmail: string;
  private readonly timeoutMs: number;
  private readonly remoteAllowlist: string[];

  constructor(options: GitEngineOptions = {}) {
    this.authorName = options.authorName ?? 'MegaAI';
    this.authorEmail = options.authorEmail ?? 'megaai@localhost';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.remoteAllowlist = options.remoteAllowlist ?? [];
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
    const result = await this.run(cwd, ['branch', '--format=%(refname:short)']);
    if (result.exitCode !== 0) return [];
    return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  }

  /** Create a branch (optionally from a start point) and switch to it. */
  async createBranch(cwd: string, name: string, options: { checkout?: boolean; from?: string } = {}): Promise<void> {
    if (!name.trim()) throw new MegaError('INVALID_INPUT', 'Branch name must not be empty');
    if (!this.isRepo(cwd)) await this.init(cwd);
    const args = options.checkout === false ? ['branch', name] : ['checkout', '-b', name];
    if (options.from) args.push(options.from);
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git branch create failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  async checkout(cwd: string, branch: string): Promise<void> {
    if (!branch.trim()) throw new MegaError('INVALID_INPUT', 'Branch name must not be empty');
    const result = await this.run(cwd, ['checkout', branch]);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git checkout failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  /** Merge `branch` into the current branch. Reports conflicts instead of throwing. */
  async merge(cwd: string, branch: string, options: { message?: string } = {}): Promise<MergeResult> {
    if (!branch.trim()) throw new MegaError('INVALID_INPUT', 'Branch name must not be empty');
    const args = ['merge', '--no-ff', branch];
    if (options.message) args.push('-m', options.message);
    else args.push('-m', `Merge branch '${branch}'`);
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      // Leave a clean state for the caller to decide what to do next.
      await this.run(cwd, ['merge', '--abort']);
      return { merged: false, conflict: true, message: (result.stderr || result.stdout).trim() };
    }
    const sha = await this.run(cwd, ['rev-parse', 'HEAD']);
    return { merged: true, sha: sha.stdout.trim() || undefined };
  }

  async addRemote(cwd: string, name: string, url: string): Promise<void> {
    if (!name.trim() || !url.trim()) throw new MegaError('INVALID_INPUT', 'Remote name and url must not be empty');
    if (!this.isRepo(cwd)) await this.init(cwd);
    const existing = await this.run(cwd, ['remote', 'get-url', name]);
    const args = existing.exitCode === 0 ? ['remote', 'set-url', name, url] : ['remote', 'add', name, url];
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git remote add failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  private checkRemoteAllowed(url: string): void {
    if (this.remoteAllowlist.length === 0) return;
    let host: string;
    try {
      // scp-like syntax (git@host:owner/repo) has no URL scheme; normalise it.
      const normalised = /^[^/@]+@[^:/]+:/.test(url) ? `ssh://${url.replace(':', '/')}` : url;
      host = new URL(normalised).hostname;
    } catch {
      throw new MegaError('INVALID_INPUT', `Could not parse remote url: ${url}`);
    }
    const allowed = this.remoteAllowlist.some((h) => host === h || host.endsWith(`.${h}`));
    if (!allowed) {
      throw new MegaError('PERMISSION_DENIED', `Remote host "${host}" is not on the git remote allowlist`);
    }
  }

  /** Push `branch` (default: current branch) to `remote` (default: origin). */
  async push(
    cwd: string,
    options: { remote?: string; branch?: string; setUpstream?: boolean } = {},
  ): Promise<{ pushed: boolean; remote: string; branch: string; message?: string }> {
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Not a git repository');
    const remote = options.remote ?? 'origin';
    const remoteUrl = await this.run(cwd, ['remote', 'get-url', remote]);
    if (remoteUrl.exitCode !== 0) {
      throw new MegaError('INVALID_INPUT', `Unknown remote "${remote}"`);
    }
    this.checkRemoteAllowed(remoteUrl.stdout.trim());
    const branch = options.branch ?? (await this.currentBranch(cwd));
    if (!branch) throw new MegaError('INVALID_INPUT', 'No branch to push (detached HEAD?)');
    const args = ['push', ...(options.setUpstream ? ['-u'] : []), remote, branch];
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      return { pushed: false, remote, branch, message: (result.stderr || result.stdout).trim() };
    }
    return { pushed: true, remote, branch };
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
  const branchList: Tool = {
    name: 'git.branch.list',
    description: 'List branches in the workspace repository',
    inputSchema: {},
    permissions: ['git.read'],
    async execute(_input, ctx) {
      const branches = await engine.listBranches(ctx.workspaceRoot);
      return { branches: branches as unknown as JsonValue, current: (await engine.currentBranch(ctx.workspaceRoot)) ?? null };
    },
  };
  const branchCreate: Tool = {
    name: 'git.branch.create',
    description: 'Create a branch in the workspace repository (checks it out by default)',
    inputSchema: { name: 'string (branch name)', checkout: 'boolean (optional, default true)', from: 'string (optional start point)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const name = str(input, 'name');
      await engine.createBranch(ctx.workspaceRoot, name, {
        checkout: input.checkout !== false,
        from: typeof input.from === 'string' ? input.from : undefined,
      });
      return { created: true, name };
    },
  };
  const checkout: Tool = {
    name: 'git.checkout',
    description: 'Switch the workspace repository to an existing branch',
    inputSchema: { branch: 'string (branch name)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const branch = str(input, 'branch');
      await engine.checkout(ctx.workspaceRoot, branch);
      return { checkedOut: branch };
    },
  };
  const merge: Tool = {
    name: 'git.merge',
    description: 'Merge a branch into the current branch (no-fast-forward); reports conflicts instead of failing the workspace',
    inputSchema: { branch: 'string (branch to merge in)', message: 'string (optional commit message)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const branch = str(input, 'branch');
      const message = typeof input.message === 'string' ? input.message : undefined;
      return (await engine.merge(ctx.workspaceRoot, branch, { message })) as unknown as JsonValue;
    },
  };
  const remoteAdd: Tool = {
    name: 'git.remote.add',
    description: 'Add or update a named remote in the workspace repository',
    inputSchema: { name: 'string (remote name, e.g. origin)', url: 'string (remote url)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const name = str(input, 'name');
      const url = str(input, 'url');
      await engine.addRemote(ctx.workspaceRoot, name, url);
      return { added: true, name, url };
    },
  };
  const push: Tool = {
    name: 'git.push',
    description: 'Push the current (or given) branch to a remote (approval-gated)',
    inputSchema: {
      remote: 'string (optional, default origin)',
      branch: 'string (optional, default current branch)',
      setUpstream: 'boolean (optional)',
    },
    permissions: ['git.push'],
    async execute(input, ctx) {
      const remote = typeof input.remote === 'string' ? input.remote : undefined;
      const branch = typeof input.branch === 'string' ? input.branch : undefined;
      const setUpstream = input.setUpstream === true;
      return (await engine.push(ctx.workspaceRoot, { remote, branch, setUpstream })) as unknown as JsonValue;
    },
  };
  return [commit, status, log, diff, branchList, branchCreate, checkout, merge, remoteAdd, push];
}
