/**
 * @megaai/logger — structured, leveled logging with pluggable sinks.
 *
 * The default sink prints human-friendly lines (or JSON when `pretty` is
 * off); a `MemorySink` keeps a ring buffer that the dashboard and tests read.
 */

import type { JsonObject, LogLevel, Timestamp } from '@megaai/types';
import { type Clock, systemClock } from '@megaai/utils';

export interface LogEntry {
  timestamp: Timestamp;
  level: LogLevel;
  scope: string;
  message: string;
  fields?: JsonObject;
}

export interface LogSink {
  write(entry: LogEntry): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

const LEVEL_LABEL: Record<LogLevel, string> = {
  trace: 'TRC',
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
};

export class ConsoleSink implements LogSink {
  constructor(private readonly pretty: boolean = true) {}

  write(entry: LogEntry): void {
    if (!this.pretty) {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
      return;
    }
    const time = new Date(entry.timestamp).toISOString().slice(11, 23);
    const fields = entry.fields && Object.keys(entry.fields).length > 0 ? ` ${JSON.stringify(entry.fields)}` : '';
    const line = `${time} ${LEVEL_LABEL[entry.level]} [${entry.scope}] ${entry.message}${fields}\n`;
    if (entry.level === 'error' || entry.level === 'warn') process.stderr.write(line);
    else process.stdout.write(line);
  }
}

/** Ring buffer sink — used by tests and the dashboard's recent-logs panel. */
export class MemorySink implements LogSink {
  readonly entries: LogEntry[] = [];
  constructor(private readonly capacity = 500) {}

  write(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }

  find(substring: string): LogEntry[] {
    return this.entries.filter((entry) => entry.message.includes(substring));
  }

  clear(): void {
    this.entries.length = 0;
  }
}

export interface LoggerOptions {
  level?: LogLevel;
  sinks?: LogSink[];
  scope?: string;
  clock?: Clock;
}

export class Logger {
  level: LogLevel;
  private readonly sinks: LogSink[];
  private readonly scope: string;
  private readonly clock: Clock;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.sinks = options.sinks ?? [new ConsoleSink(true)];
    this.scope = options.scope ?? 'megaai';
    this.clock = options.clock ?? systemClock;
  }

  child(scope: string): Logger {
    const child = new Logger({
      level: this.level,
      sinks: this.sinks,
      scope: `${this.scope}.${scope}`,
      clock: this.clock,
    });
    return child;
  }

  private write(level: LogLevel, message: string, fields?: JsonObject): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const entry: LogEntry = { timestamp: this.clock.now(), level, scope: this.scope, message, fields };
    for (const sink of this.sinks) {
      try {
        sink.write(entry);
      } catch {
        // A broken sink must never take the process down.
      }
    }
  }

  trace = (message: string, fields?: JsonObject): void => this.write('trace', message, fields);
  debug = (message: string, fields?: JsonObject): void => this.write('debug', message, fields);
  info = (message: string, fields?: JsonObject): void => this.write('info', message, fields);
  warn = (message: string, fields?: JsonObject): void => this.write('warn', message, fields);
  error = (message: string, fields?: JsonObject): void => this.write('error', message, fields);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger(options);
}
