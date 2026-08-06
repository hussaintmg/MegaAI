/**
 * The task kind that does the actual coding: hand the work to Claude Code,
 * Codex or OpenCode, and keep handing it on as each one runs out.
 *
 * The one thing this file exists to get right is that **the handoff is
 * durable**. `@megaai/coders` already passes a brief from one agent to the
 * next inside a single run; here that brief is written into the task's
 * checkpoint after every turn. So the sequence that actually happens at night
 * —
 *
 *     Claude works for two hours → hits its limit
 *     Codex continues from Claude's brief → hits its limit
 *     laptop reboots (Windows update, of course)
 *     …
 *     OpenCode's limit resets at 6am and it continues from *both* their briefs
 *
 * — survives the reboot in the middle, because the history is in the queue and
 * not in a process that died.
 */

import { readdirSync } from 'node:fs';
import type { JsonObject, Timestamp } from '@megaai/types';
import {
  type CoderId,
  type CoderLauncher,
  type CoderPool,
  type HandoffContext,
  type HandoffEntry,
  type TurnResult,
  relayTask,
} from '@megaai/coders';
import type { TaskContext, TaskHandler, TaskOutcome } from './agent.js';

export interface CoderTaskPayload {
  kind: 'coder';
  /** What the whole project is for — carried into every brief. */
  goal: string;
  /** The piece this task is meant to finish. */
  task: string;
  /** The folder to work in. */
  projectDir: string;
  notes?: string[];
  model?: string;
  /** Open the folder in VS Code when the work is done. */
  openEditor?: boolean;
}

export function isCoderPayload(payload: JsonObject): payload is JsonObject & CoderTaskPayload {
  return (
    payload['kind'] === 'coder' &&
    typeof payload['goal'] === 'string' &&
    typeof payload['task'] === 'string' &&
    typeof payload['projectDir'] === 'string' &&
    (payload['projectDir'] as string).length > 0
  );
}

/** The project folder of a coder task — what two tasks must not share. */
export function coderLockKey(payload: JsonObject): string | undefined {
  return isCoderPayload(payload) ? payload.projectDir : undefined;
}

export interface CoderHandlerOptions {
  pool: CoderPool;
  launcher: CoderLauncher;
  /** `git status --short`, so the next agent knows what is already changed. */
  changedFiles?: (projectDir: string) => Promise<string[]>;
  /** What is in the folder — the only listing there is outside a git repo. */
  projectFiles?: (projectDir: string) => Promise<string[]>;
  /** Called once a turn finishes, for VS Code and the like. */
  onFinished?: (payload: CoderTaskPayload, turns: TurnResult[]) => void;
  /** Summarise a turn for the next agent's brief. */
  summarise?: (turn: TurnResult) => string;
  now?: () => Timestamp;
}

interface Checkpoint {
  history: HandoffEntry[];
  turns: number;
  lastOutputTail?: string;
}

function readCheckpoint(checkpoint: JsonObject | undefined): Checkpoint {
  const raw = checkpoint?.['coder'];
  if (typeof raw !== 'object' || raw === null) return { history: [], turns: 0 };
  const record = raw as Record<string, unknown>;
  const history = Array.isArray(record['history'])
    ? (record['history'] as unknown[]).flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const item = entry as Record<string, unknown>;
        if (typeof item['coder'] !== 'string' || typeof item['summary'] !== 'string') return [];
        return [{ coder: item['coder'] as CoderId, summary: item['summary'], at: Number(item['at'] ?? 0) }];
      })
    : [];
  return {
    history,
    turns: typeof record['turns'] === 'number' ? record['turns'] : history.length,
    ...(typeof record['lastOutputTail'] === 'string' ? { lastOutputTail: record['lastOutputTail'] } : {}),
  };
}

/**
 * Turn the last agent's output into one line for the next one's brief.
 *
 * The tail is what matters: a coding CLI ends with what it did, and the middle
 * is mostly file listings nobody needs to re-read.
 */
function defaultSummary(turn: TurnResult): string {
  const tail = turn.output.trim().split(/\r?\n/).filter(Boolean).slice(-6).join(' ').slice(0, 400);
  if (turn.limited) return `${turn.coder} worked until it ran out of quota. Last output: ${tail || '(nothing)'}`;
  if (!turn.ok) return `${turn.coder} stopped with exit ${turn.exitCode}. Last output: ${tail || '(nothing)'}`;
  return `${turn.coder} finished its turn: ${tail || '(no summary given)'}`;
}

