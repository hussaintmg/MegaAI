/**
 * The plan, before anybody writes a line of code.
 *
 * One sentence arrives — "build me a 3D car showroom" — and it is nowhere near
 * enough to hand to a coding agent. What a coding agent needs is a brief: what
 * the thing is, what stack it is on, which files it owns, what "done" means,
 * and what it must not touch because somebody else is in there.
 *
 * This file is the shape of that plan and the reading of it. A model writes
 * the plan (that is the one job MegaAI's own model keeps — thinking, never
 * typing); everything downstream is mechanical, so it is all here and all
 * testable without a model.
 *
 * The parsing is deliberately forgiving. A model asked for JSON returns JSON
 * wrapped in prose about half the time, invents a field name, or numbers its
 * pieces "1" instead of "be-1". None of that is worth failing a night's work
 * over, so anything recoverable is recovered and anything genuinely missing is
 * named.
 */

import type { JsonObject } from '@megaai/types';

/**
 * The parts of a piece of software somebody has to actually think about.
 *
 * Named rather than free-text because the planner is measured against them:
 * a plan for a web app with nothing under `security` or `database` is a plan
 * that skipped the boring half, and `missingSurfaces()` says so.
 */
export const SURFACES = [
  'research',
  'database',
  'backend',
  'frontend',
  'design',
  'animation',
  'security',
  'testing',
  'infra',
] as const;

export type Surface = (typeof SURFACES)[number];

/** One piece of work, small enough for one agent to finish in one sitting. */
export interface WorkPiece {
  id: string;
  title: string;
  surface: Surface;
  /** What must be true when this is done. The heart of the prompt. */
  intent: string;
  /**
   * The paths this piece owns.
   *
   * This is the field that makes parallel agents safe. Two pieces whose paths
   * do not overlap can run at the same time in the same repository; two that
   * do overlap never will. Empty means "anywhere", which is honest and costs
   * the piece its parallelism — it waits for the project to be quiet.
   */
  files: string[];
  /** How you would check it, concretely, in order. */
  acceptance: string[];
  /** Ids of pieces that must be finished first. */
  dependsOn: string[];
  /** Anything the agent would otherwise have to guess. */
  notes?: string[];
}

export interface Blueprint {
  projectName: string;
  /** One paragraph: what is being built and for whom. */
  summary: string;
  /** "Next.js 16 App Router", "MongoDB Atlas", "Tailwind", "three.js" … */
  stack: string[];
  /** Calls the planner made that the request did not make for it. */
  decisions: string[];
  /** Things it decided to add because the request would be poor without them. */
  additions: string[];
  /** What could go wrong, in the planner's own words. */
  risks: string[];
  pieces: WorkPiece[];
}

/* ------------------------------------------------------------------ *
 * Asking for one
 * ------------------------------------------------------------------ */

export interface PlanRequest {
  goal: string;
  /** The folder the work lands in, so paths in the plan are real paths. */
  projectDir?: string;
  /** What is already there — an empty folder gets a very different plan. */
  existingFiles?: string[];
  /** Which coding agents this machine actually has. */
  coders?: string[];
  /** Anything the person added. */
  notes?: string[];
}

/**
 * The instruction the planning model is given.
 *
 * Long on purpose. Every paragraph here is a plan I have seen come back wrong:
 * six pieces that all say "implement the backend", pieces with no file lists so
 * nothing can run in parallel, acceptance criteria like "it works", and plans
 * that answer the request exactly as typed without noticing the request is
 * missing authentication.
 */
