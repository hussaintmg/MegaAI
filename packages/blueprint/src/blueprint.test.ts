import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEB_APP_SURFACES,
  blueprintFromJson,
  extractJson,
  missingSurfaces,
  parseBlueprint,
  planningPrompt,
} from './blueprint.js';

const GOOD_PLAN = {
  projectName: 'car-showroom',
  summary: 'A 3D showroom where a visitor can rotate a car and book a test drive.',
  stack: ['Next.js 16 App Router', 'TypeScript', 'MongoDB', 'three.js'],
  decisions: ['react-three-fiber rather than raw three.js, so the scene is a component'],
  additions: ['A sign-in, because bookings need an owner and the request did not mention one'],
  risks: ['A 40 MB car model on a phone is unusable — budget 4 MB and draco-compress it'],
  pieces: [
    {
      id: 'db-1',
      title: 'Car and booking collections',
      surface: 'database',
      intent: 'Define the two collections and their indexes.',
      files: ['lib/db.ts', 'lib/models/car.ts'],
      acceptance: ['a unique index on car.slug exists'],
      dependsOn: [],
    },
    {
      id: 'api-1',
      title: 'Car API',
      surface: 'backend',
      intent: 'List and read cars.',
      files: ['app/api/cars/route.ts'],
      acceptance: ['GET /api/cars returns 200 with an array'],
      dependsOn: ['db-1'],
    },
    {
      id: 'ui-1',
      title: 'Showroom page',
      surface: 'frontend',
      intent: 'The page with the rotating car.',
      files: ['app/page.tsx', 'components/Showroom.tsx'],
      acceptance: ['the car rotates with a drag on a phone'],
      dependsOn: ['api-1'],
    },
  ],
};

test('the planning brief names every surface the planner has to answer for', () => {
  const prompt = planningPrompt({ goal: 'build a 3D car showroom', coders: ['claude', 'codex'] });
  for (const surface of ['Database', 'Backend', 'Frontend', 'Design', 'Animation', 'Security', 'Testing', 'Infra']) {
    assert.match(prompt, new RegExp(`\\*\\*${surface}\\*\\*`), `${surface} has to be asked about explicitly`);
  }
  // The one instruction that makes parallel work safe at all.
  assert.match(prompt, /Every piece names the files it owns/);
  assert.match(prompt, /claude, codex/);
});

test('an empty folder and an existing project get different briefs', () => {
  const fresh = planningPrompt({ goal: 'add checkout' });
  assert.match(fresh, /This is a new project/);
  const existing = planningPrompt({ goal: 'add checkout', existingFiles: ['app/page.tsx', 'lib/db.ts'] });
  assert.match(existing, /do not plan it from scratch/);
  assert.match(existing, /- app\/page\.tsx/);
});

test('a clean plan is read as written', () => {
  const parsed = parseBlueprint(JSON.stringify(GOOD_PLAN));
  assert.ok(parsed.ok);
  assert.equal(parsed.blueprint.projectName, 'car-showroom');
  assert.equal(parsed.blueprint.pieces.length, 3);
  assert.deepEqual(parsed.blueprint.pieces[2]?.dependsOn, ['api-1']);
  assert.deepEqual(parsed.repairs, [], 'nothing needed repairing');
});

test('JSON buried in the model\'s prose is still found', () => {
  const answer = `Sure — here is the plan.\n\n\`\`\`json\n${JSON.stringify(GOOD_PLAN)}\n\`\`\`\n\nLet me know if you want it split differently.`;
  const parsed = parseBlueprint(answer);
  assert.ok(parsed.ok);
  assert.equal(parsed.blueprint.pieces.length, 3);
});

test('a brace inside a string does not end the object early', () => {
  // File lists carry Windows paths and regexes; a naive lastIndexOf('}') cuts
  // the plan in half on the first one of these and the whole night is lost.
  const text = `noise {"projectName":"x","summary":"uses {curly} braces \\" and C:\\\\a\\\\b","pieces":[{"title":"t","intent":"i","surface":"backend","files":["a.ts"],"acceptance":["x"]}]} trailing`;
  const json = extractJson(text);
  assert.ok(json);
  const parsed = parseBlueprint(text);
  assert.ok(parsed.ok);
  assert.equal(parsed.blueprint.summary, 'uses {curly} braces " and C:\\a\\b');
});

test('an answer with no JSON at all says so plainly', () => {
  const parsed = parseBlueprint('I would start by researching the market.');
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok === false ? parsed.error : '', /did not return JSON/);
});

test('a plan with no pieces is refused rather than queued as nothing', () => {
  const parsed = parseBlueprint(JSON.stringify({ projectName: 'x', pieces: [] }));
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok === false ? parsed.error : '', /nothing to hand to an agent/);
});

