/**
 * @megaai/coders — driving the coding agents you already pay for.
 *
 * Claude Code, Codex and OpenCode are the workers; MegaAI is the shift
 * manager. It hands one of them a task in a project folder, watches for the
 * moment it says "usage limit reached", and passes the work to the next one
 * *with everything it needs to carry on* — not a fresh prompt that starts over.
 *
 * When every agent is spent, work stops and waits rather than failing: each
 * limit carries a reset time, and the earliest one is when the queue wakes up
 * again. That is the difference between a night of progress and a night of
 * nothing.
 *
 * Their CLIs are driven, not their editor windows. `claude -p`, `codex exec`
 * and `opencode run` all take a prompt, a working directory and a session to
 * resume; a GUI has none of that and breaks on every update.
 */

import type { JsonObject, Timestamp } from '@megaai/types';
import { MegaError } from '@megaai/types';
import { type Clock, systemClock } from '@megaai/utils';

/* ------------------------------------------------------------------ *
 * Which agents exist, and how to talk to them
 * ------------------------------------------------------------------ */

export type CoderId = 'claude' | 'codex' | 'opencode' | (string & {});

export interface CoderSpec {
  id: CoderId;
  name: string;
  /** The binary. On Windows the launcher resolves the `.cmd` shim itself. */
  command: string;
  /** Ask it to do something, non-interactively, in a project folder. */
  argsFor(prompt: string, options: { resumeSessionId?: string; model?: string }): string[];
  /**
   * Pull the session id out of its output, so the next turn continues the
   * same conversation instead of re-explaining the project.
   */
  sessionIdFrom?(output: string): string | undefined;
  /** Preferred order — the one you would reach for first goes lowest. */
  rank: number;
}

/** The three that matter today. Others are added by registering a spec. */
export const BUILTIN_CODERS: CoderSpec[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    rank: 1,
    argsFor: (prompt, o) => [
      ...(o.resumeSessionId ? ['--resume', o.resumeSessionId] : []),
      ...(o.model ? ['--model', o.model] : []),
      '--output-format',
      'json',
      '-p',
      prompt,
    ],
    sessionIdFrom: (output) => /"session_id"\s*:\s*"([^"]+)"/.exec(output)?.[1],
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    rank: 2,
    argsFor: (prompt, o) => ['exec', ...(o.model ? ['--model', o.model] : []), prompt],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    rank: 3,
    argsFor: (prompt, o) => ['run', ...(o.resumeSessionId ? ['--session', o.resumeSessionId] : []), prompt],
    sessionIdFrom: (output) => /session[ _-]?id[:=]\s*([A-Za-z0-9_-]{6,})/i.exec(output)?.[1],
  },
];

/* ------------------------------------------------------------------ *
 * Reading a limit out of what the agent said
 * ------------------------------------------------------------------ */

export interface LimitVerdict {
  limited: boolean;
  /** When it becomes usable again, if the agent said so. */
  resetAt?: Timestamp;
  /** The sentence that decided it — shown to you rather than paraphrased. */
  evidence?: string;
}

/**
 * Phrases that mean "not now". Deliberately narrow: treating an ordinary
 * error as a quota limit would park a perfectly good agent for hours.
 */
const LIMIT_PATTERNS: RegExp[] = [
  /usage limit reached/i,
  /rate limit(?:ed)? exceeded/i,
  /you(?:'ve| have) (?:hit|reached) your (?:usage |rate )?limit/i,
  /quota (?:exceeded|exhausted)/i,
  /out of (?:credits|quota)/i,
  /insufficient (?:credits|quota|balance)/i,
  /too many requests/i,
  /resource[_ ]exhausted/i,
  /\b429\b/,
];

/** "resets at 3pm", "try again in 2 hours", "resets 2026-08-06T04:00:00Z". */
function readResetTime(text: string, now: Timestamp): Timestamp | undefined {
  const iso = /reset[s]?\s*(?:at)?\s*[:\s]\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i.exec(text)?.[1];
  if (iso) {
    const at = Date.parse(iso);
    if (!Number.isNaN(at) && at > now) return at;
  }
  const relative = /(?:try again|retry|resets?|available again)\s*(?:in|after)\s*(\d+)\s*(second|minute|hour)s?/i.exec(text);
  if (relative?.[1] && relative[2]) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms = unit === 'second' ? 1_000 : unit === 'minute' ? 60_000 : 3_600_000;
    return now + amount * ms;
  }
  // "resets at 3pm" / "resets at 15:00"
  const clock = /reset[s]?\s*(?:at)?\s*[:\s]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (clock?.[1]) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    let at = target.getTime();
    if (at <= now) at += 24 * 3_600_000; // it means tomorrow
    return at;
  }
  return undefined;
}

