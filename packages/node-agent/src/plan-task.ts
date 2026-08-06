/**
 * The task that thinks, and then keeps the others busy.
 *
 * One sentence comes in — "build me a 3D car showroom" — and this is what
 * happens to it:
 *
 *     plan task claimed
 *       → the model plans it properly: database, backend, frontend, design,
 *         animation, security, testing, infra; what to add that wasn't asked
 *         for; what will go wrong
 *       → a brief is written for each piece
 *       → the pieces that can start now are queued as `coder` tasks
 *       → this task parks for half a minute
 *     …
 *     wakes up: Codex finished the API
 *       → the frontend piece is no longer blocked, and its brief now says what
 *         the API actually turned out to be
 *       → queued
 *       → parks again
 *     …
 *     until every piece is done
 *
 * Two things are deliberate.
 *
 * **It parks between rounds instead of sleeping.** A supervisor that loops for
 * six hours is six hours of work lost to a Windows update. Parking writes the
 * whole state — the plan, who is doing what, what they finished — into the
 * task's checkpoint and gives the machine back. A reboot in the middle costs
 * one round, not the night.
 *
 * **It never writes code.** It calls a model to plan and to summarise; every
 * file that lands in the project is written by Claude Code, Codex or OpenCode.
 */

import {
  type Blueprint,
  type PieceState,
  type PieceStatus,
  type WorkPiece,
  blueprintFromJson,
  blueprintToJson,
  busyFiles,
  completedSummaries,
  missingSurfaces,
  parseBlueprint,
  planningPrompt,
  progressOf,
  schedule,
  taskTitle,
  writePrompt,
  WEB_APP_SURFACES,
} from '@megaai/blueprint';
import type { Mesh, MeshTask } from '@megaai/mesh';
import type { JsonObject, Timestamp } from '@megaai/types';
import type { TaskContext, TaskHandler, TaskOutcome } from './agent.js';

export interface PlanTaskPayload {
  kind: 'plan';
  /** What was actually asked for, in the words it was asked in. */
  goal: string;
  /**
   * The folder it all happens in.
   *
   * Optional, because a goal typed on a phone cannot know the paths on a
   * laptop it has never seen. When it is missing the machine that picks the
   * goal up decides, and writes its answer down so a restart uses the same
   * folder rather than starting the project again somewhere else.
   */
  projectDir?: string;
  notes?: string[];
  houseRules?: string[];
  verifyCommand?: string;
  /** How many pieces may be in flight at once. */
  maxParallel?: number;
  /** The goal document on the website this belongs to, when it came from there. */
  goalId?: string;
}

export function isPlanPayload(payload: JsonObject): payload is JsonObject & PlanTaskPayload {
  return (
    payload['kind'] === 'plan' &&
    typeof payload['goal'] === 'string' &&
    (payload['goal'] as string).trim().length > 0
  );
}

/** What the supervisor remembers between rounds. */
interface PlanMemory {
  /** Decided once, then kept — a restart must not start the project elsewhere. */
  projectDir?: string;
  blueprint?: Blueprint;
  repairs: string[];
  /** pieceId → the mesh task doing it. */
  children: Record<string, string>;
  statuses: Record<string, PieceStatus>;
  rounds: number;
}

function readMemory(checkpoint: JsonObject | undefined): PlanMemory {
  const raw = checkpoint?.['plan'];
  if (typeof raw !== 'object' || raw === null) return { repairs: [], children: {}, statuses: {}, rounds: 0 };
  const record = raw as Record<string, unknown>;
  const statuses: Record<string, PieceStatus> = {};
  if (typeof record['statuses'] === 'object' && record['statuses'] !== null) {
    for (const [id, value] of Object.entries(record['statuses'] as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const entry = value as Record<string, unknown>;
      const state = entry['state'];
      if (typeof state !== 'string') continue;
      statuses[id] = {
        id,
        state: state as PieceState,
        ...(typeof entry['summary'] === 'string' ? { summary: entry['summary'] } : {}),
      };
    }
  }
  const children: Record<string, string> = {};
  if (typeof record['children'] === 'object' && record['children'] !== null) {
    for (const [id, value] of Object.entries(record['children'] as Record<string, unknown>)) {
      if (typeof value === 'string') children[id] = value;
    }
  }
  const blueprint = blueprintFromJson(record['blueprint']);
  return {
    ...(typeof record['projectDir'] === 'string' ? { projectDir: record['projectDir'] } : {}),
    ...(blueprint ? { blueprint } : {}),
    repairs: Array.isArray(record['repairs']) ? (record['repairs'] as unknown[]).filter((entry): entry is string => typeof entry === 'string') : [],
    children,
    statuses,
    rounds: typeof record['rounds'] === 'number' ? record['rounds'] : 0,
  };
}

function memoryToJson(memory: PlanMemory): JsonObject {
  return {
    plan: {
      ...(memory.projectDir ? { projectDir: memory.projectDir } : {}),
      ...(memory.blueprint ? { blueprint: blueprintToJson(memory.blueprint) } : {}),
      repairs: memory.repairs,
      children: memory.children,
      statuses: JSON.parse(JSON.stringify(memory.statuses)) as JsonObject,
      rounds: memory.rounds,
    },
  } as JsonObject;
}

/**
 * How a child task's state in the queue reads as a piece's state.
 *
 * `pending` counts as running on purpose: the moment a piece is queued its
 * files are spoken for, and treating it as "not started" would let the next
 * round hand the same files to somebody else.
 */
function pieceStateOf(task: MeshTask | undefined): PieceState {
  if (!task) return 'pending';
  if (task.state === 'completed') return 'done';
  if (task.state === 'failed' || task.state === 'cancelled') return 'failed';
  return 'running';
}

/** One line on what a finished piece actually produced, for the next brief. */
function summaryOf(task: MeshTask | undefined): string | undefined {
  const output = task?.result?.['output'];
  if (typeof output !== 'string' || !output.trim()) return undefined;
  return output.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' ').slice(0, 400);
}

