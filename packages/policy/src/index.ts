/**
 * @megaai/policy — the rulebook.
 *
 * Declarative rules decide what may run, what is forbidden and what needs a
 * human's approval (optionally constrained to time windows). The
 * ApprovalManager holds the "waiting for a human" state that workflows and
 * the action engine block on — with an auto-approve mode for demos and tests.
 */

import type { PolicyDecision, PolicyEffect, Timestamp } from '@megaai/types';
import { Events, MegaError } from '@megaai/types';
import { type Clock, Deferred, newId, systemClock } from '@megaai/utils';
import type { EventBus } from '@megaai/events';

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

export interface TimeWindow {
  /** Local hour 0-23 (inclusive). */
  fromHour: number;
  /** Local hour 0-23 (exclusive; may wrap past midnight). */
  toHour: number;
}

export interface PolicyRule {
  id: string;
  description: string;
  effect: PolicyEffect;
  /** Permission patterns (`fs.*`) this rule applies to; empty = all. */
  permissions?: string[];
  /** Actor names/kinds this rule applies to; empty = all. */
  actors?: string[];
  /** Rule only applies inside this window. */
  window?: TimeWindow;
}

export interface PolicyInput {
  actor: string;
  permission: string;
  timestamp?: Timestamp;
}

function patternMatches(pattern: string, value: string): boolean {
  if (pattern === '*' || pattern === value) return true;
  if (pattern.endsWith('.*')) return value.startsWith(pattern.slice(0, -1));
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return false;
}

export function inWindow(window: TimeWindow, timestamp: Timestamp): boolean {
  const hour = new Date(timestamp).getHours();
  if (window.fromHour === window.toHour) return true; // full day
  if (window.fromHour < window.toHour) return hour >= window.fromHour && hour < window.toHour;
  return hour >= window.fromHour || hour < window.toHour; // wraps midnight
}

export class PolicyEngine {
  readonly name = 'policy';
  private readonly rules: PolicyRule[] = [];
  private maintenanceMode = false;

  constructor(private readonly clock: Clock = systemClock) {}

  addRule(rule: PolicyRule): void {
    if (this.rules.some((existing) => existing.id === rule.id)) {
      throw new MegaError('ALREADY_EXISTS', `Policy rule "${rule.id}" already exists`);
    }
    this.rules.push(rule);
  }

  removeRule(id: string): void {
    const index = this.rules.findIndex((rule) => rule.id === id);
    if (index >= 0) this.rules.splice(index, 1);
  }

  listRules(): PolicyRule[] {
    return [...this.rules];
  }

  setMaintenanceMode(on: boolean): void {
    this.maintenanceMode = on;
  }

  evaluate(input: PolicyInput): PolicyDecision {
    const timestamp = input.timestamp ?? this.clock.now();
    if (this.maintenanceMode) {
      return {
        allowed: false,
        requiresApproval: false,
        matchedRules: ['maintenance-mode'],
        reasons: ['system is in maintenance mode'],
      };
    }

    const matched: PolicyRule[] = [];
    for (const rule of this.rules) {
      const permissionOk =
        !rule.permissions || rule.permissions.some((pattern) => patternMatches(pattern, input.permission));
      const actorOk = !rule.actors || rule.actors.some((pattern) => patternMatches(pattern, input.actor));
      const windowOk = !rule.window || inWindow(rule.window, timestamp);
      if (permissionOk && actorOk && windowOk) matched.push(rule);
    }

    const denies = matched.filter((rule) => rule.effect === 'deny');
    if (denies.length > 0) {
      return {
        allowed: false,
        requiresApproval: false,
        matchedRules: denies.map((rule) => rule.id),
        reasons: denies.map((rule) => rule.description),
      };
    }
    const approvals = matched.filter((rule) => rule.effect === 'require-approval');
    if (approvals.length > 0) {
      return {
        allowed: true,
        requiresApproval: true,
        matchedRules: approvals.map((rule) => rule.id),
        reasons: approvals.map((rule) => rule.description),
      };
    }
    return { allowed: true, requiresApproval: false, matchedRules: matched.map((r) => r.id), reasons: [] };
  }

  /** Build the standard rule set from config lists. */
  static fromConfig(
    options: { deniedPermissions: string[]; approvalRequiredPermissions: string[] },
    clock?: Clock,
  ): PolicyEngine {
    const engine = new PolicyEngine(clock);
    options.deniedPermissions.forEach((permission, index) =>
      engine.addRule({
        id: `deny-${index}-${permission}`,
        description: `permission "${permission}" is denied by configuration`,
        effect: 'deny',
        permissions: [permission],
      }),
    );
    options.approvalRequiredPermissions.forEach((permission, index) =>
      engine.addRule({
        id: `approve-${index}-${permission}`,
        description: `permission "${permission}" requires human approval`,
        effect: 'require-approval',
        permissions: [permission],
      }),
    );
    return engine;
  }
}

/* ------------------------------------------------------------------ *
 * Approvals
 * ------------------------------------------------------------------ */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Approval {
  id: string;
  subject: string;
  description: string;
  status: ApprovalStatus;
  requestedAt: Timestamp;
  resolvedAt?: Timestamp;
  resolvedBy?: string;
}

export class ApprovalManager {
  readonly name = 'approvals';
  private readonly approvals = new Map<string, Approval>();
  private readonly waiters = new Map<string, Deferred<Approval>>();

  constructor(
    private readonly options: { autoApprove?: boolean } = {},
    private readonly bus?: EventBus,
    private readonly clock: Clock = systemClock,
  ) {}

  request(subject: string, description: string): Approval {
    const approval: Approval = {
      id: newId('apr'),
      subject,
      description,
      status: 'pending',
      requestedAt: this.clock.now(),
    };
    this.approvals.set(approval.id, approval);
    this.bus?.emit(Events.ApprovalRequested, { approval }, 'policy');
    if (this.options.autoApprove) {
      // Resolve on a microtask so callers can register waiters first.
      queueMicrotask(() => this.resolve(approval.id, true, 'auto-approve'));
    }
    return approval;
  }

  resolve(id: string, approved: boolean, by: string): Approval {
    const approval = this.approvals.get(id);
    if (!approval) throw new MegaError('NOT_FOUND', `Approval "${id}" not found`);
    if (approval.status !== 'pending') return approval;
    approval.status = approved ? 'approved' : 'rejected';
    approval.resolvedAt = this.clock.now();
    approval.resolvedBy = by;
    this.bus?.emit(Events.ApprovalResolved, { approval }, 'policy');
    this.waiters.get(id)?.resolve(approval);
    this.waiters.delete(id);
    return approval;
  }

  get(id: string): Approval | undefined {
    return this.approvals.get(id);
  }

  pending(): Approval[] {
    return [...this.approvals.values()].filter((approval) => approval.status === 'pending');
  }

  /** Resolves when the approval is decided (or immediately if it already is). */
  async waitFor(id: string): Promise<Approval> {
    const approval = this.approvals.get(id);
    if (!approval) throw new MegaError('NOT_FOUND', `Approval "${id}" not found`);
    if (approval.status !== 'pending') return approval;
    let waiter = this.waiters.get(id);
    if (!waiter) {
      waiter = new Deferred<Approval>();
      this.waiters.set(id, waiter);
    }
    return waiter.promise;
  }
}
