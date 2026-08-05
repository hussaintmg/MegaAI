/**
 * The delivery itself — the files a run produced, as stored on the goal.
 *
 * Kept free of any database import so it can be unit-tested on its own.
 */

/** A delivered file, with its contents when it is text and small enough. */
export interface GoalFile {
  path: string;
  bytes: number;
  text?: string;
  truncated?: boolean;
  binary?: boolean;
}

/** Completions each provider served — proof of who wrote the delivery. */
export interface GoalProviderTally {
  kind: string;
  requests: number;
}

/** Mongo caps a document at 16 MB; stay far below it. */
export const MAX_FILE_TEXT = 128 * 1024;
export const MAX_TOTAL_TEXT = 1_200 * 1024;
export const MAX_FILES = 300;

/** Validate an untrusted `contents` array from the runner and enforce caps. */
export function sanitizeGoalFiles(input: unknown): GoalFile[] {
  if (!Array.isArray(input)) return [];
  const files: GoalFile[] = [];
  let total = 0;
  for (const raw of input) {
    if (files.length >= MAX_FILES) break;
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.path !== 'string' || entry.path.length === 0) continue;
    const file: GoalFile = {
      // The path is a label here — never used to touch a filesystem — but keep
      // it from climbing out of the delivery in whatever renders it next.
      path: entry.path.replace(/\\/g, '/').replace(/(^|\/)\.\.(?=\/|$)/g, '$1__').slice(0, 400),
      bytes: Number.isFinite(entry.bytes) ? Math.max(0, Math.trunc(entry.bytes as number)) : 0,
    };
    if (entry.binary === true) {
      file.binary = true;
    } else if (typeof entry.text === 'string') {
      const room = Math.min(MAX_FILE_TEXT, Math.max(0, MAX_TOTAL_TEXT - total));
      const text = entry.text.slice(0, room);
      if (text.length < entry.text.length || entry.truncated === true) file.truncated = true;
      if (text.length > 0) file.text = text;
      total += text.length;
    }
    files.push(file);
  }
  return files;
}

/** Tallies from the runner, cleaned up for storage. */
export function sanitizeProviderTallies(input: unknown): GoalProviderTally[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
    .map((p) => ({ kind: String(p.kind ?? '').slice(0, 40), requests: Number(p.requests) || 0 }))
    .filter((p) => p.kind.length > 0)
    .slice(0, 20);
}