export interface PlanHandlerOptions {
  mesh: Mesh;
  /**
   * MegaAI's own model. It plans; it does not type.
   *
   * Injected rather than constructed here so this file has no provider,
   * no keys and no network, and can be tested with a string.
   */
  think: (prompt: string, purpose: 'plan') => Promise<string>;
  /** What is already in the folder, so an existing project is not replanned from zero. */
  listFiles?: (projectDir: string) => Promise<string[]> | string[];
  /** Which coding agents this machine has, named in the planning brief. */
  coders?: () => string[];
  /**
   * Where to build a goal that did not name a folder.
   *
   * Given the goal so the folder is named after it — a workspace full of
   * `project-1`, `project-2` is unusable a week later.
   */
  resolveProjectDir?: (goal: string) => string;
  /** Make the folder before the first agent is pointed at it. */
  ensureDir?: (projectDir: string) => void;
  /** Gap between rounds. */
  pollMs?: number;
  now?: () => Timestamp;
}

const DEFAULT_MAX_PARALLEL = 3;

export function createPlanHandler(options: PlanHandlerOptions): TaskHandler {
  const pollMs = options.pollMs ?? 30_000;
  const now = options.now ?? (() => Date.now());

  return async (context: TaskContext): Promise<TaskOutcome> => {
    const payload = context.task.payload;
    if (!isPlanPayload(payload)) {
      return { kind: 'failed', error: 'a plan task needs a goal and a projectDir' };
    }

    const memory = readMemory(context.task.checkpoint);

    /* ---------- where it goes ---------- */

    const projectDir = payload.projectDir?.trim() || memory.projectDir || options.resolveProjectDir?.(payload.goal);
    if (!projectDir) {
      return {
        kind: 'failed',
        error:
          'this goal did not say which folder to build in, and this machine has no default workspace ' +
          'to put it in — give it a project folder',
      };
    }
    if (projectDir !== memory.projectDir) {
      memory.projectDir = projectDir;
      options.ensureDir?.(projectDir);
      context.log(`building in ${projectDir}`);
      await context.checkpoint(memoryToJson(memory));
    }
    const work = { ...payload, projectDir };

    /* ---------- round one: think ---------- */

    if (!memory.blueprint) {
      const existingFiles = await Promise.resolve(options.listFiles?.(projectDir) ?? []).catch(() => []);
      const coders = options.coders?.() ?? [];
      context.log(`planning "${payload.goal.slice(0, 80)}"`);

      let answer: string;
      try {
        answer = await options.think(
          planningPrompt({
            goal: payload.goal,
            projectDir,
            existingFiles,
            coders,
            ...(payload.notes ? { notes: payload.notes } : {}),
          }),
          'plan',
        );
      } catch (error) {
        // No key, no quota, no network. Waiting is right — the machine and the
        // coding agents are fine, it is only the thinking that is unavailable.
        return {
          kind: 'parked',
          until: now() + 15 * 60_000,
          reason: `could not reach a planning model: ${(error as Error).message}`,
        };
      }

      const parsed = parseBlueprint(answer, { goal: payload.goal });
      if (!parsed.ok) {
        return {
          kind: 'failed',
          error: `${parsed.error}. The planner said: ${answer.trim().slice(-600) || '(nothing)'}`,
        };
      }
      memory.blueprint = parsed.blueprint;
      memory.repairs = parsed.repairs;

      const gaps = missingSurfaces(parsed.blueprint, WEB_APP_SURFACES);
      context.log(
        `planned ${parsed.blueprint.pieces.length} pieces across ${
          new Set(parsed.blueprint.pieces.map((piece) => piece.surface)).size
        } surfaces` + (gaps.length > 0 ? ` — nothing for ${gaps.join(', ')}` : ''),
      );
      for (const repair of parsed.repairs) context.log(`plan needed fixing: ${repair}`);
      await context.checkpoint(memoryToJson(memory));
    }

    const blueprint = memory.blueprint;

    /* ---------- every round: look, then hand out ---------- */

    for (const [pieceId, taskId] of Object.entries(memory.children)) {
      const child = await options.mesh.store.getTask(taskId);
      const state = pieceStateOf(child);
      const summary = summaryOf(child);
      const previous = memory.statuses[pieceId]?.state;
      memory.statuses[pieceId] = { id: pieceId, state, ...(summary ? { summary } : {}) };
      if (state !== previous && (state === 'done' || state === 'failed')) {
        const piece = blueprint.pieces.find((entry) => entry.id === pieceId);
        context.log(`${piece?.title ?? pieceId}: ${state === 'done' ? 'finished' : `failed — ${child?.error ?? 'no reason given'}`}`);
      }
    }

    const outstanding = Object.keys(memory.children).filter(
      (pieceId) => memory.statuses[pieceId]?.state === 'running',
    ).length;
    const maxParallel = Math.max(1, payload.maxParallel ?? DEFAULT_MAX_PARALLEL);

    const decision = schedule(blueprint, {
      slots: Math.max(0, maxParallel - outstanding),
      statuses: memory.statuses,
    });

    // Marked before any brief is written, so two pieces starting in the same
    // round each see the other in their hands-off list. Written the other way
    // round, the first one out is told the project is quiet and edits straight
    // through the second one's files.
    for (const piece of decision.start) memory.statuses[piece.id] = { id: piece.id, state: 'running' };
    for (const piece of decision.start) {
      const child = await enqueuePiece(options.mesh, piece, blueprint, work, memory, context.task.id);
      memory.children[piece.id] = child.id;
      context.log(`handed out "${piece.title}" (${piece.surface})`);
    }

    // A piece whose dependency died is never coming; leaving it pending is how
    // a plan parks for ever with nothing left that could possibly finish it.
    for (const { piece, reason } of decision.blocked) {
      if (memory.statuses[piece.id]?.state === 'blocked') continue;
      memory.statuses[piece.id] = { id: piece.id, state: 'blocked', summary: reason };
      context.log(`${piece.title}: ${reason}`);
    }

    memory.rounds += 1;
    await context.checkpoint(memoryToJson(memory));

    /* ---------- are we there yet ---------- */

    const progress = progressOf(blueprint, memory.statuses);
    if (progress.finished) {
      const failed = blueprint.pieces.filter((piece) => memory.statuses[piece.id]?.state === 'failed');
      const blocked = blueprint.pieces.filter((piece) => memory.statuses[piece.id]?.state === 'blocked');
      if (progress.done === 0) {
        return {
          kind: 'failed',
          error:
            `nothing in "${blueprint.projectName}" was built — ` +
            failed.map((piece) => piece.title).join(', ') +
            ' failed' +
            (blocked.length > 0 ? `, and ${blocked.length} more could never start` : ''),
        };
      }
      return {
        kind: 'done',
        result: {
          projectName: blueprint.projectName,
          summary: blueprint.summary,
          stack: blueprint.stack,
          decisions: blueprint.decisions,
          additions: blueprint.additions,
          risks: blueprint.risks,
          pieces: blueprint.pieces.length,
          completed: progress.done,
          failed: failed.length,
          blocked: blocked.length,
          failedPieces: failed.map((piece) => piece.title),
          blockedPieces: blocked.map((piece) => piece.title),
          repairs: memory.repairs,
        } as JsonObject,
      };
    }

    const waiting = decision.waiting[0]?.reason;
    return {
      kind: 'parked',
      until: now() + pollMs,
      reason:
        `${progress.done}/${progress.total} pieces done, ${progress.running} in flight` +
        (waiting ? ` — next: ${waiting}` : ''),
    };
  };
}

