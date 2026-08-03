/**
 * @megaai/security — permissions, secrets, audit trail and rate limiting.
 *
 * Every action an agent takes flows through a permission check and lands in
 * the audit log; secrets live in the vault and are redacted from anything
 * that gets logged or sent to a model.
 */

import type { AuditEntry, JsonObject } from '@megaai/types';
import { Events, MegaError } from '@megaai/types';
import { type Clock, newId, systemClock } from '@megaai/utils';
import type { EventBus } from '@megaai/events';
import type { Database } from '@megaai/database';

/* ------------------------------------------------------------------ *
 * Permissions
 * ------------------------------------------------------------------ */

/** `fs.*` grants `fs.read`, `fs.write`…; `*` grants everything. */
export function permissionMatches(granted: string, required: string): boolean {
  if (granted === '*' || granted === required) return true;
  if (granted.endsWith('.*')) return required.startsWith(granted.slice(0, -1));
  return false;
}

export class PermissionManager {
  private readonly grants = new Map<string, Set<string>>();

  grant(principal: string, ...permissions: string[]): void {
    let set = this.grants.get(principal);
    if (!set) {
      set = new Set();
      this.grants.set(principal, set);
    }
    for (const permission of permissions) set.add(permission);
  }

  revoke(principal: string, permission: string): void {
    this.grants.get(principal)?.delete(permission);
  }

  granted(principal: string): string[] {
    return [...(this.grants.get(principal) ?? [])];
  }

  check(principal: string, required: string): boolean {
    for (const source of [principal, '*']) {
      const set = this.grants.get(source);
      if (!set) continue;
      for (const granted of set) {
        if (permissionMatches(granted, required)) return true;
      }
    }
    return false;
  }

  /** Throws PERMISSION_DENIED when the principal lacks the permission. */
  require(principal: string, required: string): void {
    if (!this.check(principal, required)) {
      throw new MegaError('PERMISSION_DENIED', `"${principal}" lacks permission "${required}"`, {
        principal,
        required,
      });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Secrets
 * ------------------------------------------------------------------ */

export class SecretVault {
  private readonly secrets = new Map<string, string>();

  set(name: string, value: string): void {
    if (!value) throw new MegaError('INVALID_INPUT', `Secret "${name}" must not be empty`);
    this.secrets.set(name, value);
  }

  get(name: string): string | undefined {
    return this.secrets.get(name);
  }

  has(name: string): boolean {
    return this.secrets.has(name);
  }

  /** Names only — values are never enumerated. */
  names(): string[] {
    return [...this.secrets.keys()];
  }

  /** Replace any secret value appearing in `text` with a redaction marker. */
  redact(text: string): string {
    let out = text;
    for (const [name, value] of this.secrets) {
      if (value.length < 4) continue;
      out = out.split(value).join(`[redacted:${name}]`);
    }
    return out;
  }

  /** Pull well-known secrets out of the environment. */
  loadFromEnv(env: NodeJS.ProcessEnv, names: string[]): void {
    for (const name of names) {
      const value = env[name];
      if (value) this.set(name, value);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Audit log
 * ------------------------------------------------------------------ */

export class AuditLog {
  private readonly collection;

  constructor(
    database: Database,
    private readonly bus?: EventBus,
    private readonly clock: Clock = systemClock,
  ) {
    this.collection = database.collection<AuditEntry>('audit');
  }

  async record(input: {
    actor: string;
    action: string;
    target?: string;
    outcome: AuditEntry['outcome'];
    details?: JsonObject;
  }): Promise<AuditEntry> {
    const entry: AuditEntry = {
      id: newId('aud'),
      timestamp: this.clock.now(),
      actor: input.actor,
      action: input.action,
      target: input.target,
      outcome: input.outcome,
      details: input.details ?? {},
    };
    await this.collection.put(entry);
    this.bus?.emit(Events.AuditRecorded, entry, 'security');
    return entry;
  }

  async recent(limit = 100): Promise<AuditEntry[]> {
    const all = await this.collection.all();
    return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }
}

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

/** Sliding-window limiter (per key). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly clock: Clock = systemClock,
  ) {
    if (max < 1) throw new MegaError('INVALID_INPUT', 'RateLimiter max must be >= 1');
  }

  consume(key = 'default'): RateDecision {
    const now = this.clock.now();
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);
    if (list.length >= this.max) {
      const oldest = list[0] ?? now;
      this.hits.set(key, list);
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
    }
    list.push(now);
    this.hits.set(key, list);
    return { allowed: true, remaining: this.max - list.length, retryAfterMs: 0 };
  }

  reset(key?: string): void {
    if (key) this.hits.delete(key);
    else this.hits.clear();
  }
}