export function planningPrompt(request: PlanRequest): string {
  const lines: string[] = [
    'You are the planner for a team of coding agents. You do not write code.',
    'You decide what gets built, break it into pieces that can be built at the',
    'same time by different agents, and write down how each piece is judged.',
    '',
    '## The request',
    request.goal.trim(),
    '',
  ];

  if (request.notes && request.notes.length > 0) {
    lines.push('## Also said', ...request.notes.map((note) => `- ${note}`), '');
  }
  if (request.projectDir) {
    lines.push('## Where it goes', request.projectDir, '');
  }
  if (request.existingFiles && request.existingFiles.length > 0) {
    lines.push(
      '## What is already in that folder',
      ...request.existingFiles.slice(0, 120).map((file) => `- ${file}`),
      request.existingFiles.length > 120 ? `- …and ${request.existingFiles.length - 120} more` : '',
      '',
      'This is an existing project. Plan changes to it — do not plan it from scratch.',
      '',
    );
  } else {
    lines.push('## What is already there', 'Nothing. This is a new project.', '');
  }
  if (request.coders && request.coders.length > 0) {
    lines.push(
      '## Who will build it',
      `${request.coders.join(', ')} — real coding agents with a terminal and the whole repository.`,
      'They are capable. Do not write pieces so small that a person would be insulted to be given one.',
      '',
    );
  }

  lines.push(
    '## How to think about it',
    '',
    'Go through every one of these and decide what the request needs. Say so',
    'even when the answer is "none", so it is clear you looked:',
    '',
    '- **Database** — what is stored, the shape of it, indexes, migrations.',
    '- **Backend** — the API surface, validation, error handling, rate limits.',
    '- **Frontend** — the pages and components, the states each one has',
    '  (loading, empty, error), what happens on a phone.',
    '- **Design** — layout, type, spacing, colour, dark mode. Not "make it nice".',
    '- **Animation** — what moves, when, and why. Motion that means something',
    '  beats motion that decorates.',
    '- **Security** — authentication, authorisation, secrets, injection, what',
    '  an unauthenticated stranger can reach.',
    '- **Testing** — what would actually catch a regression here.',
    '- **Infra** — build, environment variables, deployment.',
    '',
    'Then use your own judgement. The person asking has not thought of',
    'everything, and a plan that answers only the literal words is a bad plan.',
    'If the request needs something it did not mention — sign-in, an empty',
    'state, a way to recover from an error, a smaller screen — add it and say',
    'in `additions` that you added it and why. If something in the request is',
    'a bad idea, say so in `risks` and plan the better version.',
    '',
    '## The rules that matter',
    '',
    '1. **Every piece names the files it owns.** Two agents will run at the',
    '   same time, and the only thing keeping them from overwriting each other',
    '   is that their file lists do not overlap. A piece that lists no files',
    '   runs alone while everything else waits, so list them.',
    '2. **Pieces that can run in parallel should not depend on each other.**',
    '   Use `dependsOn` only where the work genuinely cannot start first —',
    '   a page cannot be built against an API that does not exist yet, but two',
    '   different pages can be built at once.',
    '3. **Acceptance is checkable.** "The /api/cars route returns 401 without a',
    '   session" is acceptance. "Works correctly" is not.',
    '4. **Intent is a paragraph, not a title.** The agent gets `intent` as its',
    '   instructions and nothing else about this piece.',
    '',
    '## Answer with JSON and nothing else',
    '',
    '```json',
    '{',
    '  "projectName": "short-kebab-name",',
    '  "summary": "one paragraph on what is being built and for whom",',
    '  "stack": ["Next.js 16 App Router", "TypeScript", "MongoDB", "Tailwind"],',
    '  "decisions": ["choices you made that the request did not make for you"],',
    '  "additions": ["things you added because the request needed them"],',
    '  "risks": ["what could go wrong, and what you did about it"],',
    '  "pieces": [',
    '    {',
    '      "id": "db-1",',
    '      "title": "Car collection and indexes",',
    '      "surface": "database",',
    '      "intent": "a paragraph telling one agent exactly what to build",',
    '      "files": ["lib/db.ts", "lib/models/car.ts"],',
    '      "acceptance": ["a checkable statement", "another one"],',
    '      "dependsOn": [],',
    '      "notes": ["anything it would otherwise have to guess"]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    `Valid values for "surface": ${SURFACES.join(', ')}.`,
    'Between 4 and 14 pieces. Fewer, larger pieces beat many tiny ones.',
  );

  return lines.filter((line) => line !== undefined).join('\n');
}

/* ------------------------------------------------------------------ *
 * Reading one back
 * ------------------------------------------------------------------ */

