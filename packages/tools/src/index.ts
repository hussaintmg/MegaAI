/**
 * @megaai/tools — everything an agent can actually do to the world.
 *
 * Tools are named, schema-described, permission-tagged operations. The
 * built-ins cover sandboxed filesystem work, allowlisted HTTP, tightly
 * gated shell execution and time. Filesystem paths are confined to the
 * workspace root — escape attempts throw PERMISSION_DENIED.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { JsonObject, JsonValue } from '@megaai/types';
import { MegaError } from '@megaai/types';
import type { Tool, ToolContext, ToolSpec } from '@megaai/contracts';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new MegaError('ALREADY_EXISTS', `Tool "${tool.name}" already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  specs(): ToolSpec[] {
    return this.list().map(({ name, description, inputSchema, permissions }) => ({
      name,
      description,
      inputSchema,
      permissions,
    }));
  }

  /** Compact tool list for inclusion in prompts. */
  describeForPrompt(allowed?: string[]): string {
    return this.list()
      .filter((tool) => !allowed || allowed.includes(tool.name))
      .map((tool) => `- ${tool.name}: ${tool.description} | input: ${JSON.stringify(tool.inputSchema)}`)
      .join('\n');
  }
}

/* ------------------------------------------------------------------ *
 * Sandbox helpers
 * ------------------------------------------------------------------ */

/** Resolve `relPath` inside the workspace; refuse anything that escapes. */
export function resolveInWorkspace(workspaceRoot: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new MegaError('INVALID_INPUT', 'path must be a non-empty string');
  }
  const root = resolve(workspaceRoot);
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new MegaError('PERMISSION_DENIED', `Path escapes the workspace sandbox: ${relPath}`);
  }
  return target;
}

function str(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') {
    throw new MegaError('INVALID_INPUT', `Tool input "${key}" must be a string`);
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Built-in tools
 * ------------------------------------------------------------------ */

const MAX_READ_BYTES = 256 * 1024;

export const fsWriteTool: Tool = {
  name: 'fs.write',
  description: 'Create or overwrite a text file inside the project workspace',
  inputSchema: { path: 'string (relative)', content: 'string' },
  permissions: ['fs.write'],
  async execute(input, ctx) {
    const target = resolveInWorkspace(ctx.workspaceRoot, str(input, 'path'));
    const content = str(input, 'content');
    if (ctx.dryRun) {
      const preview: JsonValue = { wouldWrite: target, bytes: content.length };
      return preview;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    const result: JsonValue = { path: str(input, 'path'), bytes: Buffer.byteLength(content) };
    return result;
  },
};

export const fsReadTool: Tool = {
  name: 'fs.read',
  description: 'Read a text file from the project workspace',
  inputSchema: { path: 'string (relative)' },
  permissions: ['fs.read'],
  async execute(input, ctx) {
    const target = resolveInWorkspace(ctx.workspaceRoot, str(input, 'path'));
    if (!existsSync(target)) throw new MegaError('NOT_FOUND', `File not found: ${str(input, 'path')}`);
    const size = statSync(target).size;
    if (size > MAX_READ_BYTES) {
      throw new MegaError('INVALID_INPUT', `File too large to read (${size} bytes > ${MAX_READ_BYTES})`);
    }
    return { path: str(input, 'path'), content: readFileSync(target, 'utf8') };
  },
};

export const fsListTool: Tool = {
  name: 'fs.list',
  description: 'List files and directories under a workspace path',
  inputSchema: { path: 'string (relative, optional, default ".")' },
  permissions: ['fs.read'],
  async execute(input, ctx) {
    const rel = typeof input.path === 'string' && input.path.length > 0 ? input.path : '.';
    const target = resolveInWorkspace(ctx.workspaceRoot, rel);
    if (!existsSync(target)) return { path: rel, entries: [] };
    const entries = readdirSync(target, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
    }));
    return { path: rel, entries: entries as unknown as JsonValue };
  },
};