/** Did this run stop because the agent is out of quota? */
export function detectLimit(output: string, now: Timestamp = Date.now()): LimitVerdict {
  if (!output) return { limited: false };
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => LIMIT_PATTERNS.some((pattern) => pattern.test(candidate)));
  if (!line) return { limited: false };
  // The reset time may be on a neighbouring line, so search the whole tail.
  const resetAt = readResetTime(output.slice(-4_000), now);
  return { limited: true, evidence: line.trim().slice(0, 300), ...(resetAt ? { resetAt } : {}) };
}

/* ------------------------------------------------------------------ *
 * The handoff
 * ------------------------------------------------------------------ */

export interface HandoffContext {
  /** What we are ultimately trying to achieve. */
  goal: string;
  /** The specific piece this turn is meant to finish. */
  task: string;
  projectDir: string;
  /** Everything the previous agents already did, oldest first. */
  history: Array<{ coder: CoderId; summary: string; at: Timestamp }>;
  /** `git status --short`, or an equivalent view of what changed. */
  changedFiles?: string[];
  /**
   * What is already in the folder.
   *
   * Not the same thing as `changedFiles`, and needed for the common case where
   * the project is not a git repository: without it the brief tells the next
   * agent to "read the files listed above" and lists nothing, which is how an
   * agent ends up rewriting a page that already existed.
   */
  projectFiles?: string[];
  /** The last thing the previous agent said before it ran out. */
  lastOutputTail?: string;
  /** Anything the run has learned that must survive a handoff. */
  notes?: string[];
}

/**
 * The brief the next agent starts from.
 *
 * A handoff that just repeats the original prompt makes the new agent redo
 * everything, and often undo it. What it actually needs is the state of the
 * world: what has been done, what changed on disk, and where the last one
 * stopped.
 */
export function buildHandoffBrief(context: HandoffContext, nextCoder: CoderSpec): string {
  const lines: string[] = [
    `You are continuing work another agent started. Do not start over.`,
    ``,
    `## Goal`,
    context.goal,
    ``,
    `## Your task now`,
    context.task,
    ``,
    `## Project`,
    context.projectDir,
  ];

  if (context.history.length > 0) {
    lines.push('', '## What has already been done');
    for (const entry of context.history) {
      lines.push(`- [${entry.coder}] ${entry.summary}`);
    }
  }
  if (context.changedFiles && context.changedFiles.length > 0) {
    lines.push(
      '',
      '## Files already changed in this project',
      ...context.changedFiles.slice(0, 60).map((file) => `- ${file}`),
      context.changedFiles.length > 60 ? `- …and ${context.changedFiles.length - 60} more` : '',
    );
  }
  if (context.projectFiles && context.projectFiles.length > 0) {
    lines.push(
      '',
      '## Files already in this project',
      ...context.projectFiles.slice(0, 80).map((file) => `- ${file}`),
      context.projectFiles.length > 80 ? `- …and ${context.projectFiles.length - 80} more` : '',
    );
  }
  if (context.notes && context.notes.length > 0) {
    lines.push('', '## Notes carried over', ...context.notes.map((note) => `- ${note}`));
  }
  if (context.lastOutputTail) {
    lines.push(
      '',
      '## Where the previous agent stopped',
      'It ran out of quota mid-task. This is the last thing it reported:',
      '```',
      context.lastOutputTail.slice(-1_500),
      '```',
    );
  }
  lines.push(
    '',
    '## How to continue',
    '1. Read the files listed above before changing anything — the work is partly done.',
    '2. Finish the task, then verify it (build it, run the tests) rather than assuming.',
    '3. End with a short summary of exactly what you changed, so the next agent can pick up from you.',
    '',
    `(You are ${nextCoder.name}. The previous agent could not finish; you are not being asked to review its work, only to continue it.)`,
  );
  return lines.filter((line) => line !== '').join('\n');
}

/* ------------------------------------------------------------------ *
 * The pool
 * ------------------------------------------------------------------ */

export interface CoderState {
  id: CoderId;
  /** Present and usable on this machine. */
  installed: boolean;
  /**
   * It is installed but will not start on this machine — a broken shim, a
   * missing runtime. Different from being out of quota: waiting does not fix
   * it, and trying it again inside the same run just burns handoffs.
   */
  brokenReason?: string;
  /** Parked until this moment because it ran out. */
  limitedUntil?: Timestamp;
  /** Why it is parked — shown rather than summarised away. */
  limitReason?: string;
  /** Per-project session ids, so a resumed turn keeps its conversation. */
  sessions: Record<string, string>;
  turns: number;
}

