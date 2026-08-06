import test from 'node:test';
import assert from 'node:assert/strict';
import type { Blueprint, WorkPiece } from './blueprint.js';
import { taskTitle, writeAllPrompts, writePrompt } from './prompts.js';

const PIECE: WorkPiece = {
  id: 'ui-1',
  title: 'Showroom page',
  surface: 'frontend',
  intent: 'Build the page that shows one car rotating, with a booking button under it.',
  files: ['app/page.tsx', 'components/Showroom.tsx'],
  acceptance: ['the car rotates with a drag on a phone', 'the booking button is reachable by keyboard'],
  dependsOn: ['api-1'],
  notes: ['The model is already at public/models/car.glb — do not fetch another one'],
};

const BLUEPRINT: Blueprint = {
  projectName: 'car-showroom',
  summary: 'A 3D showroom where a visitor can rotate a car and book a test drive.',
  stack: ['Next.js 16 App Router', 'three.js'],
  decisions: [],
  additions: [],
  risks: [],
  pieces: [
    PIECE,
    {
      id: 'api-1',
      title: 'Car API',
      surface: 'backend',
      intent: 'List and read cars.',
      files: ['app/api/cars/route.ts'],
      acceptance: ['GET /api/cars returns 200'],
      dependsOn: [],
    },
  ],
};

test('the brief carries everything an agent needs and nothing it has to guess', () => {
  const prompt = writePrompt(PIECE, BLUEPRINT, { projectDir: 'C:/projects/showroom' });

  assert.match(prompt, /# Showroom page/);
  assert.match(prompt, /A 3D showroom where a visitor/, 'what the project is');
  assert.match(prompt, /Next\.js 16 App Router · three\.js/, 'the stack, so it does not pick its own');
  assert.match(prompt, /C:\/projects\/showroom/, 'where it is');
  assert.match(prompt, /Build the page that shows one car rotating/, 'its actual job');
  assert.match(prompt, /`app\/page\.tsx`/, 'the files it owns');
  assert.match(prompt, /1\. the car rotates with a drag on a phone/, 'numbered acceptance');
  assert.match(prompt, /public\/models\/car\.glb/, 'what was already decided');
  assert.match(prompt, /No placeholders/, 'the standard');
  assert.match(prompt, /## Finish with/, 'and how to hand over');
});

test('the files another agent is in right now are listed as hands-off', () => {
  const prompt = writePrompt(PIECE, BLUEPRINT, {
    projectDir: '/p',
    busyFiles: ['app/api/cars/route.ts', 'app/page.tsx'],
  });
  assert.match(prompt, /Do not touch — another agent is in these right now/);
  assert.match(prompt, /`app\/api\/cars\/route\.ts`/);
  // Its own files must never appear in its own hands-off list, or it will
  // refuse to do the thing it was asked to do.
  const handsOff = prompt.slice(prompt.indexOf('Do not touch'));
  assert.doesNotMatch(handsOff.slice(0, handsOff.indexOf('## ', 5)), /app\/page\.tsx/);
});

test('a piece with no file list is told it has the project to itself', () => {
  const prompt = writePrompt({ ...PIECE, files: [] }, BLUEPRINT, { projectDir: '/p' });
  assert.match(prompt, /nothing else is running while you work/);
  assert.doesNotMatch(prompt, /Files you own/);
});

test('what the others already finished is passed on, so the work is not redone', () => {
  const prompt = writePrompt(PIECE, BLUEPRINT, {
    projectDir: '/p',
    completed: [{ title: 'Car API', summary: 'GET and POST /api/cars, validated with zod' }],
  });
  assert.match(prompt, /Already finished by the others/);
  assert.match(prompt, /validated with zod/);
});

test('the verify command and the house rules are carried through', () => {
  const prompt = writePrompt(PIECE, BLUEPRINT, {
    projectDir: '/p',
    verifyCommand: 'npm run build && npm test',
    houseRules: ['No new dependencies without saying why'],
  });
  assert.match(prompt, /npm run build && npm test/);
  assert.match(prompt, /No new dependencies without saying why/);
});

test('every piece gets a brief, each blind to its own files in the hands-off list', () => {
  const all = writeAllPrompts(BLUEPRINT, { projectDir: '/p' });
  assert.equal(all.length, 2);
  const api = all.find((entry) => entry.piece.id === 'api-1');
  assert.match(api?.prompt ?? '', /`app\/page\.tsx`/, 'the other piece\'s files are hands-off');
  const ownSection = (api?.prompt ?? '').split('## Do not touch')[1] ?? '';
  assert.doesNotMatch(ownSection.split('## ')[0] ?? '', /app\/api\/cars\/route\.ts/);
});

test('the queue title says the surface first, for reading on a phone', () => {
  assert.equal(taskTitle(PIECE, BLUEPRINT), 'car-showroom · frontend · Showroom page');
});

test('the brief never runs three blank lines together', () => {
  // Sections are appended conditionally, and empty ones used to leave gaps that
  // some CLIs read as the end of the prompt.
  const prompt = writePrompt({ ...PIECE, notes: [], acceptance: [] }, BLUEPRINT, { projectDir: '/p' });
  assert.doesNotMatch(prompt, /\n\n\n/);
});