export type ParseResult = { ok: true; blueprint: Blueprint; repairs: string[] } | { ok: false; error: string };

/**
 * Pull the JSON object out of whatever the model actually said.
 *
 * Models fence it, introduce it ("Here is the plan:"), and occasionally add a
 * closing remark. Scanning for a balanced object — while respecting strings and
 * escapes, because file lists are full of quotes and Windows backslashes —
 * survives all three.
 */
export function extractJson(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function asStrings(value: unknown, limit = 40): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function asSurface(value: unknown): Surface | undefined {
  if (typeof value !== 'string') return undefined;
  const wanted = value.trim().toLowerCase();
  const direct = SURFACES.find((surface) => surface === wanted);
  if (direct) return direct;
  // The names people and models actually use for these.
  const aliases: Record<string, Surface> = {
    api: 'backend',
    server: 'backend',
    ui: 'frontend',
    'ui/ux': 'design',
    ux: 'design',
    styling: 'design',
    css: 'design',
    motion: 'animation',
    animations: 'animation',
    data: 'database',
    db: 'database',
    schema: 'database',
    auth: 'security',
    tests: 'testing',
    qa: 'testing',
    devops: 'infra',
    deployment: 'infra',
    deploy: 'infra',
  };
  return aliases[wanted];
}

/**
 * Turn the model's answer into a blueprint, repairing what can be repaired.
 *
 * `repairs` is not decoration — it is shown, because a plan that needed six
 * repairs is a plan worth reading before a night is spent on it.
 */
export function parseBlueprint(text: string, request?: { goal?: string }): ParseResult {
  const json = extractJson(text ?? '');
  if (!json) {
    return { ok: false, error: 'the planner did not return JSON — there was no { … } object anywhere in its answer' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    return { ok: false, error: `the planner's JSON did not parse: ${(error as Error).message}` };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'the planner returned JSON, but not an object' };
  }

  const record = raw as Record<string, unknown>;
  const repairs: string[] = [];
  const rawPieces = Array.isArray(record['pieces'])
    ? record['pieces']
    : Array.isArray(record['tasks'])
      ? ((repairs.push('the plan called them "tasks"; read as pieces'), record['tasks']) as unknown[])
      : [];
  if (rawPieces.length === 0) {
    return { ok: false, error: 'the plan has no pieces of work in it — there is nothing to hand to an agent' };
  }

  const pieces: WorkPiece[] = [];
  const seen = new Set<string>();
  const byTitle = new Map<string, string>();

  for (const [index, entry] of rawPieces.entries()) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const title = typeof item['title'] === 'string' ? item['title'].trim() : '';
    const intent =
      typeof item['intent'] === 'string'
        ? item['intent'].trim()
        : typeof item['description'] === 'string'
          ? item['description'].trim()
          : '';
    if (!title && !intent) continue;

    const surface = asSurface(item['surface']) ?? asSurface(item['area']);
    if (!surface) repairs.push(`piece ${index + 1} did not say which surface it belongs to — filed under backend`);

    // Ids are referenced by dependsOn, so they have to be unique even when the
    // model reuses one or leaves it off entirely.
    let id = typeof item['id'] === 'string' && item['id'].trim() ? item['id'].trim() : `p${index + 1}`;
    if (seen.has(id)) {
      id = `${id}-${index + 1}`;
      repairs.push(`two pieces claimed the same id — the second is now "${id}"`);
    }
    seen.add(id);

    const piece: WorkPiece = {
      id,
      title: (title || intent.split(/[.\n]/)[0] || `piece ${index + 1}`).slice(0, 160),
      surface: surface ?? 'backend',
      intent: intent || title,
      files: asStrings(item['files'] ?? item['paths'], 60).map(normalisePath),
      acceptance: asStrings(item['acceptance'] ?? item['criteria'], 20),
      dependsOn: asStrings(item['dependsOn'] ?? item['depends_on'] ?? item['after'], 20),
      ...(asStrings(item['notes'], 20).length > 0 ? { notes: asStrings(item['notes'], 20) } : {}),
    };
    if (piece.files.length === 0) {
      repairs.push(`"${piece.title}" listed no files, so it cannot run beside anything else`);
    }
    if (piece.acceptance.length === 0) {
      repairs.push(`"${piece.title}" had no acceptance criteria`);
    }
    pieces.push(piece);
    byTitle.set(piece.title.toLowerCase(), piece.id);
  }

  if (pieces.length === 0) {
    return { ok: false, error: 'every piece in the plan was empty — nothing survived reading it' };
  }

  // A model that writes `"dependsOn": ["Car collection and indexes"]` means the
  // piece with that title. Resolving it beats dropping the dependency and
  // letting a page get built against an API that does not exist yet.
  const ids = new Set(pieces.map((piece) => piece.id));
  for (const piece of pieces) {
    piece.dependsOn = piece.dependsOn
      .map((dep) => (ids.has(dep) ? dep : byTitle.get(dep.toLowerCase())))
      .filter((dep): dep is string => Boolean(dep) && dep !== piece.id);
    piece.dependsOn = [...new Set(piece.dependsOn)];
  }
  const cycles = breakCycles(pieces);
  if (cycles.length > 0) repairs.push(...cycles);

  const blueprint: Blueprint = {
    projectName:
      (typeof record['projectName'] === 'string' && record['projectName'].trim()) ||
      (typeof record['name'] === 'string' && record['name'].trim()) ||
      slug(request?.goal ?? 'project'),
    summary: typeof record['summary'] === 'string' ? record['summary'].trim() : (request?.goal ?? '').trim(),
    stack: asStrings(record['stack'] ?? record['technologies'], 20),
    decisions: asStrings(record['decisions'], 20),
    additions: asStrings(record['additions'] ?? record['extras'], 20),
    risks: asStrings(record['risks'], 20),
    pieces,
  };
  return { ok: true, blueprint, repairs };
}

function normalisePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .split('-')
      .slice(0, 5)
      .join('-') || 'project'
  );
}

/**
 * Cut any dependency that closes a loop.
 *
 * A plan where A waits for B and B waits for A never starts, and it fails
 * silently — the queue simply sits there with everything blocked. Cutting the
 * back edge is a smaller lie than a night of nothing happening, and it is
 * reported so it is visible.
 */
function breakCycles(pieces: WorkPiece[]): string[] {
  const byId = new Map(pieces.map((piece) => [piece.id, piece]));
  const state = new Map<string, 'visiting' | 'done'>();
  const cut: string[] = [];

  const visit = (id: string): void => {
    const piece = byId.get(id);
    if (!piece || state.get(id) === 'done') return;
    state.set(id, 'visiting');
    for (const dep of [...piece.dependsOn]) {
      if (state.get(dep) === 'visiting') {
        piece.dependsOn = piece.dependsOn.filter((entry) => entry !== dep);
        cut.push(`"${piece.title}" and "${byId.get(dep)?.title ?? dep}" waited for each other — the loop was cut`);
        continue;
      }
      visit(dep);
    }
    state.set(id, 'done');
  };

  for (const piece of pieces) visit(piece.id);
  return cut;
}

/* ------------------------------------------------------------------ *
 * Judging one
 * ------------------------------------------------------------------ */

/** Surfaces a plan of this kind should have covered and did not. */
export function missingSurfaces(blueprint: Blueprint, expected: readonly Surface[]): Surface[] {
  const covered = new Set(blueprint.pieces.map((piece) => piece.surface));
  return expected.filter((surface) => !covered.has(surface));
}

/** What a plan for something with a screen and a database is expected to cover. */
export const WEB_APP_SURFACES: readonly Surface[] = ['database', 'backend', 'frontend', 'design', 'security'];

/** The blueprint as it is stored on a task, so a restart does not re-plan. */
export function blueprintToJson(blueprint: Blueprint): JsonObject {
  return JSON.parse(JSON.stringify(blueprint)) as JsonObject;
}

export function blueprintFromJson(value: unknown): Blueprint | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const parsed = parseBlueprint(JSON.stringify(value));
  return parsed.ok ? parsed.blueprint : undefined;
}