export function createCoderHandler(options: CoderHandlerOptions): TaskHandler {
  const summarise = options.summarise ?? defaultSummary;
  const now = options.now ?? (() => options.pool.now());

  return async (context: TaskContext): Promise<TaskOutcome> => {
    const payload = context.task.payload;
    if (!isCoderPayload(payload)) {
      return {
        kind: 'failed',
        error: 'a coder task needs a goal, a task and a projectDir — this one is missing at least one of them',
      };
    }

    const previous = readCheckpoint(context.task.checkpoint);
    const changedFiles = await options.changedFiles?.(payload.projectDir).catch(() => []);
    const projectFiles = await options.projectFiles?.(payload.projectDir).catch(() => []);

    const handoff: HandoffContext = {
      goal: payload.goal,
      task: payload.task,
      projectDir: payload.projectDir,
      history: previous.history,
      ...(changedFiles && changedFiles.length > 0 ? { changedFiles } : {}),
      ...(projectFiles && projectFiles.length > 0 ? { projectFiles } : {}),
      ...(previous.lastOutputTail ? { lastOutputTail: previous.lastOutputTail } : {}),
      ...(payload.notes ? { notes: payload.notes } : {}),
    };

    if (previous.history.length > 0) {
      context.log(`continuing — ${previous.history.length} agent turn(s) already went into this`);
    }

    const result = await relayTask({
      pool: options.pool,
      launcher: options.launcher,
      context: handoff,
      summarise,
      ...(payload.model ? { model: payload.model } : {}),
      onChunk: () => {
        // Streaming output would drown the log; the summary carries the point.
      },
      onTurn: async (turn, history) => {
        // Written down *before* the next agent starts, so a crash between two
        // turns still leaves the history complete.
        await context.checkpoint({
          coder: {
            history: history.map((entry) => ({ ...entry })),
            turns: previous.turns + history.length,
            lastOutputTail: turn.output.slice(-2_000),
          },
        } as JsonObject);
        context.log(`${turn.coder} ${turn.limited ? 'ran out of quota' : turn.ok ? 'finished' : 'stopped'}`);
      },
    });

    if (result.ok) {
      options.onFinished?.(payload, result.turns);
      const last = result.turns[result.turns.length - 1];
      return {
        kind: 'done',
        result: {
          coders: result.turns.map((turn) => turn.coder),
          handoffs: Math.max(0, result.turns.length - 1),
          finishedBy: last?.coder ?? 'unknown',
          output: last?.output.slice(-4_000) ?? '',
        },
      };
    }

    if (result.resumeAt) {
      return { kind: 'parked', until: result.resumeAt, reason: result.reason ?? 'every coding agent is out of quota' };
    }

    // Nobody is installed, or the line ran out without a reset time to wait
    // for. Waiting an hour on the chance is better than burning an attempt,
    // but only when there is something to wait *for*.
    if (result.turns.length === 0) {
      return { kind: 'failed', error: result.reason ?? 'no coding agent was available to run this' };
    }

    return {
      kind: 'failed',
      error:
        result.reason ??
        `tried ${result.turns.length} coding agent(s) and none finished — last exit ${
          result.turns[result.turns.length - 1]?.exitCode ?? '?'
        }`,
    };
  };
}

/**
 * What is in the project folder already.
 *
 * The build output is skipped deliberately: `node_modules` alone would fill
 * the brief with tens of thousands of paths and push the part that matters out
 * of the agent's context.
 */
export const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'out',
  '.turbo',
  '.cache',
  'coverage',
  '.megaai',
  'venv',
  '__pycache__',
]);

export function listProjectFiles(
  directory: string,
  options: {
    readDir?: (dir: string) => Array<{ name: string; isDirectory: boolean }>;
    limit?: number;
    maxDepth?: number;
  } = {},
): string[] {
  const readDir =
    options.readDir ??
    ((dir: string) =>
      readdirSync(dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      })));
  const limit = options.limit ?? 200;
  const maxDepth = options.maxDepth ?? 4;
  const found: string[] = [];

  const walk = (dir: string, prefix: string, depth: number): void => {
    if (found.length >= limit || depth > maxDepth) return;
    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      entries = readDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (entry.isDirectory) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`, depth + 1);
      } else {
        found.push(`${prefix}${entry.name}`);
      }
    }
  };

  walk(directory, '', 0);
  return found;
}

/** `git status --short` as a list of paths, for the handoff brief. */
export function parseGitStatus(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const path = line.slice(2).trim();
      // Renames arrive as "old -> new"; the new name is the one that exists.
      const arrow = path.lastIndexOf(' -> ');
      return arrow >= 0 ? path.slice(arrow + 4) : path;
    })
    .filter(Boolean);
}