export interface CoderPoolOptions {
  specs?: CoderSpec[];
  clock?: Clock;
  /** When an agent reports a limit with no reset time, park it this long. */
  blindCooldownMs?: number;
  onEvent?: (event: { type: string; coder?: CoderId; message: string; at: Timestamp }) => void;
}

/**
 * Who is available to work right now, and who is sitting out until when.
 */
export class CoderPool {
  private readonly specs: Map<CoderId, CoderSpec>;
  private readonly states = new Map<CoderId, CoderState>();
  private readonly clock: Clock;
  private readonly blindCooldownMs: number;
  private readonly onEvent?: CoderPoolOptions['onEvent'];

  constructor(options: CoderPoolOptions = {}) {
    const specs = options.specs ?? BUILTIN_CODERS;
    this.specs = new Map(specs.map((spec) => [spec.id, spec]));
    this.clock = options.clock ?? systemClock;
    this.blindCooldownMs = options.blindCooldownMs ?? 60 * 60_000;
    this.onEvent = options.onEvent;
    for (const spec of specs) {
      this.states.set(spec.id, { id: spec.id, installed: false, sessions: {}, turns: 0 });
    }
  }

  private emit(type: string, message: string, coder?: CoderId): void {
    this.onEvent?.({ type, message, at: this.clock.now(), ...(coder ? { coder } : {}) });
  }

  /**
   * The pool's own idea of now.
   *
   * Limit detection has to read reset times against the same clock the pool
   * parks agents by. Two clocks in one decision means "resets at 12:00" can be
   * judged already-past by one and still-future by the other.
   */
  now(): Timestamp {
    return this.clock.now();
  }

  spec(id: CoderId): CoderSpec {
    const spec = this.specs.get(id);
    if (!spec) throw new MegaError('NOT_FOUND', `Unknown coding agent "${id}"`);
    return spec;
  }

  /** Record which agents actually exist on this machine. */
  setInstalled(ids: readonly CoderId[]): void {
    for (const [id, state] of this.states) {
      const installed = ids.includes(id);
      if (installed !== state.installed) {
        this.emit(installed ? 'coder.found' : 'coder.missing', `${this.spec(id).name} is ${installed ? 'available' : 'not installed'}`, id);
      }
      state.installed = installed;
    }
  }

  state(id: CoderId): CoderState {
    const state = this.states.get(id);
    if (!state) throw new MegaError('NOT_FOUND', `Unknown coding agent "${id}"`);
    return { ...state, sessions: { ...state.sessions } };
  }

  /**
   * This one is installed but cannot be started here.
   *
   * Seen for real: an npm shim Node refuses to run. The turn fails in
   * milliseconds, the relay picks the same agent again because nothing about
   * it changed, and four handoffs are gone in under a second without a single
   * line of work being attempted.
   */
  markBroken(id: CoderId, reason: string): void {
    const state = this.states.get(id);
    if (!state || state.brokenReason) return;
    state.brokenReason = reason;
    this.emit('coder.broken', `${this.spec(id).name} cannot be started on this machine: ${reason}`, id);
  }

  available(): CoderSpec[] {
    const now = this.clock.now();
    return [...this.states.values()]
      .filter((state) => state.installed && !state.brokenReason && (state.limitedUntil ?? 0) <= now)
      .map((state) => this.spec(state.id))
      .sort((a, b) => a.rank - b.rank);
  }

  /** The one to use next, preferring an agent that already knows this project. */
  next(projectDir?: string): CoderSpec | undefined {
    const ready = this.available();
    if (projectDir) {
      const familiar = ready.find((spec) => this.states.get(spec.id)?.sessions[projectDir]);
      if (familiar) return familiar;
    }
    return ready[0];
  }

  /**
   * Park an agent that has run out.
   *
   * With no reset time given, a cautious hour beats guessing — retrying into a
   * hard limit burns the next agent's turn as well.
   */
  markLimited(id: CoderId, verdict: LimitVerdict): CoderState {
    const state = this.states.get(id);
    if (!state) throw new MegaError('NOT_FOUND', `Unknown coding agent "${id}"`);
    const until = verdict.resetAt ?? this.clock.now() + this.blindCooldownMs;
    state.limitedUntil = until;
    state.limitReason = verdict.evidence ?? 'reported a usage limit';
    this.emit(
      'coder.limited',
      `${this.spec(id).name} is out of quota until ${new Date(until).toISOString()} — ${state.limitReason}`,
      id,
    );
    return this.state(id);
  }

