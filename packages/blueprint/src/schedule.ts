/**
 * Who can start right now.
 *
 * This is the watching part, written as arithmetic rather than as a model
 * looking at a screen. A human keeping four coding agents busy is doing exactly
 * this and nothing more: seeing which one just went quiet, checking that the
 * next piece is not waiting on something unfinished, checking that nobody else
 * is already in those files, and starting it.
 *
 * Doing it as a function rather than a prompt means it is right every time,
 * costs nothing, and can be tested — which matters, because the failure mode is
 * two agents rewriting one file at 3am and neither of them noticing.
 */

import type { Blueprint, WorkPiece } from './blueprint.js';

export type PieceState = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

export interface PieceStatus {
  id: string;
  state: PieceState;
  /** Its one-line summary once it finished, for the next agent's brief. */
  summary?: string;
}

/**
 * Does one file scope collide with another?
 *
 * Directory-aware, because a plan that says `app/api/` and another that says
 * `app/api/cars/route.ts` are the same place. Bare `*` and `**` are treated as
 * "everything under here", which is how models write them.
 */
export function pathsCollide(a: string, b: string): boolean {
  const left = trimGlob(a);
  const right = trimGlob(b);
  if (left === '' || right === '') return true;
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function trimGlob(file: string): string {
  return file
    .replace(/\\/g, '/')
    .replace(/\/?\*+(?:\.[a-z0-9]+)?$/i, '')
    .replace(/\/+$/, '')
    .replace(/^\.\//, '')
    .trim();
}

/**
 * Two pieces that must not run at the same time.
 *
 * A piece with no file list has no boundary, so it collides with everything —
 * the safe reading, and the one that makes "the planner forgot to list files"
 * cost throughput instead of correctness.
 */
export function piecesCollide(a: WorkPiece, b: WorkPiece): boolean {
  if (a.id === b.id) return false;
  if (a.files.length === 0 || b.files.length === 0) return true;
  return a.files.some((left) => b.files.some((right) => pathsCollide(left, right)));
}

export interface ScheduleOptions {
  /** How many more can be started right now. */
  slots: number;
  statuses: Record<string, PieceStatus>;
}

export interface ScheduleResult {
  /** Start these, in this order. */
  start: WorkPiece[];
  /** Everything not starting, and the reason, for showing rather than guessing. */
  waiting: Array<{ piece: WorkPiece; reason: string }>;
  /**
   * These can never run: something they needed died.
   *
   * Separated from `waiting` because the caller has to act on it. Left in with
   * the rest, a plan whose first piece failed parks for ever waiting on a
   * dependency that is not coming — which looks exactly like work in progress
   * and is the worst way for a night to be wasted.
   */
  blocked: Array<{ piece: WorkPiece; reason: string }>;
}

/**
 * Decide what to start.
 *
 * The order is deliberate: pieces whose surface unblocks the most other work go
 * first, so the database and the API are underway before four frontend agents
 * discover they have nothing to build against.
 */
export function schedule(blueprint: Blueprint, options: ScheduleOptions): ScheduleResult {
  const statuses = options.statuses;
  const byId = new Map(blueprint.pieces.map((piece) => [piece.id, piece]));
  const stateOf = (id: string): PieceState => statuses[id]?.state ?? 'pending';

  const running = blueprint.pieces.filter((piece) => stateOf(piece.id) === 'running');
  const start: WorkPiece[] = [];
  const waiting: Array<{ piece: WorkPiece; reason: string }> = [];
  const blocked: Array<{ piece: WorkPiece; reason: string }> = [];
  let slots = Math.max(0, options.slots);

  const candidates = blueprint.pieces
    .filter((piece) => stateOf(piece.id) === 'pending')
    .sort((a, b) => unblocks(b, blueprint) - unblocks(a, blueprint) || blueprint.pieces.indexOf(a) - blueprint.pieces.indexOf(b));

  for (const piece of candidates) {
    const unfinished = piece.dependsOn.filter((dep) => stateOf(dep) !== 'done');
    if (unfinished.length > 0) {
      const dead = unfinished.filter((dep) => stateOf(dep) === 'failed' || stateOf(dep) === 'blocked');
      if (dead.length > 0) {
        blocked.push({
          piece,
          reason: `cannot run — it needs ${dead
            .map((dep) => byId.get(dep)?.title ?? dep)
            .join(', ')}, which did not finish`,
        });
        continue;
      }
      waiting.push({ piece, reason: `waiting for ${unfinished.map((dep) => byId.get(dep)?.title ?? dep).join(', ')}` });
      continue;
    }

    const clash = [...running, ...start].find((other) => piecesCollide(piece, other));
    if (clash) {
      waiting.push({
        piece,
        reason:
          piece.files.length === 0
            ? 'no file list, so it waits until the project is quiet'
            : `"${clash.title}" is working in the same files`,
      });
      continue;
    }

    if (slots <= 0) {
      waiting.push({ piece, reason: 'ready — waiting for a coding agent to come free' });
      continue;
    }

    start.push(piece);
    slots -= 1;
  }

  return { start, waiting, blocked };
}

/** How many other pieces are waiting on this one, transitively. */
function unblocks(piece: WorkPiece, blueprint: Blueprint): number {
  const direct = blueprint.pieces.filter((other) => other.dependsOn.includes(piece.id));
  return direct.length + direct.reduce((sum, other) => sum + unblocks(other, blueprint), 0);
}

/** Where the plan stands, in the words the dashboard uses. */
export function progressOf(
  blueprint: Blueprint,
  statuses: Record<string, PieceStatus>,
): { total: number; done: number; running: number; failed: number; ratio: number; finished: boolean } {
  const states = blueprint.pieces.map((piece) => statuses[piece.id]?.state ?? 'pending');
  const total = states.length;
  const done = states.filter((state) => state === 'done').length;
  const running = states.filter((state) => state === 'running').length;
  const failed = states.filter((state) => state === 'failed' || state === 'blocked').length;
  return {
    total,
    done,
    running,
    failed,
    ratio: total === 0 ? 0 : done / total,
    finished: total > 0 && done + failed === total,
  };
}

/** The pieces that are done, for the next agent's "already finished" list. */
export function completedSummaries(
  blueprint: Blueprint,
  statuses: Record<string, PieceStatus>,
): Array<{ title: string; summary?: string }> {
  return blueprint.pieces
    .filter((piece) => statuses[piece.id]?.state === 'done')
    .map((piece) => {
      const summary = statuses[piece.id]?.summary;
      return { title: piece.title, ...(summary ? { summary } : {}) };
    });
}

/** Files being worked on right now — the hands-off list in the next prompt. */
export function busyFiles(blueprint: Blueprint, statuses: Record<string, PieceStatus>, exceptId?: string): string[] {
  return [
    ...new Set(
      blueprint.pieces
        .filter((piece) => piece.id !== exceptId && statuses[piece.id]?.state === 'running')
        .flatMap((piece) => piece.files),
    ),
  ];
}
