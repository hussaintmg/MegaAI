/**
 * What the machine is actually doing right now.
 *
 * Two costs are kept apart deliberately. CPU and memory are read in-process
 * from `os`, which is free, so they are sampled every tick. Temperature,
 * battery and "has the user touched the keyboard" need the operating system,
 * which on Windows means PowerShell — far too expensive to spawn every few
 * seconds. So a *probe* runs once, in the background, and prints a line
 * whenever it has fresh numbers; sampling just reads the newest line.
 *
 * Anything unreadable stays `undefined` and is never guessed. A missing
 * temperature must not read as a cool machine.
 */

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import type { Timestamp } from '@megaai/types';
import { type Clock, systemClock } from '@megaai/utils';

export interface MachineSample {
  at: Timestamp;
  /** All-core busy fraction, 0..1. */
  cpuLoad: number;
  /** Used memory as a fraction of total, 0..1. */
  memUsedPct: number;
  temperatureC?: number;
  batteryPct?: number;
  charging?: boolean;
  /** Seconds since the last keyboard or mouse input. Undefined = cannot tell. */
  idleSeconds?: number;
}

/* ------------------------------------------------------------------ *
 * CPU
 * ------------------------------------------------------------------ */

interface CpuTotals {
  busy: number;
  total: number;
}

function totals(cpus: readonly os.CpuInfo[]): CpuTotals {
  let busy = 0;
  let total = 0;
  for (const cpu of cpus) {
    const { user, nice, sys, irq, idle } = cpu.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + irq + idle;
  }
  return { busy, total };
}

/**
 * Busy fraction since the last reading.
 *
 * `os.loadavg()` is not usable here: on Windows it is always zero, and it
 * measures queue length rather than utilisation anyway.
 */
export class CpuMeter {
  private previous: CpuTotals | undefined;

  read(cpus: readonly os.CpuInfo[] = os.cpus()): number {
    const current = totals(cpus);
    const previous = this.previous;
    this.previous = current;
    if (!previous) return 0; // nothing to compare against yet
    const busy = current.busy - previous.busy;
    const total = current.total - previous.total;
    if (total <= 0) return 0;
    return Math.min(1, Math.max(0, busy / total));
  }
}

/* ------------------------------------------------------------------ *
 * The slow signals
 * ------------------------------------------------------------------ */

/** Temperature, battery and idle time — whatever this platform can tell us. */
export interface MachineProbe {
  /** The newest reading. Absent fields mean "not readable here". */
  latest(): Partial<MachineSample>;
  stop(): void;
}

/** When nothing can be read, say nothing — never invent a comfortable number. */
export const NO_PROBE: MachineProbe = { latest: () => ({}), stop: () => {} };

/**
 * The PowerShell that runs on Windows, once, for the whole session.
 *
 * `GetLastInputInfo` is the only way to know whether you are at the keyboard,
 * and it needs a P/Invoke — which means compiling a type. Doing that on every
 * sample would cost about a second of CPU each time, which is precisely the
 * kind of thing this agent exists to avoid, so it is compiled once and the
 * loop stays inside PowerShell.
 */
