/**
 * The prompt a coding agent is actually given.
 *
 * This is the file that decides whether the whole thing works. Everything
 * upstream — the planner, the queue, the machine — exists to get a good
 * instruction in front of Claude Code, Codex or OpenCode, and a vague
 * instruction wastes an hour of quota that does not come back until the limit
 * resets.
 *
 * A prompt written here is the brief a demanding engineer would write for
 * someone competent they have never met: what the project is, what this piece
 * is, which files are theirs, which files belong to somebody working right now
 * (so: hands off), how it will be judged, and the standard expected. No
 * flattery, no "please", no restating the obvious.
 */

import type { Blueprint, WorkPiece } from './blueprint.js';

export interface PromptOptions {
  /** The absolute folder the agent will be started in. */
  projectDir: string;
  /** Files owned by pieces running right now — the hands-off list. */
  busyFiles?: string[];
  /** What earlier pieces finished, so it does not redo them. */
  completed?: Array<{ title: string; summary?: string }>;
  /** The build/test command for this project, when there is one. */
  verifyCommand?: string;
  /** Extra house rules from the person who owns the project. */
  houseRules?: string[];
}

/** How the work is judged, regardless of which piece it is. */
export const STANDARD = [
  'Write the real thing. No placeholders, no `TODO`, no mock data standing in for a feature.',
  'Match the code that is already there — its imports, its naming, its formatting. Do not reformat files you did not need to change.',
  'Handle the states that actually happen: loading, empty, error, unauthorised, offline, and a slow network.',
  'It must work on a phone-sized screen, not only on the machine you are building it on.',
  'Never commit a secret. Read keys from environment variables and add them to `.env.example`.',
  'Verify before you say it is done — run the build, run the tests, open the page. "Should work" is not done.',
];

/**
 * The brief for one piece.
 *
 * The shape is fixed on purpose: the agents read these back to each other
 * across a handoff, and a predictable shape means the next one finds the
 * acceptance criteria in the same place every time.
 */
export function writePrompt(piece: WorkPiece, blueprint: Blueprint, options: PromptOptions): string {
  const lines: string[] = [];

  lines.push(`# ${piece.title}`, '');
  lines.push(
    `You are one of several coding agents working on **${blueprint.projectName}** at the same time.`,
    'You have been given one piece of it. Do that piece properly and completely; do not do anybody else\'s.',
    '',
  );

  lines.push('## The project', blueprint.summary || blueprint.projectName, '');
  if (blueprint.stack.length > 0) {
    lines.push(`**Stack:** ${blueprint.stack.join(' · ')}`, '');
  }
  lines.push('**Working directory:** ' + options.projectDir, '');

  lines.push('## Your piece', piece.intent, '');

  if (piece.files.length > 0) {
    lines.push(
      '## Files you own',
      ...piece.files.map((file) => `- \`${file}\``),
      '',
      'These are yours: create them, rewrite them, delete them. Anything else in the',
      'repository you may read, and may only change if this piece genuinely cannot be',
      'finished without it — in which case keep the change to the minimum and say so',
      'in your summary.',
      '',
    );
  } else {
    lines.push(
      '## Files',
      'No file list was given for this piece, so nothing else is running while you work.',
      'Change what you need to, and keep it tidy.',
      '',
    );
  }

  const busy = (options.busyFiles ?? []).filter((file) => !piece.files.includes(file));
  if (busy.length > 0) {
    lines.push(
      '## Do not touch — another agent is in these right now',
      ...busy.slice(0, 40).map((file) => `- \`${file}\``),
      busy.length > 40 ? `- …and ${busy.length - 40} more` : '',
      '',
      'Two agents editing one file at the same time silently undoes one of them.',
      'If you need something from those files, read them and work around them.',
      '',
    );
  }

  if (options.completed && options.completed.length > 0) {
    lines.push('## Already finished by the others');
    for (const done of options.completed.slice(0, 20)) {
      lines.push(`- **${done.title}**${done.summary ? ` — ${done.summary}` : ''}`);
    }
    lines.push('', 'Build on it. Read it before you assume how it works.', '');
  }

  if (piece.notes && piece.notes.length > 0) {
    lines.push('## Decided already, so you do not have to', ...piece.notes.map((note) => `- ${note}`), '');
  }

  if (piece.acceptance.length > 0) {
    lines.push(
      '## Done means all of these are true',
      ...piece.acceptance.map((entry, index) => `${index + 1}. ${entry}`),
      '',
      'Check them yourself before you finish. If one of them turns out to be wrong or',
      'impossible, say which and why rather than quietly skipping it.',
      '',
    );
  }

  lines.push('## The standard', ...STANDARD.map((rule) => `- ${rule}`), '');
  if (options.houseRules && options.houseRules.length > 0) {
    lines.push('## House rules for this project', ...options.houseRules.map((rule) => `- ${rule}`), '');
  }

  if (options.verifyCommand) {
    lines.push('## Verify with', '```', options.verifyCommand, '```', '');
  }

  lines.push(
    '## Finish with',
    'A short summary — what you changed, file by file, and anything the next agent',
    'needs to know. It is read by whoever picks up from you, so write it for them,',
    'not for a changelog.',
  );

  return lines.filter((line) => line !== '').join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Rewrite the whole plan as prompts, in the order the pieces can be started.
 *
 * Useful on its own: it is what the website shows when somebody wants to read
 * what their machines are about to be told before it happens.
 */
export function writeAllPrompts(blueprint: Blueprint, options: PromptOptions): Array<{ piece: WorkPiece; prompt: string }> {
  return blueprint.pieces.map((piece) => ({
    piece,
    prompt: writePrompt(piece, blueprint, {
      ...options,
      busyFiles: blueprint.pieces.filter((other) => other.id !== piece.id).flatMap((other) => other.files),
    }),
  }));
}

/**
 * A one-line title for the queue.
 *
 * The queue shows titles on a phone, so the surface goes first: seeing
 * "frontend · Car detail page" in a list tells you more than the title alone.
 */
export function taskTitle(piece: WorkPiece, blueprint: Blueprint): string {
  return `${blueprint.projectName} · ${piece.surface} · ${piece.title}`.slice(0, 300);
}
