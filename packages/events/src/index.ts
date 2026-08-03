/**
 * @megaai/events — the nervous system of MegaAI.
 *
 * A typed publish/subscribe bus with prefix wildcards (`workflow.*`), a
 * bounded history buffer (for the dashboard and post-mortems) and `waitFor`
 * so orchestration code can await "the moment X happens".
 */

import type { EventEnvelope } from '@megaai/types';
import { MegaError } from '@megaai/types';
import { type Clock, Deferred, newId, systemClock } from '@megaai/utils';

export type EventHandler<T = unknown> = (event: EventEnvelope<T>) => void;

export interface Subscription {
  unsubscribe(): void;
}

interface Registered {
  pattern: string;
  handler: EventHandler<never>;
  once: boolean;
}

function matches(pattern: string, type: string): boolean {
  if (pattern === '*' || pattern === type) return true;
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
  return false;
}

export interface EventBusOptions {
  historyLimit?: number;
  clock?: Clock;
  /** Receives handler errors; defaults to stderr so they are never silent. */
  onHandlerError?: (err: unknown, event: EventEnvelope) => void;
}

export class EventBus {
  private readonly handlers = new Set<Registered>();
  private readonly historyBuffer: EventEnvelope[] = [];
  private readonly historyLimit: number;
  private readonly clock: Clock;
  private readonly onHandlerError: (err: unknown, event: EventEnvelope) => void;

  constructor(options: EventBusOptions = {}) {
    this.historyLimit = options.historyLimit ?? 1000;
    this.clock = options.clock ?? systemClock;
    this.onHandlerError =
      options.onHandlerError ??
      ((err, event) => {
        process.stderr.write(`[events] handler for ${event.type} threw: ${String(err)}\n`);
      });
  }

  on<T = unknown>(pattern: string, handler: EventHandler<T>): Subscription {
    const registered: Registered = { pattern, handler: handler as EventHandler<never>, once: false };
    this.handlers.add(registered);
    return { unsubscribe: () => this.handlers.delete(registered) };
  }

  once<T = unknown>(pattern: string, handler: EventHandler<T>): Subscription {
    const registered: Registered = { pattern, handler: handler as EventHandler<never>, once: true };
    this.handlers.add(registered);
    return { unsubscribe: () => this.handlers.delete(registered) };
  }

  emit<T>(type: string, payload: T, source?: string): EventEnvelope<T> {
    const event: EventEnvelope<T> = {
      id: newId('evt'),
      type,
      payload,
      source,
      timestamp: this.clock.now(),
    };
    this.historyBuffer.push(event as EventEnvelope);
    if (this.historyBuffer.length > this.historyLimit) {
      this.historyBuffer.splice(0, this.historyBuffer.length - this.historyLimit);
    }
    for (const registered of [...this.handlers]) {
      if (!matches(registered.pattern, type)) continue;
      if (registered.once) this.handlers.delete(registered);
      try {
        (registered.handler as EventHandler<T>)(event);
      } catch (err) {
        this.onHandlerError(err, event as EventEnvelope);
      }
    }
    return event;
  }

  /** Recent events, optionally filtered by prefix pattern, newest last. */
  history(pattern?: string, limit = 100): EventEnvelope[] {
    const source = pattern
      ? this.historyBuffer.filter((event) => matches(pattern, event.type))
      : this.historyBuffer;
    return source.slice(-limit);
  }

  subscriberCount(): number {
    return this.handlers.size;
  }

  /**
   * Resolves with the first event matching `pattern` (and `predicate`, when
   * given). Rejects with TIMEOUT after `timeoutMs` (default 10s).
   */
  waitFor<T = unknown>(
    pattern: string,
    options: { timeoutMs?: number; predicate?: (event: EventEnvelope<T>) => boolean } = {},
  ): Promise<EventEnvelope<T>> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const deferred = new Deferred<EventEnvelope<T>>();
    const subscription = this.on<T>(pattern, (event) => {
      if (options.predicate && !options.predicate(event)) return;
      cleanup();
      deferred.resolve(event);
    });
    // Deliberately NOT unref'd: an awaited waitFor must keep the loop alive
    // until it resolves or times out.
    const timer = setTimeout(() => {
      cleanup();
      deferred.reject(new MegaError('TIMEOUT', `Timed out waiting for event "${pattern}" after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      subscription.unsubscribe();
    };
    return deferred.promise;
  }
}

export function createEventBus(options?: EventBusOptions): EventBus {
  return new EventBus(options);
}
