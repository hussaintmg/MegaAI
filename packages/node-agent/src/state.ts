/**
 * The little that has to survive a reboot.
 *
 * Task progress lives in the mesh, not here — that is the whole point of the
 * lease. What the machine itself must remember is smaller: *which node it is*,
 * and *which conversation each coding agent has open in each project*. Forget
 * the first and a restart looks like a brand new laptop joining, leaving the
 * old one's tasks stranded until their leases lapse. Forget the second and
 * every agent re-reads the whole codebase after every reboot.
 *
 * Writes go to a temporary file and are renamed over the real one, because the
 * moment a laptop is most likely to be interrupted mid-write is exactly when
 * this file matters.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Timestamp } from '@megaai/types';
import type { CoderId } from '@megaai/coders';
import type { Gear } from '@megaai/mesh';
import { newId } from '@megaai/utils';

export interface PersistedState {
  nodeId: string;
  /** coder id → project folder → session id. */
  sessions: Record<string, Record<string, string>>;
  gear?: Gear;
  updatedAt?: Timestamp;
}

/** Where a Windows machine expects a program to keep its own state. */
export function defaultStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = '',
): string {
  const homeDir = home || env['HOME'] || env['USERPROFILE'] || '.';
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'];
    return local ? path.win32.join(local, 'MegaAI') : path.win32.join(homeDir, 'AppData', 'Local', 'MegaAI');
  }
  const stateHome = env['XDG_STATE_HOME'];
  return stateHome ? path.join(stateHome, 'megaai') : path.join(homeDir, '.megaai');
}

export interface StateFileOptions {
  read?: (file: string) => Promise<string>;
  write?: (file: string, contents: string) => Promise<void>;
  move?: (from: string, to: string) => Promise<void>;
  ensureDir?: (dir: string) => Promise<void>;
}

export class StateFile {
  private cached: PersistedState | undefined;
  private readonly read: (file: string) => Promise<string>;
  private readonly write: (file: string, contents: string) => Promise<void>;
  private readonly move: (from: string, to: string) => Promise<void>;
  private readonly ensureDir: (dir: string) => Promise<void>;

  constructor(readonly file: string, options: StateFileOptions = {}) {
    this.read = options.read ?? ((target) => readFile(target, 'utf8'));
    this.write = options.write ?? ((target, contents) => writeFile(target, contents, 'utf8'));
    this.move = options.move ?? ((from, to) => rename(from, to));
    this.ensureDir = options.ensureDir ?? (async (dir) => void (await mkdir(dir, { recursive: true })));
  }

  /**
   * Load, or start fresh with a new identity.
   *
   * A corrupt file is *not* fatal: an agent that refuses to start because its
   * bookkeeping got truncated by a power cut is worse than one that loses its
   * session ids.
   */
  async load(): Promise<PersistedState> {
    if (this.cached) return { ...this.cached, sessions: cloneSessions(this.cached.sessions) };
    let state: PersistedState = { nodeId: newId('node'), sessions: {} };
    try {
      const parsed: unknown = JSON.parse(await this.read(this.file));
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Partial<PersistedState>;
        state = {
          nodeId: typeof record.nodeId === 'string' && record.nodeId ? record.nodeId : state.nodeId,
          sessions: sanitiseSessions(record.sessions),
          ...(record.gear ? { gear: record.gear } : {}),
        };
      }
    } catch {
      // No file yet, or an unreadable one. Either way: start.
    }
    this.cached = state;
    return { ...state, sessions: cloneSessions(state.sessions) };
  }

  async save(patch: Partial<PersistedState>): Promise<PersistedState> {
    const current = await this.load();
    const next: PersistedState = {
      ...current,
      ...patch,
      sessions: patch.sessions ? sanitiseSessions(patch.sessions) : current.sessions,
      updatedAt: Date.now(),
    };
    this.cached = next;
    await this.ensureDir(path.dirname(this.file));
    const temporary = `${this.file}.tmp`;
    await this.write(temporary, JSON.stringify(next, null, 2));
    await this.move(temporary, this.file);
    return next;
  }

  /** Remember a coding agent's conversation for a project folder. */
  async rememberSession(coder: CoderId, projectDir: string, sessionId: string): Promise<void> {
    const current = await this.load();
    const sessions = cloneSessions(current.sessions);
    sessions[coder] = { ...(sessions[coder] ?? {}), [projectDir]: sessionId };
    await this.save({ sessions });
  }
}

function sanitiseSessions(value: unknown): Record<string, Record<string, string>> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [coder, projects] of Object.entries(value as Record<string, unknown>)) {
    if (typeof projects !== 'object' || projects === null) continue;
    const inner: Record<string, string> = {};
    for (const [project, sessionId] of Object.entries(projects as Record<string, unknown>)) {
      if (typeof sessionId === 'string' && sessionId) inner[project] = sessionId;
    }
    if (Object.keys(inner).length > 0) out[coder] = inner;
  }
  return out;
}

function cloneSessions(sessions: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
  return Object.fromEntries(Object.entries(sessions).map(([key, value]) => [key, { ...value }]));
}
