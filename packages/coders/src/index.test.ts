import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '@megaai/utils';
import {
  BUILTIN_CODERS,
  buildHandoffBrief,
  CoderPool,
  detectLimit,
  relayTask,
  runTurn,
  type CoderLauncher,
  type HandoffContext,
} from './index.js';

/** A launcher that replies from a script and records what it was asked. */
function scripted(replies: Array<{ exitCode: number; output: string }>) {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const launcher: CoderLauncher = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    return replies.shift() ?? { exitCode: 0, output: 'done' };
  };
  return { launcher, calls };
}

function pool(clock = new ManualClock(Date.parse('2026-08-06T10:00:00Z'))) {
  const events: string[] = [];
  const p = new CoderPool({ clock, onEvent: (e) => events.push(`${e.type}: ${e.message}`) });
  p.setInstalled(['claude', 'codex', 'opencode']);
  return { clock, events, p };
}

const CONTEXT: HandoffContext = {
  goal: 'build the 3d car website',
  task: 'add the scroll animations',
  projectDir: 'C:\\projects\\velocity',
  history: [],
};

/* ---------------- limit detection ---------------- */

test('a usage limit is recognised, with the time it comes back', () => {
  const verdict = detectLimit(
    'Working...\nClaude usage limit reached. Your limit will reset at 2026-08-06T14:00:00Z',
    Date.parse('2026-08-06T10:00:00Z'),
  );
  assert.equal(verdict.limited, true);
  assert.equal(verdict.resetAt, Date.parse('2026-08-06T14:00:00Z'));
  assert.match(verdict.evidence ?? '', /usage limit reached/);
});

test('relative and clock-time resets are both read', () => {
  const now = Date.parse('2026-08-06T10:00:00Z');
  assert.equal(detectLimit('rate limit exceeded, try again in 45 minutes', now).resetAt, now + 45 * 60_000);
  assert.equal(detectLimit('quota exceeded — retry after 2 hours', now).resetAt, now + 2 * 3_600_000);
  const atThree = detectLimit('You have hit your limit. Resets at 3pm', now).resetAt;
  assert.ok(atThree && atThree > now, 'a wall-clock reset resolves to the next time it occurs');
});

test('a limit with no stated reset is still a limit', () => {
  const verdict = detectLimit('Error: insufficient credits for this request');
  assert.equal(verdict.limited, true);
  assert.equal(verdict.resetAt, undefined);
});

test('ordinary failures are not mistaken for quota limits', () => {
  // Parking a working agent for an hour over a type error would waste the night.
  for (const output of [
    'TypeError: Cannot read properties of undefined',
    'error TS2339: Property foo does not exist',
    'npm ERR! code ELIFECYCLE',
    'fatal: not a git repository',
    '',
  ]) {
    assert.equal(detectLimit(output).limited, false, `"${output}" must not read as a quota limit`);
  }
});

/* ---------------- the pool ---------------- */

test('the preferred agent goes first, and a limited one steps aside', () => {
  const { p, clock } = pool();
  assert.equal(p.next()?.id, 'claude');

  p.markLimited('claude', { limited: true, resetAt: clock.now() + 3_600_000, evidence: 'usage limit reached' });
  assert.equal(p.next()?.id, 'codex', 'the next in line takes over');

  clock.advance(3_600_001);
  assert.equal(p.next()?.id, 'claude', 'and it comes back on its own when the limit resets');
});

test('an agent that already knows the project is preferred over rank', () => {
  const { p } = pool();
  p.rememberSession('opencode', 'C:\\projects\\velocity', 'sess-9');
  assert.equal(p.next('C:\\projects\\velocity')?.id, 'opencode', 'continuing a session beats starting fresh');
  assert.equal(p.next('C:\\projects\\other')?.id, 'claude');
});

test('when everyone is spent, the pool says when work can resume', () => {
  const { p, clock } = pool();
  p.markLimited('claude', { limited: true, resetAt: clock.now() + 4 * 3_600_000 });
  p.markLimited('codex', { limited: true, resetAt: clock.now() + 2 * 3_600_000 });
  p.markLimited('opencode', { limited: true, resetAt: clock.now() + 6 * 3_600_000 });

  const stuck = p.exhaustion();
  assert.ok(stuck, 'exhaustion is a state to report, not silence');
  assert.equal(stuck?.resumeAt, clock.now() + 2 * 3_600_000, 'the earliest reset is when work restarts');
  assert.match(stuck?.reason ?? '', /every coding agent is out of quota/);
  assert.match(stuck?.reason ?? '', /resumes on its own/);
});