  /** Remember the session so the next turn on this project resumes it. */
  rememberSession(id: CoderId, projectDir: string, sessionId: string): void {
    const state = this.states.get(id);
    if (!state) return;
    state.sessions[projectDir] = sessionId;
  }

  recordTurn(id: CoderId): void {
    const state = this.states.get(id);
    if (state) state.turns += 1;
  }

  /**
   * When work can start again, and why it is stopped.
   *
   * `undefined` means someone is free right now. Otherwise the caller parks the
   * task until `resumeAt` — which is exactly the mesh's `notBefore`, so an
   * exhausted night resumes by itself rather than needing you to notice.
   */
  exhaustion(): { resumeAt?: Timestamp; reason: string } | undefined {
    if (this.available().length > 0) return undefined;
    const installed = [...this.states.values()].filter((state) => state.installed);
    if (installed.length === 0) {
      return { reason: 'no coding agent is installed on this machine — install Claude Code, Codex or OpenCode' };
    }
    const broken = installed.filter((state) => state.brokenReason);
    if (broken.length === installed.length) {
      return {
        reason: `every coding agent on this machine fails to start (${broken
          .map((state) => `${this.spec(state.id).name}: ${state.brokenReason}`)
          .join('; ')}) — waiting will not fix this one`,
      };
    }
    const limited = installed.filter((state) => (state.limitedUntil ?? 0) > this.clock.now());
    const soonest = limited.reduce<Timestamp | undefined>(
      (best, state) => (best === undefined || (state.limitedUntil ?? 0) < best ? state.limitedUntil : best),
      undefined,
    );
    const detail = limited
      .map((state) => `${this.spec(state.id).name} until ${new Date(state.limitedUntil ?? 0).toISOString()}`)
      .join(', ');
    return {
      ...(soonest ? { resumeAt: soonest } : {}),
      reason: `every coding agent is out of quota (${detail}) — work resumes on its own when the first one comes back`,
    };
  }

  snapshot(): CoderState[] {
    return [...this.states.values()].map((state) => ({ ...state, sessions: { ...state.sessions } }));
  }
}

/* ------------------------------------------------------------------ *
 * Running a turn
 * ------------------------------------------------------------------ */

export interface RunOutcome {
  exitCode: number;
  output: string;
}

/** Spawns the CLI. Injected, so this package is testable without them. */
export type CoderLauncher = (
  command: string,
  args: string[],
  cwd: string,
  onChunk?: (chunk: string) => void,
) => Promise<RunOutcome>;

export interface TurnResult {
  coder: CoderId;
  ok: boolean;
  /** It stopped because it is out of quota, not because the work failed. */
  limited: boolean;
  output: string;
  sessionId?: string;
  exitCode: number;
}

export interface RunTurnOptions {
  pool: CoderPool;
  launcher: CoderLauncher;
  projectDir: string;
  prompt: string;
  coder?: CoderId;
  model?: string;
  onChunk?: (chunk: string) => void;
}

/**
 * Hand one task to one agent, once.
 *
 * A quota stop is not a failure: it comes back `ok: false, limited: true` so
 * the caller hands the work on instead of counting an attempt against it.
 */
export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const { pool, launcher, projectDir, prompt } = options;
  const spec = options.coder ? pool.spec(options.coder) : pool.next(projectDir);
  if (!spec) {
    const stuck = pool.exhaustion();
    throw new MegaError('RESOURCE_EXHAUSTED', stuck?.reason ?? 'no coding agent is available', {
      ...(stuck?.resumeAt ? { resumeAt: stuck.resumeAt } : {}),
    });
  }

  const resumeSessionId = pool.state(spec.id).sessions[projectDir];
  const args = spec.argsFor(prompt, { ...(resumeSessionId ? { resumeSessionId } : {}), ...(options.model ? { model: options.model } : {}) });
  const outcome = await launcher(spec.command, args, projectDir, options.onChunk);
  pool.recordTurn(spec.id);

  const verdict = detectLimit(outcome.output, pool.now());
  if (verdict.limited) {
    pool.markLimited(spec.id, verdict);
    return { coder: spec.id, ok: false, limited: true, output: outcome.output, exitCode: outcome.exitCode };
  }

  // 127 is the launcher saying it could not start the program at all. That is
  // the agent being unusable on this machine, not the task being wrong, and
  // retrying it inside the same run only burns handoffs.
  if (outcome.exitCode === 127) {
    pool.markBroken(spec.id, outcome.output.slice(-300).trim() || 'could not be started');
  }

  const sessionId = spec.sessionIdFrom?.(outcome.output);
  if (sessionId) pool.rememberSession(spec.id, projectDir, sessionId);

  return {
    coder: spec.id,
    ok: outcome.exitCode === 0,
    limited: false,
    output: outcome.output,
    exitCode: outcome.exitCode,
    ...(sessionId ? { sessionId } : {}),
  };
}

