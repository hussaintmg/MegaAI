import test from 'node:test';
import assert from 'node:assert/strict';
import type { Blueprint, WorkPiece } from './blueprint.js';
import { busyFiles, completedSummaries, pathsCollide, piecesCollide, progressOf, schedule, type PieceStatus } from './schedule.js';

function piece(id: string, files: string[], dependsOn: string[] = []): WorkPiece {
  return { id, title: id.toUpperCase(), surface: 'backend', intent: `do ${id}`, files, acceptance: [], dependsOn };
}

function plan(...pieces: WorkPiece[]): Blueprint {
  return { projectName: 'p', summary: '', stack: [], decisions: [], additions: [], risks: [], pieces };
}

const NOTHING: Record<string, PieceStatus> = {};

test('a folder and a file inside it are the same place', () => {
  assert.equal(pathsCollide('app/api', 'app/api/cars/route.ts'), true);
  assert.equal(pathsCollide('app/api/**', 'app/api/cars/route.ts'), true);
  assert.equal(pathsCollide('app/api/*.ts', 'app/api/cars/route.ts'), true);
  assert.equal(pathsCollide('app/api/cars/route.ts', 'app/api/orders/route.ts'), false);
  // Not a prefix in the string sense — "app/apix" is a different folder.
  assert.equal(pathsCollide('app/api', 'app/apix/route.ts'), false);
});

test('a piece with no file list collides with everything, because nothing bounds it', () => {
  assert.equal(piecesCollide(piece('a', []), piece('b', ['b.ts'])), true);
  assert.equal(piecesCollide(piece('a', ['a.ts']), piece('b', ['b.ts'])), false);
});

test('pieces in different files start together — this is the whole point', () => {
  const blueprint = plan(piece('a', ['app/api/cars/route.ts']), piece('b', ['components/Nav.tsx']), piece('c', ['lib/db.ts']));
  const result = schedule(blueprint, { slots: 3, statuses: NOTHING });
  assert.deepEqual(result.start.map((entry) => entry.id).sort(), ['a', 'b', 'c']);
});

test('two pieces in the same file never start together', () => {
  const blueprint = plan(piece('a', ['app/page.tsx']), piece('b', ['app/page.tsx']));
  const result = schedule(blueprint, { slots: 4, statuses: NOTHING });
  assert.equal(result.start.length, 1);
  assert.match(result.waiting[0]?.reason ?? '', /working in the same files/);
});

test('a piece whose dependency is unfinished waits, and says which', () => {
  const blueprint = plan(piece('db', ['lib/db.ts']), piece('api', ['app/api/route.ts'], ['db']));
  const result = schedule(blueprint, { slots: 4, statuses: NOTHING });
  assert.deepEqual(result.start.map((entry) => entry.id), ['db']);
  assert.match(result.waiting[0]?.reason ?? '', /waiting for DB/);
});

test('a dependency that failed blocks the work rather than leaving it pending forever', () => {
  const blueprint = plan(piece('db', ['lib/db.ts']), piece('api', ['app/api/route.ts'], ['db']));
  const result = schedule(blueprint, { slots: 4, statuses: { db: { id: 'db', state: 'failed' } } });
  assert.equal(result.start.length, 0);
  // Kept apart from `waiting` because the caller has to mark it dead: left in
  // with the rest, the plan parks for ever on something that is not coming.
  assert.deepEqual(result.waiting, []);
  assert.equal(result.blocked[0]?.piece.id, 'api');
  assert.match(result.blocked[0]?.reason ?? '', /did not finish/);
});

test('the piece that unblocks the most work goes first', () => {
  // Written in the order a model tends to write them: the page first, because
  // it is the visible part, and the schema last.
  const blueprint = plan(
    piece('ui', ['app/page.tsx'], ['api']),
    piece('api', ['app/api/route.ts'], ['db']),
    piece('db', ['lib/db.ts']),
    piece('docs', ['README.md']),
  );
  const result = schedule(blueprint, { slots: 1, statuses: NOTHING });
  assert.deepEqual(result.start.map((entry) => entry.id), ['db'], 'or four agents wait on a schema nobody started');
});

test('with no free agent, ready work says it is ready rather than looking blocked', () => {
  const blueprint = plan(piece('a', ['a.ts']), piece('b', ['b.ts']));
  const result = schedule(blueprint, { slots: 0, statuses: NOTHING });
  assert.equal(result.start.length, 0);
  assert.equal(result.waiting.length, 2);
  assert.match(result.waiting[0]?.reason ?? '', /waiting for a coding agent to come free/);
});

test('a piece already running holds its files against the next round', () => {
  const blueprint = plan(piece('a', ['app/api']), piece('b', ['app/api/cars/route.ts']), piece('c', ['app/page.tsx']));
  const result = schedule(blueprint, { slots: 3, statuses: { a: { id: 'a', state: 'running' } } });
  assert.deepEqual(result.start.map((entry) => entry.id), ['c']);
  assert.match(result.waiting.find((entry) => entry.piece.id === 'b')?.reason ?? '', /same files/);
});

test('one free slot starts one piece, and the rest are still explained', () => {
  const blueprint = plan(piece('a', ['a.ts']), piece('b', ['b.ts']), piece('c', ['c.ts']));
  const result = schedule(blueprint, { slots: 1, statuses: NOTHING });
  assert.equal(result.start.length, 1);
  assert.equal(result.waiting.length, 2);
});

test('progress counts what finished, what is running and what died', () => {
  const blueprint = plan(piece('a', ['a.ts']), piece('b', ['b.ts']), piece('c', ['c.ts']), piece('d', ['d.ts']));
  const statuses: Record<string, PieceStatus> = {
    a: { id: 'a', state: 'done' },
    b: { id: 'b', state: 'running' },
    c: { id: 'c', state: 'failed' },
  };
  const progress = progressOf(blueprint, statuses);
  assert.deepEqual(
    { total: progress.total, done: progress.done, running: progress.running, failed: progress.failed },
    { total: 4, done: 1, running: 1, failed: 1 },
  );
  assert.equal(progress.finished, false, 'd has not been touched');
  statuses['b'] = { id: 'b', state: 'done' };
  statuses['d'] = { id: 'd', state: 'done' };
  assert.equal(progressOf(blueprint, statuses).finished, true);
});

test('what is finished, and what is being touched, is what the next brief needs', () => {
  const blueprint = plan(piece('a', ['a.ts']), piece('b', ['b.ts']), piece('c', ['c.ts']));
  const statuses: Record<string, PieceStatus> = {
    a: { id: 'a', state: 'done', summary: 'wrote the schema' },
    b: { id: 'b', state: 'running' },
  };
  assert.deepEqual(completedSummaries(blueprint, statuses), [{ title: 'A', summary: 'wrote the schema' }]);
  assert.deepEqual(busyFiles(blueprint, statuses), ['b.ts']);
  assert.deepEqual(busyFiles(blueprint, statuses, 'b'), [], 'a piece is not warned off its own files');
});