export const fsDeleteTool: Tool = {
  name: 'fs.delete',
  description: 'Delete a file or directory inside the project workspace',
  inputSchema: { path: 'string (relative)' },
  permissions: ['fs.delete'],
  async execute(input, ctx) {
    const rel = str(input, 'path');
    const target = resolveInWorkspace(ctx.workspaceRoot, rel);
    if (target === resolve(ctx.workspaceRoot)) {
      throw new MegaError('PERMISSION_DENIED', 'Refusing to delete the workspace root');
    }
    if (ctx.dryRun) {
      const preview: JsonValue = { wouldDelete: rel };
      return preview;
    }
    rmSync(target, { recursive: true, force: true });
    const result: JsonValue = { deleted: rel };
    return result;
  },
};

export interface HttpToolOptions {
  /** Hostnames the tool may contact; empty list = deny everything. */
  allowedHosts: string[];
  timeoutMs?: number;
}

export function createHttpTool(options: HttpToolOptions): Tool {
  return {
    name: 'http.fetch',
    description: 'Fetch a URL (GET) from an allowlisted host and return the body text',
    inputSchema: { url: 'string (https URL on an allowlisted host)' },
    permissions: ['net.fetch'],
    async execute(input) {
      const url = new URL(str(input, 'url'));
      const allowed = options.allowedHosts.some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      );
      if (!allowed) {
        throw new MegaError('PERMISSION_DENIED', `Host "${url.hostname}" is not on the HTTP allowlist`);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        const body = await response.text();
        return { status: response.status, body: body.slice(0, 100_000) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface ShellToolOptions {
  enabled: boolean;
  /** Binaries that may be executed, e.g. ['node', 'npm', 'git']. */
  allowlist: string[];
  timeoutMs?: number;
}

export function createShellTool(options: ShellToolOptions): Tool {
  return {
    name: 'shell.exec',
    description: 'Run an allowlisted binary inside the workspace (args as array, no shell interpolation)',
    inputSchema: { command: 'string (allowlisted binary)', args: 'string[] (optional)' },
    permissions: ['shell.exec'],
    async execute(input, ctx) {
      if (!options.enabled) {
        throw new MegaError('PERMISSION_DENIED', 'Shell execution is disabled by configuration');
      }
      const command = str(input, 'command');
      if (!options.allowlist.includes(command)) {
        throw new MegaError('PERMISSION_DENIED', `Binary "${command}" is not on the shell allowlist`);
      }
      const args = Array.isArray(input.args) ? input.args.map(String) : [];
      // expectSuccess turns a non-zero exit into a hard failure so callers
      // (e.g. the testing agent's real test runs) can't silently pass.
      const expectSuccess = input.expectSuccess === true;
      try {
        const { stdout, stderr } = await execFileAsync(command, args, {
          cwd: ctx.workspaceRoot,
          timeout: options.timeoutMs ?? 60_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        return { exitCode: 0, stdout: stdout.slice(0, 50_000), stderr: stderr.slice(0, 50_000) };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
        const exitCode = typeof e.code === 'number' ? e.code : 1;
        if (expectSuccess) {
          throw new MegaError(
            'INTERNAL',
            `command "${command}" failed (exit ${exitCode}): ${(e.stderr ?? e.stdout ?? e.message ?? '').slice(0, 2_000)}`,
          );
        }
        return {
          exitCode,
          stdout: (e.stdout ?? '').slice(0, 50_000),
          stderr: (e.stderr ?? e.message ?? '').slice(0, 50_000),
        };
      }
    },
  };
}

export const timeTool: Tool = {
  name: 'time.now',
  description: 'Current date and time',
  inputSchema: {},
  permissions: [],
  async execute() {
    const now = new Date();
    return { iso: now.toISOString(), epochMs: now.getTime() };
  },
};

export interface BuiltinToolOptions {
  allowShell?: boolean;
  shellAllowlist?: string[];
  httpAllowedHosts?: string[];
}

/** The standard tool set, honouring the security configuration. */
export function createBuiltinTools(options: BuiltinToolOptions = {}): Tool[] {
  return [
    fsWriteTool,
    fsReadTool,
    fsListTool,
    fsDeleteTool,
    createHttpTool({ allowedHosts: options.httpAllowedHosts ?? [] }),
    createShellTool({ enabled: options.allowShell ?? false, allowlist: options.shellAllowlist ?? [] }),
    timeTool,
  ];
}

export function createToolRegistry(options: BuiltinToolOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools(options)) registry.register(tool);
  return registry;
}

export type { Tool, ToolContext, ToolSpec };