test('no agent installed is said plainly, not reported as exhaustion', () => {
  const p = new CoderPool({ clock: new ManualClock(0) });
  p.setInstalled([]);
  assert.match(p.exhaustion()?.reason ?? '', /no coding agent is installed/);
  assert.equal(p.exhaustion()?.resumeAt, undefined, 'installing something is not a matter of waiting');
});

test('a limit with no reset time parks the agent, but not forever', () => {
  const { p, clock } = pool();
  p.markLimited('claude', { limited: true, evidence: 'quota exhausted' });
  assert.equal(p.next()?.id, 'codex');
  clock.advance(60 * 60_000 + 1);
  assert.equal(p.next()?.id, 'claude');
});

/* ---------------- the handoff brief ---------------- */

test('the brief tells the next agent to continue, not to start over', () => {
  const brief = buildHandoffBrief(
    {
      ...CONTEXT,
      history: [
        { coder: 'claude', summary: 'scaffolded the Next.js app and wrote the hero', at: 0 },
        { coder: 'codex', summary: 'added the data layer', at: 0 },
      ],
      changedFiles: ['app/page.tsx', 'lib/cars.ts'],
      notes: ['gsap is already installed'],
      lastOutputTail: 'Writing components/SpecSection.tsx…\nClaude usage limit reached',
    },
    BUILTIN_CODERS[2]!,
  );

  assert.match(brief, /Do not start over/);
  assert.match(brief, /scaffolded the Next\.js app/);
  assert.match(brief, /added the data layer/);
  assert.match(brief, /- app\/page\.tsx/);
  assert.match(brief, /gsap is already installed/);
  assert.match(brief, /Where the previous agent stopped/);
  assert.match(brief, /You are OpenCode/);
  assert.match(brief, /Read the files listed above before changing anything/);
  assert.match(brief, /add the scroll animations/, 'the actual task is still there');
});

test('a first turn with no history reads as a plain task, not a confusing handoff', () => {
  const brief = buildHandoffBrief(CONTEXT, BUILTIN_CODERS[0]!);
  assert.doesNotMatch(brief, /What has already been done/);
  assert.doesNotMatch(brief, /Where the previous agent stopped/);
  assert.match(brief, /build the 3d car website/);
});

/* ---------------- running and relaying ---------------- */

test('a turn runs the CLI in the project folder and remembers the session', async () => {
  const { p } = pool();
  const { launcher, calls } = scripted([
    { exitCode: 0, output: '{"session_id":"abc-123","result":"done"}' },
  ]);
  const result = await runTurn({ pool: p, launcher, projectDir: 'C:\\projects\\velocity', prompt: 'do the thing' });

  assert.equal(result.ok, true);
  assert.equal(result.coder, 'claude');
  assert.equal(result.sessionId, 'abc-123');
  assert.equal(calls[0]?.command, 'claude');
  assert.equal(calls[0]?.cwd, 'C:\\projects\\velocity');
  assert.ok(calls[0]?.args.includes('-p'), 'run non-interactively');
  assert.equal(p.state('claude').sessions['C:\\projects\\velocity'], 'abc-123');

  // The next turn on the same project resumes rather than re-explaining it.
  const { launcher: second, calls: secondCalls } = scripted([{ exitCode: 0, output: 'ok' }]);
  await runTurn({ pool: p, launcher: second, projectDir: 'C:\\projects\\velocity', prompt: 'more' });
  assert.deepEqual(secondCalls[0]?.args.slice(0, 2), ['--resume', 'abc-123']);
});

test('a quota stop is not counted as the task failing', async () => {
  const { p } = pool();
  const { launcher } = scripted([
    { exitCode: 1, output: 'Claude usage limit reached. Your limit will reset at 2026-08-06T14:00:00Z' },
  ]);
  const result = await runTurn({ pool: p, launcher, projectDir: 'C:\\p', prompt: 'x' });
  assert.equal(result.limited, true);
  assert.equal(result.ok, false);
  assert.equal(p.next()?.id, 'codex', 'and the agent is parked so the next one gets the work');
});

