import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManualClock } from '@megaai/utils';
import { CpuMeter, LinuxProbe, createSampler, parseProbeLine, WINDOWS_PROBE_SCRIPT } from './machine.js';

function cpus(times: Array<{ busy: number; idle: number }>): os.CpuInfo[] {
  return times.map((entry) => ({
    model: 'test',
    speed: 2400,
    times: { user: entry.busy, nice: 0, sys: 0, idle: entry.idle, irq: 0 },
  }));
}

test('cpu load is measured between readings, not guessed from load average', () => {
  const meter = new CpuMeter();
  // The first reading has nothing to compare against.
  assert.equal(meter.read(cpus([{ busy: 100, idle: 900 }])), 0);
  // 100 ticks busy out of 200 elapsed.
  assert.equal(meter.read(cpus([{ busy: 200, idle: 1000 }])), 0.5);
  // A machine doing nothing.
  assert.equal(meter.read(cpus([{ busy: 200, idle: 1200 }])), 0);
});

test('cpu load survives a counter that did not move', () => {
  const meter = new CpuMeter();
  meter.read(cpus([{ busy: 10, idle: 10 }]));
  assert.equal(meter.read(cpus([{ busy: 10, idle: 10 }])), 0, 'no elapsed time is 0%, not a divide by zero');
});

test('a probe line is read, and rubbish on the same stream is ignored', () => {
  assert.deepEqual(parseProbeLine('{"idleSeconds":42.5,"batteryPct":88,"charging":true,"temperatureC":61.2}'), {
    temperatureC: 61.2,
    batteryPct: 88,
    charging: true,
    idleSeconds: 42.5,
  });
  assert.equal(parseProbeLine('At line:1 char:1 — a PowerShell warning'), undefined);
  assert.equal(parseProbeLine('{ not json'), undefined);
  assert.equal(parseProbeLine('{}'), undefined, 'an empty reading tells us nothing, so it is not a reading');
});

test('a probe reporting only some of the numbers is still useful', () => {
  // Most desktops refuse MSAcpi_ThermalZoneTemperature; battery and idle still work.
  assert.deepEqual(parseProbeLine('{"idleSeconds":5,"batteryPct":100,"charging":true}'), {
    batteryPct: 100,
    charging: true,
    idleSeconds: 5,
  });
  assert.deepEqual(parseProbeLine('{"idleSeconds":-1}'), undefined, 'a failed idle call is not an idle time');
});

test('the Windows probe compiles its P/Invoke once and then loops', () => {
  // Recompiling per sample would cost about a second of CPU each time — the
  // exact thing this agent exists to avoid.
  assert.equal(WINDOWS_PROBE_SCRIPT.match(/Add-Type/g)?.length, 1);
  assert.match(WINDOWS_PROBE_SCRIPT, /while \(\$true\)/);
  assert.match(WINDOWS_PROBE_SCRIPT, /Start-Sleep/);
});

test('linux reads the hottest thermal zone and the battery, and shrugs at what is missing', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'megaai-sysfs-'));
  mkdirSync(path.join(root, 'class/thermal/thermal_zone0'), { recursive: true });
  mkdirSync(path.join(root, 'class/thermal/thermal_zone1'), { recursive: true });
  writeFileSync(path.join(root, 'class/thermal/thermal_zone0/temp'), '45000\n');
  writeFileSync(path.join(root, 'class/thermal/thermal_zone1/temp'), '71500\n');
  mkdirSync(path.join(root, 'class/power_supply/BAT0'), { recursive: true });
  writeFileSync(path.join(root, 'class/power_supply/BAT0/capacity'), '73\n');
  writeFileSync(path.join(root, 'class/power_supply/BAT0/status'), 'Discharging\n');

  const probe = new LinuxProbe(root);
  assert.deepEqual(probe.latest(), { temperatureC: 71.5, batteryPct: 73, charging: false });

  // A desktop with no battery and no thermal zones reports nothing rather than zero.
  assert.deepEqual(new LinuxProbe(mkdtempSync(path.join(os.tmpdir(), 'megaai-empty-'))).latest(), {});
});

test('a sample is the cheap numbers plus whatever the probe last said', () => {
  const clock = new ManualClock(1_700_000_000_000);
  const sample = createSampler({
    clock,
    probe: { latest: () => ({ idleSeconds: 300, temperatureC: 55 }), stop: () => {} },
    memory: () => ({ total: 16_000_000_000, free: 4_000_000_000 }),
    cpus: () => cpus([{ busy: 0, idle: 100 }]),
  });

  const first = sample();
  assert.equal(first.at, 1_700_000_000_000);
  assert.equal(first.memUsedPct, 0.75);
  assert.equal(first.idleSeconds, 300);
  assert.equal(first.temperatureC, 55);
});
