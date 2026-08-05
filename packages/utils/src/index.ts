/**
 * @megaai/utils — small shared utilities used by every layer.
 */

import { randomBytes } from 'node:crypto';
import { MegaError, type JsonValue, type Timestamp } from '@megaai/types';

/* ------------------------------------------------------------------ *
 * Ids
 * ------------------------------------------------------------------ */

/**
 * Sortable unique id: `<prefix>_<time base36><random>`.
 * Time-ordered so listing by id roughly equals listing by creation time.
 */
export function newId(prefix = 'id'): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const rand = randomBytes(5).toString('hex');
  return `${prefix}_${time}${rand}`;
}

/* ------------------------------------------------------------------ *
 * Clock — injectable time source so tests stay deterministic
 * ------------------------------------------------------------------ */

export interface Clock {
  now(): Timestamp;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock tests can advance by hand. */
export class ManualClock implements Clock {
  private current: number;
  constructor(start = 0) {
    this.current = start;
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ *
 * Async helpers
 * ------------------------------------------------------------------ */

export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (err: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** Limits concurrent async work. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(slots: number) {
    if (slots < 1) throw new MegaError('INVALID_INPUT', 'Semaphore needs at least one slot');
    this.available = slots;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      this.available -= 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.available += 1;
      const next = this.waiters.shift();
      if (next) next();
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Called between attempts; return false to stop retrying. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Injectable sleep for tests. */
  wait?: (ms: number) => Promise<void>;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exp = baseMs * 2 ** (attempt - 1);
  const jitter = 0.5 + Math.random() * 0.5;
  return Math.min(maxMs, Math.round(exp * jitter));
}

/** Retry with exponential backoff and jitter. */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const base = options.baseDelayMs ?? 200;
  const max = options.maxDelayMs ?? 10_000;
  const wait = options.wait ?? sleep;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retriable = options.shouldRetry ? options.shouldRetry(err, attempt) : true;
      if (!retriable || attempt === attempts) break;
      const delay = backoffDelay(attempt, base, max);
      options.onRetry?.(err, attempt, delay);
      await wait(delay);
    }
  }
  throw lastErr;
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MegaError('TIMEOUT', `${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Data helpers
 * ------------------------------------------------------------------ */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursive merge; arrays and scalars are replaced, objects merged. */
export function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}

export function safeJsonParse(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * Extract the first JSON object from free-form model output — tolerates code
 * fences and prose around the payload.
 */
export function extractJsonObject(text: string): JsonValue | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    const parsed = safeJsonParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  // Walk balanced braces, respecting strings.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return safeJsonParse(text.slice(start, i + 1));
    }
  }
  return undefined;
}

/**
 * Escape the control characters a model leaves raw inside a JSON string.
 *
 * Asking for source code inside a JSON string value is asking for this: a
 * literal newline in a 200-line `.tsx` file is invalid JSON, and one of them
 * destroys the entire reply — including the other nine files that were fine.
 */
function escapeControlCharsInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch < ' ') out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
      else out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/**
 * Recover a usable object from JSON that is malformed or cut off.
 *
 * A reply that hits the output-token ceiling stops mid-string, so the braces
 * never balance and a strict parse yields nothing at all — which is how five
 * coding tasks reported success having written no files. Rather than lose the
 * whole reply, close the structure at the last point it was complete and keep
 * everything up to there.
 */
export function repairJsonObject(text: string): JsonValue | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  const src = escapeControlCharsInStrings(text.slice(start));

  // The control characters may have been the only problem.
  const whole = safeJsonParse(src);
  if (whole !== undefined) return whole;

  // Points at which the document was structurally complete, with the
  // containers still open there. Kept apart because cutting after a closing
  // brace ends a whole element, while cutting at a comma can leave the item
  // we were in the middle of — half an `fs.write` with a path and no content.
  const closers: Array<{ index: number; open: string[] }> = [];
  const commas: Array<{ index: number; open: string[] }> = [];
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) {
        // A complete top-level object: nothing to repair past here.
        const parsed = safeJsonParse(src.slice(0, i + 1));
        if (parsed !== undefined) return parsed;
      }
      closers.push({ index: i + 1, open: [...stack] });
    } else if (ch === ',') {
      commas.push({ index: i, open: [...stack] });
    }
  }

  // Newest first within each group: the later the cut, the more survives.
  for (const cut of [...closers.slice(-60).reverse(), ...commas.slice(-60).reverse()]) {
    const closing = [...cut.open].reverse().map((c) => (c === '{' ? '}' : ']')).join('');
    const parsed = safeJsonParse(src.slice(0, cut.index) + closing);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)}${units[unit]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${rest.toString().padStart(2, '0')}s`;
}

/** Rough token estimate (~4 chars per token) used for context budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function assertDefined<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) throw new MegaError('INTERNAL', message);
  return value;
}
