/**
 * @megaai/actions — the verification gate between "the model said" and
 * "the system did".
 *
 * Parses action proposals out of model output, validates them against the
 * tool registry, checks actor permissions and policy (including approval
 * gates), executes through tools and reports structured results. Nothing an
 * agent proposes touches the world except through here.
 */

import type { ActionRequest, ActionResult, JsonObject } from '@megaai/types';
import { Events, MegaError } from '@megaai/types';
import { type Clock, extractJsonObject, isPlainObject, systemClock } from '@megaai/utils';
import type { ToolRegistry, ToolContext } from '@megaai/tools';
import type { ApprovalManager, PolicyEngine } from '@megaai/policy';
import type { EventBus } from '@megaai/events';
import type { Logger } from '@megaai/logger';

export interface ParsedProposal {
  thoughts?: string;
  summary: string;
  actions: ActionRequest[];
}

/** Parse the action protocol out of free-form model output. */
export function parseProposal(text: string): ParsedProposal {
  const parsed = extractJsonObject(text);
  if (!isPlainObject(parsed)) {
    // No JSON at all — treat the whole text as a summary with no actions.
    return { summary: text.trim().slice(0, 2_000), actions: [] };
  }
  const objectValue = parsed as JsonObject;
  const actions: ActionRequest[] = [];
  const rawActions = objectValue.actions;
  if (Array.isArray(rawActions)) {
    for (const raw of rawActions) {
      if (!isPlainObject(raw)) continue;
      const tool = raw.tool;
      const input = raw.input;
      if (typeof tool !== 'string' || !isPlainObject(input)) continue;
      actions.push({
        tool,
        input: input as JsonObject,
        reason: typeof raw.reason === 'string' ? raw.reason : undefined,
      });
    }
  }
  return {
    thoughts: typeof objectValue.thoughts === 'string' ? objectValue.thoughts : undefined,
    summary: typeof objectValue.summary === 'string' ? objectValue.summary : text.trim().slice(0, 2_000),
    actions,
  };
}

export interface ActionEngineOptions {
  registry: ToolRegistry;
  policy: PolicyEngine;
  approvals?: ApprovalManager;
  /**
   * Actor-level grant check (wired to security's PermissionManager by the
   * orchestrator). Missing = every actor holds every permission.
   */
  can?: (actor: string, permission: string) => boolean;
  bus?: EventBus;
  logger?: Logger;
  clock?: Clock;
  maxActionsPerBatch?: number;
}

export interface ExecuteOptions {
  actor: string;
  ctx: ToolContext;
  /** Restrict which tools this actor may call (agent allowlist). */
  allowedTools?: string[];
}

export class ActionEngine {
  readonly name = 'actions';
  private readonly options: ActionEngineOptions;
  private readonly clock: Clock;

  constructor(options: ActionEngineOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
  }

  /** Validate + authorise + execute a batch of actions, in order. */
  async execute(actions: ActionRequest[], options: ExecuteOptions): Promise<ActionResult[]> {
    const limit = this.options.maxActionsPerBatch ?? 20;
    if (actions.length > limit) {
      throw new MegaError('INVALID_INPUT', `Refusing to run ${actions.length} actions (limit ${limit})`);
    }
    const results: ActionResult[] = [];
    for (const action of actions) {
      results.push(await this.executeOne(action, options));
    }
    return results;
  }

  private blocked(action: ActionRequest, reason: string, options: ExecuteOptions): ActionResult {
    this.options.bus?.emit(
      Events.ActionBlocked,
      { tool: action.tool, actor: options.actor, reason },
      'actions',
    );
    this.options.logger?.warn('action blocked', { tool: action.tool, actor: options.actor, reason });
    return { tool: action.tool, ok: false, error: reason, durationMs: 0 };
  }

  private async executeOne(action: ActionRequest, options: ExecuteOptions): Promise<ActionResult> {
    const tool = this.options.registry.get(action.tool);
    if (!tool) return this.blocked(action, `unknown tool "${action.tool}"`, options);
    if (options.allowedTools && !options.allowedTools.includes(tool.name)) {
      return this.blocked(action, `tool "${tool.name}" is not allowed for this agent`, options);
    }

    for (const permission of tool.permissions) {
      if (this.options.can && !this.options.can(options.actor, permission)) {
        return this.blocked(action, `actor lacks permission "${permission}"`, options);
      }
      const decision = this.options.policy.evaluate({ actor: options.actor, permission });
      if (!decision.allowed) {
        return this.blocked(action, `policy denied "${permission}": ${decision.reasons.join('; ')}`, options);
      }
      if (decision.requiresApproval && this.options.approvals) {
        const approval = this.options.approvals.request(
          `action:${tool.name}`,
          `${options.actor} wants to run ${tool.name} (${permission}): ${action.reason ?? 'no reason given'}`,
        );
        const resolved = await this.options.approvals.waitFor(approval.id);
        if (resolved.status !== 'approved') {
          return this.blocked(action, `approval rejected for "${permission}"`, options);
        }
      }
    }

    const start = this.clock.now();
    try {
      const output = await tool.execute(action.input, options.ctx);
      const result: ActionResult = {
        tool: tool.name,
        ok: true,
        output,
        durationMs: this.clock.now() - start,
      };
      this.options.bus?.emit(
        Events.ActionExecuted,
        { tool: tool.name, actor: options.actor, ok: true, durationMs: result.durationMs },
        'actions',
      );
      return result;
    } catch (err) {
      const error = MegaError.from(err);
      const result: ActionResult = {
        tool: tool.name,
        ok: false,
        error: error.message,
        durationMs: this.clock.now() - start,
      };
      this.options.bus?.emit(
        Events.ActionExecuted,
        { tool: tool.name, actor: options.actor, ok: false, error: error.message },
        'actions',
      );
      return result;
    }
  }
}