export interface RelayOptions extends Omit<RunTurnOptions, 'prompt' | 'coder' | 'projectDir'> {
  /** The project folder comes from here — one source, not two that can differ. */
  context: HandoffContext;
  /** How many agents may be tried before giving up on this task. */
  maxHandoffs?: number;
  /** Summarise what an agent did, for the next one's brief. */
  summarise?: (result: TurnResult) => string;
  /**
   * Called after every turn, with the history as it now stands.
   *
   * The caller uses this to write the handoff down somewhere durable, so a
   * reboot in the middle of the night resumes with what the first two agents
   * did instead of starting the task from nothing.
   */
  onTurn?: (turn: TurnResult, history: HandoffEntry[]) => void | Promise<void>;
}

export type HandoffEntry = HandoffContext['history'][number];

export interface RelayResult {
  ok: boolean;
  /** Every agent that took a turn, in order. */
  turns: TurnResult[];
  /** Set when everyone ran out — park the task until then. */
  resumeAt?: Timestamp;
  reason?: string;
}

/**
 * Pass the task down the line until someone finishes it.
 *
 * This is the whole point of the package: an agent hitting its limit costs a
 * handoff, not the task. When the line runs out, the caller is told when the
 * first agent returns so the work resumes on its own.
 */
export async function relayTask(options: RelayOptions): Promise<RelayResult> {
  const { pool, context } = options;
  const maxHandoffs = options.maxHandoffs ?? 4;
  const summarise = options.summarise ?? ((result) => `ran ${result.coder} (exit ${result.exitCode})`);
  const turns: TurnResult[] = [];
  const history = [...context.history];

  const tried = new Set<CoderId>();
  for (let handoff = 0; handoff < maxHandoffs; handoff += 1) {
    const spec = pool.next(context.projectDir);
    if (!spec) {
      const stuck = pool.exhaustion();
      return {
        ok: false,
        turns,
        ...(stuck?.resumeAt ? { resumeAt: stuck.resumeAt } : {}),
        reason: stuck?.reason ?? 'no coding agent is available',
      };
    }

    // Handing the same agent the same task twice in a row achieves nothing —
    // it failed for a reason that has not changed in the last second. The
    // relay is for passing work *on*, and when there is nobody left to pass it
    // to, the honest answer is that the line has run out.
    if (tried.has(spec.id) && pool.available().every((other) => tried.has(other.id))) {
      const stuck = pool.exhaustion();
      return {
        ok: false,
        turns,
        ...(stuck?.resumeAt ? { resumeAt: stuck.resumeAt } : {}),
        reason: stuck?.reason ?? `every available coding agent has already tried this and failed`,
      };
    }
    tried.add(spec.id);

    const brief = buildHandoffBrief({ ...context, history }, spec);
    const result = await runTurn({
      pool: options.pool,
      launcher: options.launcher,
      projectDir: context.projectDir,
      prompt: brief,
      coder: spec.id,
      ...(options.model ? { model: options.model } : {}),
      ...(options.onChunk ? { onChunk: options.onChunk } : {}),
    });
    turns.push(result);

    if (result.ok) {
      history.push({ coder: result.coder, summary: summarise(result), at: pool.now() });
      await options.onTurn?.(result, history);
      return { ok: true, turns };
    }

    // Carry forward what it managed before it stopped, so the next agent does
    // not repeat it.
    history.push({ coder: result.coder, summary: summarise(result), at: pool.now() });
    if (!result.limited) {
      // A real failure, not a quota stop — the same agent retrying is unlikely
      // to help, so move on, but say so plainly.
      history.push({
        coder: result.coder,
        summary: `failed with exit ${result.exitCode}; the next agent should read the files before changing them`,
        at: pool.now(),
      });
    }
    context.lastOutputTail = result.output;
    await options.onTurn?.(result, history);
  }

  return { ok: false, turns, reason: `no agent finished the task after ${maxHandoffs} handoffs` };
}