/** Queue one piece as work for a real coding agent. */
async function enqueuePiece(
  mesh: Mesh,
  piece: WorkPiece,
  blueprint: Blueprint,
  payload: PlanTaskPayload & { projectDir: string },
  memory: PlanMemory,
  parentId: string,
): Promise<MeshTask> {
  const prompt = writePrompt(piece, blueprint, {
    projectDir: payload.projectDir,
    busyFiles: busyFiles(blueprint, memory.statuses, piece.id),
    completed: completedSummaries(blueprint, memory.statuses),
    ...(payload.verifyCommand ? { verifyCommand: payload.verifyCommand } : {}),
    ...(payload.houseRules ? { houseRules: payload.houseRules } : {}),
  });

  return mesh.enqueue({
    title: taskTitle(piece, blueprint),
    requires: ['shell'],
    // Coding is terminal work: it runs while you are on the machine. Only the
    // pieces that need the screen are marked otherwise, and none of these do.
    interactive: false,
    payload: {
      kind: 'coder',
      goal: blueprint.summary || payload.goal,
      task: prompt,
      projectDir: payload.projectDir,
      // The files this piece owns, so two agents in one repository never edit
      // the same file at the same time.
      scope: piece.files,
      surface: piece.surface,
      planTaskId: parentId,
      pieceId: piece.id,
      ...(payload.goalId ? { goalId: payload.goalId } : {}),
      ...(piece.notes ? { notes: piece.notes } : {}),
    } as JsonObject,
  });
}
