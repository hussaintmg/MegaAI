/**
 * Settings that survive closing the window.
 *
 * `$env:MEGAAI_MONGODB_URI = "..."` in PowerShell lasts exactly as long as that
 * PowerShell does, so the agent forgets it every time you open a new one — and
 * the Scheduled Task, which starts with no shell at all, never sees it. That is
 * not a thing to explain to someone; it is a thing to stop happening.
 *
 * So the agent reads a `.env` file next to its own state, and `megaai-node set`
 * writes to it. Paste the connection string once and every future run — from a
 * terminal, from the Task Scheduler, after a reboot — has it.
 *
 * A real environment variable always wins, so nothing here overrides what you
 * deliberately set for one run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface EnvEntry {
  key: string;
  value: string;
}

/**
 * Parse a `.env`.
 *
 * Deliberately forgiving about what people paste: a MongoDB connection string
 * is full of `:` `@` `/` `?` `&` and often arrives wrapped in quotes from the
 * Atlas page, and none of that should need thinking about.
 */
export function parseEnv(text: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    entries.push({ key, value });
  }
  return entries;
}

export function formatEnv(entries: EnvEntry[]): string {
  const lines = [
    '# MegaAI settings. Written by `megaai-node set`; safe to edit by hand.',
    '# A real environment variable always wins over anything here.',
    '',
    ...entries.map((entry) => `${entry.key}=${entry.value}`),
  ];
  return `${lines.join('\n')}\n`;
}

/** Where the agent keeps its own `.env`. */
export function envFilePath(stateDir: string, platform: NodeJS.Platform = process.platform): string {
  return (platform === 'win32' ? path.win32 : path.posix).join(stateDir, '.env');
}

/**
 * Apply a `.env` to the process, without overriding anything already set.
 *
 * Returns what it actually applied, so the agent can say where a setting came
 * from rather than leaving you to wonder which one is in force.
 */
export function applyEnv(text: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const applied: string[] = [];
  for (const entry of parseEnv(text)) {
    if (env[entry.key] !== undefined && env[entry.key] !== '') continue;
    env[entry.key] = entry.value;
    applied.push(entry.key);
  }
  return applied;
}

/** Read the agent's `.env` if there is one, and apply it. */
export function loadEnvFile(file: string, env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    if (!existsSync(file)) return [];
    return applyEnv(readFileSync(file, 'utf8'), env);
  } catch {
    return [];
  }
}

/** Add or replace one setting, keeping the rest of the file. */
export function upsertEnv(text: string, key: string, value: string): string {
  const entries = parseEnv(text).filter((entry) => entry.key !== key);
  if (value !== '') entries.push({ key, value });
  return formatEnv(entries);
}

export function writeEnvFile(file: string, key: string, value: string): void {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  mkdirSync(path.dirname(file), { recursive: true });
  // 0600: this file holds a database connection string, which is a password
  // with extra steps.
  writeFileSync(file, upsertEnv(existing, key, value), { encoding: 'utf8', mode: 0o600 });
}

/** Never show a whole connection string back — it carries the password. */
export function maskValue(key: string, value: string): string {
  if (!/URI|KEY|TOKEN|SECRET|PASSWORD/i.test(key)) return value;
  if (value.length <= 12) return '•'.repeat(value.length);
  return `${value.slice(0, 8)}…${'•'.repeat(6)}…${value.slice(-4)}`;
}