export const WINDOWS_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MegaAiIdle {
  [StructLayout(LayoutKind.Sequential)]
  private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")]
  private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static double Seconds() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return -1;
    return (double)((uint)Environment.TickCount - info.dwTime) / 1000.0;
  }
}
"@
while ($true) {
  $out = @{}
  $idle = [MegaAiIdle]::Seconds()
  if ($idle -ge 0) { $out.idleSeconds = [math]::Round($idle, 1) }
  $battery = Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1
  if ($battery) {
    if ($battery.EstimatedChargeRemaining -ne $null) { $out.batteryPct = [int]$battery.EstimatedChargeRemaining }
    # BatteryStatus 2 means "on AC power"; everything else is running on the cell.
    $out.charging = ($battery.BatteryStatus -eq 2)
  }
  $zone = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object -First 1
  if ($zone -and $zone.CurrentTemperature) {
    $out.temperatureC = [math]::Round(($zone.CurrentTemperature / 10.0) - 273.15, 1)
  }
  Write-Output ($out | ConvertTo-Json -Compress)
  Start-Sleep -Seconds 5
}
`;

/** One JSON line from the probe. Junk is ignored rather than thrown. */
export function parseProbeLine(line: string): Partial<MachineSample> | undefined {
  const text = line.trim();
  if (!text.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const sample: Partial<MachineSample> = {};
  if (typeof record['temperatureC'] === 'number' && Number.isFinite(record['temperatureC'])) {
    sample.temperatureC = record['temperatureC'];
  }
  if (typeof record['batteryPct'] === 'number' && Number.isFinite(record['batteryPct'])) {
    sample.batteryPct = Math.min(100, Math.max(0, record['batteryPct']));
  }
  if (typeof record['charging'] === 'boolean') sample.charging = record['charging'];
  if (typeof record['idleSeconds'] === 'number' && record['idleSeconds'] >= 0) {
    sample.idleSeconds = record['idleSeconds'];
  }
  return Object.keys(sample).length > 0 ? sample : undefined;
}

export interface WindowsProbeOptions {
  /** Injected for tests; defaults to `child_process.spawn`. */
  spawnProcess?: typeof spawn;
  onError?: (message: string) => void;
}

export class WindowsProbe implements MachineProbe {
  private reading: Partial<MachineSample> = {};
  private child: ReturnType<typeof spawn> | undefined;
  private buffer = '';

  constructor(options: WindowsProbeOptions = {}) {
    const spawnProcess = options.spawnProcess ?? spawn;
    try {
      this.child = spawnProcess(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PROBE_SCRIPT],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      );
    } catch (error) {
      options.onError?.(`could not start the machine probe: ${(error as Error).message}`);
      return;
    }
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.absorb(chunk));
    this.child.on('error', (error) => options.onError?.(`machine probe failed: ${error.message}`));
    this.child.unref?.();
  }

  private absorb(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const parsed = parseProbeLine(line);
      if (parsed) this.reading = parsed;
    }
  }

  latest(): Partial<MachineSample> {
    return { ...this.reading };
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
  }
}

/**
 * Linux reads straight out of sysfs — no subprocess, so it can be read on
 * every sample. Idle time is not available on a headless box, and pretending
 * otherwise would make the agent think you had walked away.
 */
export class LinuxProbe implements MachineProbe {
  constructor(private readonly root = '/sys') {}

  latest(): Partial<MachineSample> {
    return {
      ...(this.temperature() !== undefined ? { temperatureC: this.temperature() } : {}),
      ...this.battery(),
    };
  }

  private temperature(): number | undefined {
    try {
      const base = `${this.root}/class/thermal`;
      const zones = readdirSync(base).filter((name) => name.startsWith('thermal_zone'));
      const readings = zones
        .map((zone) => Number(readFileSync(`${base}/${zone}/temp`, 'utf8').trim()))
        .filter((value) => Number.isFinite(value) && value > 0)
        // millidegrees on every kernel that reports at all
        .map((value) => value / 1000);
      // The hottest zone is the one that matters — an average hides the package.
      return readings.length > 0 ? Math.max(...readings) : undefined;
    } catch {
      return undefined;
    }
  }

  private battery(): Partial<MachineSample> {
    try {
      const base = `${this.root}/class/power_supply`;
      const cell = readdirSync(base).find((name) => name.startsWith('BAT'));
      if (!cell) return {};
      const capacity = Number(readFileSync(`${base}/${cell}/capacity`, 'utf8').trim());
      const status = readFileSync(`${base}/${cell}/status`, 'utf8').trim();
      return {
        ...(Number.isFinite(capacity) ? { batteryPct: capacity } : {}),
        charging: status !== 'Discharging',
      };
    } catch {
      return {};
    }
  }

  stop(): void {}
}

export function createProbe(
  platform: NodeJS.Platform = process.platform,
  options: WindowsProbeOptions = {},
): MachineProbe {
  if (platform === 'win32') return new WindowsProbe(options);
  if (platform === 'linux') return new LinuxProbe();
  return NO_PROBE;
}

/* ------------------------------------------------------------------ *
 * Putting a sample together
 * ------------------------------------------------------------------ */

export interface SamplerOptions {
  probe?: MachineProbe;
  clock?: Clock;
  meter?: CpuMeter;
  /** Injected for tests. */
  memory?: () => { total: number; free: number };
  cpus?: () => os.CpuInfo[];
}

export function createSampler(options: SamplerOptions = {}): () => MachineSample {
  const probe = options.probe ?? NO_PROBE;
  const clock = options.clock ?? systemClock;
  const meter = options.meter ?? new CpuMeter();
  const memory = options.memory ?? (() => ({ total: os.totalmem(), free: os.freemem() }));
  const cpus = options.cpus ?? (() => os.cpus());

  return () => {
    const { total, free } = memory();
    return {
      at: clock.now(),
      cpuLoad: meter.read(cpus()),
      memUsedPct: total > 0 ? Math.min(1, Math.max(0, (total - free) / total)) : 0,
      ...probe.latest(),
    };
  };
}
