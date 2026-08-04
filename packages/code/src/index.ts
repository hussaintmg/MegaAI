/**
 * @megaai/code — the code engine (Phase 3, milestone 1 + git collaboration).
 *
 * Wraps git so every delivery workspace becomes a real repository:
 * initialised on first commit, versioned per delivery, inspectable through
 * status/log/diff, and now collaborative — branches, merges, and remote
 * pushes. Exposed two ways — a `GitEngine` for trusted core code (the
 * orchestrator versions each finished delivery) and `git.*` tools so agents
 * can work through the action pipeline.
 *
 * Safety: commands run via execFile (no shell interpolation), always inside
 * the workspace, from a fixed subcommand set. Refs, branch names, and remote
 * names are validated to reject option-injection (values starting with
 * `-`); remote URLs are checked against git's `ext::`/`fd::` helper schemes,
 * which would otherwise let a URL string run an arbitrary local command.
 * Pushing (`git.push`) and adding a remote (`git.remote`) are the only
 * network-reaching operations here, and both are gated behind
 * human-approval permissions in the default policy config.
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
    const result = await this.run(cwd, [
      'for-each-ref',
      '--format=%(HEAD)%(refname:short)',
      'refs/heads/',
    ]);
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ current: line.startsWith('*'), name: line.slice(1) }));
  }

  /** Create a branch (without switching to it) from `from`, defaulting to HEAD. */
  async createBranch(cwd: string, name: string, from?: string): Promise<void> {
    assertSafeRefName(name, 'branch name');
    if (from !== undefined) assertSafeRefName(from, 'source ref');
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Not a git repository');
    const result = await this.run(cwd, from ? ['branch', name, from] : ['branch', name]);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git branch failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  async checkout(cwd: string, branch: string, options: { create?: boolean } = {}): Promise<void> {
    assertSafeRefName(branch, 'branch name');
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Not a git repository');
    const args = options.create ? ['checkout', '-b', branch] : ['checkout', branch];
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git checkout failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  /** Merge `branch` into the current branch. On conflict, aborts and leaves the workspace clean. */
  async merge(
    cwd: string,
    branch: string,
    options: { message?: string } = {},
  ): Promise<{ merged: boolean; conflict: boolean; output: string }> {
    assertSafeRefName(branch, 'branch name');
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Not a git repository');
    const args = ['merge', '--no-edit'];
    if (options.message) args.push('-m', options.message);
    args.push(branch);
    const result = await this.run(cwd, args);
    if (result.exitCode === 0) {
      return { merged: true, conflict: false, output: (result.stdout || result.stderr).trim() };
    }
    const status = await this.run(cwd, ['status', '--porcelain=v2']);
    const conflict = /^u /m.test(status.stdout);
    if (conflict) await this.run(cwd, ['merge', '--abort']);
    return { merged: false, conflict, output: (result.stderr || result.stdout).trim() };
  }

  async remoteAdd(cwd: string, name: string, url: string): Promise<void> {
    assertSafeRemoteName(name);
    assertSafeRemoteUrl(url);
    if (!this.isRepo(cwd)) await this.init(cwd);
    const result = await this.run(cwd, ['remote', 'add', name, url]);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git remote add failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  async listRemotes(cwd: string): Promise<Array<{ name: string; url: string }>> {
    if (!this.isRepo(cwd)) return [];
    const result = await this.run(cwd, ['remote', '-v']);
    if (result.exitCode !== 0) return [];
    const seen = new Map<string, string>();
    for (const line of result.stdout.split('\n')) {
      const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
      if (match) seen.set(match[1]!, match[2]!);
    }
    return Array.from(seen, ([name, url]) => ({ name, url }));
  }

  /** Push a branch to a remote. Both `remote` and `branch` are ref-validated; `force` defaults to false. */
  async push(
    cwd: string,
    remote: string,
    branch: string,
    options: { force?: boolean; setUpstream?: boolean } = {},
  ): Promise<GitResult> {
    assertSafeRemoteName(remote);
    assertSafeRefName(branch, 'branch name');
    if (!this.isRepo(cwd)) throw new MegaError('INVALID_INPUT', 'Not a git repository');
    const args = ['push'];
    if (options.setUpstream) args.push('--set-upstream');
    if (options.force) args.push('--force-with-lease');
    args.push(remote, branch);
    const result = await this.run(cwd, args);
    if (result.exitCode !== 0) {
      throw new MegaError('INTERNAL', `git push failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return result;
  }
}

/* ------------------------------------------------------------------ *
 * Ref / remote validation — every user-controlled git argument is
 * checked before it reaches execFile. execFile already blocks shell
 * interpolation; these guards additionally block option-injection
 * (a "branch name" of "--upload-pack=/bin/sh" reaching git as a flag)
 * and git's `ext::`/`fd::` remote helper schemes, which run an arbitrary
 * local command when used as a remote URL.
 * ------------------------------------------------------------------ */

const SAFE_REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function assertSafeRefName(name: string, label: string): void {
  if (
    !SAFE_REF_NAME.test(name) ||
    name.includes('..') ||
    name.includes('//') ||
    name.endsWith('/') ||
    name.endsWith('.lock') ||
    name.endsWith('.')
  ) {
    throw new MegaError('INVALID_INPUT', `Invalid ${label}: ${JSON.stringify(name)}`);
  }
}

const SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeRemoteName(name: string): void {
  if (!SAFE_REMOTE_NAME.test(name)) {
    throw new MegaError('INVALID_INPUT', `Invalid remote name: ${JSON.stringify(name)}`);
  }
}

const DANGEROUS_REMOTE_SCHEME = /^\s*(ext|fd)::/i;

function assertSafeRemoteUrl(url: string): void {
  if (!url || url.startsWith('-')) {
    throw new MegaError('INVALID_INPUT', `Invalid remote URL: ${JSON.stringify(url)}`);
  }
  if (DANGEROUS_REMOTE_SCHEME.test(url)) {
    throw new MegaError('INVALID_INPUT', 'Remote URLs using the ext:: or fd:: git helpers are not allowed');
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

function optStr(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
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
  const branchCreate: Tool = {
    name: 'git.branch.create',
    description: 'Create a new branch in the workspace repository, without switching to it',
    inputSchema: { name: 'string (branch name)', from: 'string (optional source ref, default HEAD)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      await engine.createBranch(ctx.workspaceRoot, str(input, 'name'), optStr(input, 'from'));
      return { created: true, name: str(input, 'name') };
    },
  };
  const branchList: Tool = {
    name: 'git.branch.list',
    description: 'List local branches in the workspace repository, marking the current one',
    inputSchema: {},
    permissions: ['git.read'],
    async execute(_input, ctx) {
      return { branches: (await engine.listBranches(ctx.workspaceRoot)) as unknown as JsonValue };
    },
  };
  const checkout: Tool = {
    name: 'git.checkout',
    description: 'Switch the workspace repository to a branch, optionally creating it first',
    inputSchema: { branch: 'string', create: 'boolean (optional, default false)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const branch = str(input, 'branch');
      await engine.checkout(ctx.workspaceRoot, branch, { create: input.create === true });
      return { checkedOut: branch };
    },
  };
  const merge: Tool = {
    name: 'git.merge',
    description: 'Merge a branch into the current branch; on conflict the merge is aborted automatically',
    inputSchema: { branch: 'string (branch to merge in)', message: 'string (optional merge commit message)' },
    permissions: ['git.write'],
    async execute(input, ctx) {
      const result = await engine.merge(ctx.workspaceRoot, str(input, 'branch'), {
        message: optStr(input, 'message'),
      });
      return result as unknown as JsonValue;
    },
  };
  const remoteAdd: Tool = {
    name: 'git.remote.add',
    description: 'Register a remote for the workspace repository (does not push or fetch anything)',
    inputSchema: { name: 'string (remote name, e.g. "origin")', url: 'string (remote URL)' },
    permissions: ['git.remote'],
    async execute(input, ctx) {
      const name = str(input, 'name');
      await engine.remoteAdd(ctx.workspaceRoot, name, str(input, 'url'));
      return { added: true, name };
    },
  };
  const remoteList: Tool = {
    name: 'git.remote.list',
    description: 'List remotes registered on the workspace repository',
    inputSchema: {},
    permissions: ['git.read'],
    async execute(_input, ctx) {
      return { remotes: (await engine.listRemotes(ctx.workspaceRoot)) as unknown as JsonValue };
    },
  };
  const push: Tool = {
    name: 'git.push',
    description: 'Push a branch to a registered remote. Requires human approval by default policy.',
    inputSchema: {
      remote: 'string (optional, default "origin")',
      branch: 'string (optional, default current branch)',
      force: 'boolean (optional, default false — uses --force-with-lease)',
      setUpstream: 'boolean (optional, default false)',
    },
    permissions: ['git.push'],
    async execute(input, ctx) {
      const remote = optStr(input, 'remote') ?? 'origin';
      const branch = optStr(input, 'branch') ?? (await engine.currentBranch(ctx.workspaceRoot));
      if (!branch) throw new MegaError('INVALID_INPUT', 'No branch given and workspace has no current branch');
      const result = await engine.push(ctx.workspaceRoot, remote, branch, {
        force: input.force === true,
        setUpstream: input.setUpstream === true,
      });
      return { pushed: true, remote, branch, output: (result.stdout || result.stderr).trim() };
    },
  };
  return [commit, status, log, diff, branchCreate, branchList, checkout, merge, remoteAdd, remoteList, push];
}