test('the task moves down the line until an agent finishes it', async () => {
  const { p, events } = pool();
  const { launcher, calls } = scripted([
    { exitCode: 1, output: 'Claude usage limit reached. Your limit will reset at 2026-08-06T14:00:00Z' },
    { exitCode: 1, output: 'rate limit exceeded, try again in 30 minutes' },
    { exitCode: 0, output: 'Finished the scroll animations.' },
  ]);

  const result = await relayTask({
    pool: p,
    launcher,
    context: { ...CONTEXT, history: [] },
    summarise: (turn) => `${turn.coder} got partway before stopping`,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.turns.map((t) => t.coder), ['claude', 'codex', 'opencode']);
  // The third agent was told what the first two had done.
  const lastPrompt = calls[2]?.args.join(' ') ?? '';
  assert.match(lastPrompt, /claude got partway before stopping/);
  assert.match(lastPrompt, /codex got partway before stopping/);
  assert.match(lastPrompt, /Do not start over/);
  assert.equal(events.filter((e) => e.startsWith('coder.limited')).length, 2);
});

test('every turn is reported as it happens, so it can be written down before the next one', async () => {
  // If the history were only handed back at the end, a reboot at 3am would
  // lose everything the first two agents did.
  const { p } = pool();
  const { launcher } = scripted([
    { exitCode: 1, output: 'usage limit reached, resets at 2026-08-06T14:00:00Z' },
    { exitCode: 0, output: 'Finished it.' },
  ]);
  const seen: Array<{ coder: string; historyLength: number }> = [];

  await relayTask({
    pool: p,
    launcher,
    context: { ...CONTEXT, history: [] },
    onTurn: (turn, history) => {
      seen.push({ coder: turn.coder, historyLength: history.length });
    },
  });

  assert.deepEqual(seen.map((entry) => entry.coder), ['claude', 'codex']);
  assert.ok(seen[0]!.historyLength >= 1, 'the first agent’s work is recorded before the second starts');
  assert.ok(seen[1]!.historyLength > seen[0]!.historyLength);
});

test('when the line runs out the task is parked, with the time it resumes', async () => {
  const { p, clock } = pool();
  const { launcher } = scripted([
    { exitCode: 1, output: 'usage limit reached, resets at 2026-08-06T14:00:00Z' },
    { exitCode: 1, output: 'usage limit reached, resets at 2026-08-06T12:00:00Z' },
    { exitCode: 1, output: 'usage limit reached, resets at 2026-08-06T18:00:00Z' },
  ]);

  const result = await relayTask({ pool: p, launcher, context: { ...CONTEXT, history: [] } });
  assert.equal(result.ok, false);
  assert.equal(result.turns.length, 3);
  assert.equal(result.resumeAt, Date.parse('2026-08-06T12:00:00Z'), 'the soonest reset, not the first agent tried');
  assert.match(result.reason ?? '', /every coding agent is out of quota/);
  assert.ok((result.resumeAt ?? 0) > clock.now());
});

test('a genuine failure hands on too, with a warning to read before writing', async () => {
  const { p } = pool();
  const { launcher, calls } = scripted([
    { exitCode: 2, output: 'error TS2322: Type string is not assignable to type number' },
    { exitCode: 0, output: 'Fixed the type error.' },
  ]);
  const result = await relayTask({ pool: p, launcher, context: { ...CONTEXT, history: [] } });

  assert.equal(result.ok, true);
  assert.equal(result.turns[0]?.limited, false, 'a type error is not a quota limit');
  assert.match(calls[1]?.args.join(' ') ?? '', /read the files before changing them/);
  assert.match(calls[1]?.args.join(' ') ?? '', /TS2322/, 'the next agent sees the actual error');
});

test('asking for a turn with nobody available explains itself instead of throwing blindly', async () => {
  const { p, clock } = pool();
  for (const id of ['claude', 'codex', 'opencode'] as const) {
    p.markLimited(id, { limited: true, resetAt: clock.now() + 3_600_000 });
  }
  const { launcher } = scripted([]);
  await assert.rejects(
    runTurn({ pool: p, launcher, projectDir: 'C:\\p', prompt: 'x' }),
    /every coding agent is out of quota/,
  );
});