test('the names models actually use are read as the surfaces they mean', () => {
  const parsed = parseBlueprint(
    JSON.stringify({
      projectName: 'x',
      pieces: [
        { title: 'a', intent: 'i', surface: 'API', files: ['a.ts'], acceptance: ['x'] },
        { title: 'b', intent: 'i', surface: 'UI/UX', files: ['b.ts'], acceptance: ['x'] },
        { title: 'c', intent: 'i', surface: 'auth', files: ['c.ts'], acceptance: ['x'] },
        { title: 'd', intent: 'i', surface: 'deployment', files: ['d.ts'], acceptance: ['x'] },
      ],
    }),
  );
  assert.ok(parsed.ok);
  assert.deepEqual(
    parsed.blueprint.pieces.map((piece) => piece.surface),
    ['backend', 'design', 'security', 'infra'],
  );
});

test('a dependency written as a title is resolved to the piece it names', () => {
  const parsed = parseBlueprint(
    JSON.stringify({
      projectName: 'x',
      pieces: [
        { id: 'a', title: 'Car collections', intent: 'i', surface: 'database', files: ['a.ts'], acceptance: ['x'] },
        {
          id: 'b',
          title: 'Cars API',
          intent: 'i',
          surface: 'backend',
          files: ['b.ts'],
          acceptance: ['x'],
          dependsOn: ['Car collections'],
        },
      ],
    }),
  );
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.blueprint.pieces[1]?.dependsOn, ['a'], 'or the API gets built before the schema exists');
});

test('two pieces waiting on each other would never start, so the loop is cut and reported', () => {
  const parsed = parseBlueprint(
    JSON.stringify({
      projectName: 'x',
      pieces: [
        { id: 'a', title: 'A', intent: 'i', surface: 'backend', files: ['a.ts'], acceptance: ['x'], dependsOn: ['b'] },
        { id: 'b', title: 'B', intent: 'i', surface: 'frontend', files: ['b.ts'], acceptance: ['x'], dependsOn: ['a'] },
      ],
    }),
  );
  assert.ok(parsed.ok);
  const stillCircular = parsed.blueprint.pieces.every((piece) => piece.dependsOn.includes(piece.id === 'a' ? 'b' : 'a'));
  assert.equal(stillCircular, false);
  assert.ok(parsed.repairs.some((line) => /waited for each other/.test(line)));
});

test('a piece with no files is accepted but the cost is said out loud', () => {
  const parsed = parseBlueprint(
    JSON.stringify({ projectName: 'x', pieces: [{ title: 'Everything', intent: 'i', surface: 'backend' }] }),
  );
  assert.ok(parsed.ok);
  assert.ok(parsed.repairs.some((line) => /cannot run beside anything else/.test(line)));
  assert.ok(parsed.repairs.some((line) => /no acceptance criteria/.test(line)));
});

test('duplicate ids are separated, because dependsOn points at one of them', () => {
  const parsed = parseBlueprint(
    JSON.stringify({
      projectName: 'x',
      pieces: [
        { id: 'p1', title: 'A', intent: 'i', surface: 'backend', files: ['a.ts'], acceptance: ['x'] },
        { id: 'p1', title: 'B', intent: 'i', surface: 'backend', files: ['b.ts'], acceptance: ['x'] },
      ],
    }),
  );
  assert.ok(parsed.ok);
  const ids = parsed.blueprint.pieces.map((piece) => piece.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('Windows paths in a plan become the forward slashes everything else uses', () => {
  const parsed = parseBlueprint(
    JSON.stringify({
      projectName: 'x',
      pieces: [{ title: 'A', intent: 'i', surface: 'backend', files: ['app\\api\\cars\\route.ts', './lib/db.ts'], acceptance: ['x'] }],
    }),
  );
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.blueprint.pieces[0]?.files, ['app/api/cars/route.ts', 'lib/db.ts']);
});

test('a plan that skipped the boring half is caught', () => {
  const parsed = parseBlueprint(
    JSON.stringify({
      projectName: 'x',
      pieces: [
        { title: 'Pages', intent: 'i', surface: 'frontend', files: ['a.tsx'], acceptance: ['x'] },
        { title: 'Look', intent: 'i', surface: 'design', files: ['b.css'], acceptance: ['x'] },
      ],
    }),
  );
  assert.ok(parsed.ok);
  assert.deepEqual(missingSurfaces(parsed.blueprint, WEB_APP_SURFACES), ['database', 'backend', 'security']);
});

test('a blueprint survives a round trip through the task checkpoint', () => {
  const parsed = parseBlueprint(JSON.stringify(GOOD_PLAN));
  assert.ok(parsed.ok);
  const back = blueprintFromJson(JSON.parse(JSON.stringify(parsed.blueprint)));
  assert.deepEqual(back?.pieces.map((piece) => piece.id), ['db-1', 'api-1', 'ui-1']);
});
