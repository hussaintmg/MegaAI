import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '@megaai/utils';
import { ResourceGuard, type GuardThresholds } from './guard.js';
import type { MachineSample } from './machine.js';

function sample(overrides: Partial<MachineSample> = {}): MachineSample {
  return { at: 0, cpuLoad: 0.1, memUsedPct: 0.5, ...overrides };
}

function guard(thresholds: Partial<GuardThresholds> = {}) {
  const clock = new ManualClock(0);
  return { clock, g: new ResourceGuard({ clock, thresholds: { minHoldMs: 0, ...thresholds } }) };
}

test('away and quiet means everything runs', () => {
  const { g } = guard();
  const decision = g.decide(sample({ idleSeconds: 900, cpuLoad: 0.05 }));
  assert.equal(decision.gear, 'full');
  assert.equal(decision.concurrency, 3);
  assert.match(decision.reason, /away 15m/);
});

test('while you are at the keyboard it takes urgent work only', () => {
  const { g } = guard();
  const decision = g.decide(sample({ idleSeconds: 4 }));
  assert.equal(decision.gear, 'gentle');
  assert.equal(decision.concurrency, 1);
  assert.match(decision.reason, /staying out of the way/);
});

test('a machine that cannot report idle time is judged by its load instead', () => {
  // The first version of this stayed gentle forever, which was safe and
  // useless: on any machine without an idle-time reading the whole backlog was
  // deferred until the end of time, quietly.
  const { g, clock } = guard();

  const busy = g.decide(sample({ idleSeconds: undefined, cpuLoad: 0.4 }));
  assert.equal(busy.gear, 'gentle');
  assert.match(busy.reason, /cannot report idle time, and it is 40% busy/);

  // Quiet, but not for long enough yet to call it "away".
  const early = g.decide(sample({ idleSeconds: undefined, cpuLoad: 0.02 }));
  assert.equal(early.gear, 'gentle');
  assert.match(early.reason, /only been quiet/);

  clock.advance(181_000);
  const settled = g.decide(sample({ idleSeconds: undefined, cpuLoad: 0.02 }));
  assert.equal(settled.gear, 'full');
  assert.match(settled.reason, /no idle-time reading on this machine, but it has been quiet/);
});

test('a burst of activity restarts the count — the quiet has to be continuous', () => {
  const { g, clock } = guard();
  g.decide(sample({ idleSeconds: undefined, cpuLoad: 0.02 }));
  clock.advance(170_000);
  g.decide(sample({ idleSeconds: undefined, cpuLoad: 0.5 })); // you came back
  clock.advance(20_000);
  assert.equal(g.decide(sample({ idleSeconds: undefined, cpuLoad: 0.02 })).gear, 'gentle');
});

test('a real idle-time reading always wins over the guess', () => {
  const { g, clock } = guard();
  // Long quiet spell with no reading…
  g.decide(sample({ idleSeconds: undefined, cpuLoad: 0.01 }));
  clock.advance(600_000);
  assert.equal(g.decide(sample({ idleSeconds: undefined, cpuLoad: 0.01 })).gear, 'full');
  // …then the probe starts working and says you are right here.
  const decision = g.decide(sample({ idleSeconds: 2, cpuLoad: 0.01 }));
  assert.equal(decision.gear, 'gentle');
  assert.match(decision.reason, /staying out of the way/);
});

test('away, but the machine is already working hard — one thing at a time', () => {
  const { g } = guard();
  const decision = g.decide(sample({ idleSeconds: 3_600, cpuLoad: 0.93 }));
  assert.equal(decision.gear, 'gentle');
  assert.match(decision.reason, /already 93% busy/);
});

test('a hot machine stops, and stays stopped until it has actually cooled', () => {
  const { g } = guard();
  assert.equal(g.decide(sample({ idleSeconds: 900, temperatureC: 88 })).gear, 'stop');

  // 78°C is below the stop threshold but nowhere near cool. Restarting here is
  // how a laptop ends up sitting at 82°C all night.
  const warm = g.decide(sample({ idleSeconds: 900, temperatureC: 78 }));
  assert.equal(warm.gear, 'stop');
  assert.match(warm.reason, /still cooling/);

  assert.equal(g.decide(sample({ idleSeconds: 900, temperatureC: 68 })).gear, 'full');
});

test('a temperature reading that vanishes while hot is not good news', () => {
  const { g, clock } = guard();
  g.decide(sample({ idleSeconds: 900, temperatureC: 90 }));

  // The probe stops reporting. Nothing here justifies calling it cool again…
  const blind = g.decide(sample({ idleSeconds: 900 }));
  assert.equal(blind.gear, 'stop');
  assert.match(blind.reason, /stopped coming while the machine was hot/);

  // …but a dead probe must not pause the machine forever either.
  clock.advance(5 * 60_000 + 1);
  const after = g.decide(sample({ idleSeconds: 900 }));
  assert.equal(after.gear, 'gentle');
  assert.match(after.reason, /no longer readable/);
});

test('the last of the battery is yours, not the queue’s', () => {
  const { g } = guard();
  const flat = g.decide(sample({ idleSeconds: 900, batteryPct: 14, charging: false }));
  assert.equal(flat.gear, 'stop');
  assert.match(flat.reason, /14% and unplugged/);

  // Plugged in at the same level is fine.
  assert.equal(g.decide(sample({ idleSeconds: 900, batteryPct: 14, charging: true })).gear, 'full');
});

test('nearly-full memory stops it — a swapping laptop is a hung laptop', () => {
  const { g } = guard();
  const decision = g.decide(sample({ idleSeconds: 900, memUsedPct: 0.96 }));
  assert.equal(decision.gear, 'stop');
  assert.match(decision.reason, /96% full/);
});

test('gear does not flap: speeding up waits, stopping never does', () => {
  const clock = new ManualClock(0);
  const g = new ResourceGuard({ clock, thresholds: { minHoldMs: 20_000 } });

  assert.equal(g.decide(sample({ idleSeconds: 5 })).gear, 'gentle');

  clock.advance(3_000);
  assert.equal(g.decide(sample({ idleSeconds: 900 })).gear, 'gentle', 'one quiet moment is not you leaving');

  clock.advance(20_000);
  assert.equal(g.decide(sample({ idleSeconds: 900 })).gear, 'full');

  clock.advance(1_000);
  assert.equal(g.decide(sample({ idleSeconds: 900, temperatureC: 95 })).gear, 'stop', 'heat does not wait for a timer');
});

test('the reason is a sentence, not a code', () => {
  const { g } = guard();
  for (const s of [
    sample({ idleSeconds: 900 }),
    sample({ idleSeconds: 2 }),
    sample({ idleSeconds: 900, temperatureC: 95 }),
    sample({ idleSeconds: 900, batteryPct: 5, charging: false }),
  ]) {
    const { reason } = g.decide(s);
    assert.ok(reason.length > 20 && /[a-z] [a-z]/.test(reason), `"${reason}" should read as English`);
  }
});
