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
import { type Clock, extractJsonObject, isPlainObject, repairJsonObject, systemClock } from '@megaai/utils';
import type { ToolRegistry, ToolContext } from '@megaai/tools';
import type { ApprovalManager, PolicyEngine } from '@megaai/policy';
import type { EventBus } from '@megaai/events';
import type { Logger } from '@megaai/logger';

export interface ParsedProposal {
  thoughts?: string;
  summary: string;
  actions: ActionRequest[];
  /** The reply was salvaged from malformed or truncated JSON. */
  repaired?: boolean;
  /**
   * Nothing usable came back. The caller must treat this as a failed attempt —
   * silently reporting success with zero actions is how a run finished every
   * task and delivered no files.
   */
  unparsed?: boolean;
}

/**
 * File blocks: source code delivered outside the JSON, unescaped.
 *
 *   ===FILE app/page.tsx===
 *   export default function Page() { … }
 *   ===END===
 *
 * A JSON string is the wrong container for a source file. One unescaped
 * newline invalidates the entire reply — every other file in it included — and
 * a reply cut off mid-file loses the ones after it too. A block needs no
 * escaping at all, and each completed block stands on its own.
 */
export interface ExtractedFile {
  path: string;
  content: string;
  /** The closing marker never arrived — the reply stopped inside this file. */
  unterminated?: boolean;
}

/** Pull every file block out of a reply, in order. */
export function extractFileBlocks(text: string): ExtractedFile[] {
  const files: ExtractedFile[] = [];
  // `\Z` is not JavaScript; match an explicit terminator or run to the end.
  const pattern = /^[ \t]*={3,}\s*FILE\s+(.+?)\s*={3,}[ \t]*\r?\n([\s\S]*?)(?=^[ \t]*={3,}\s*(?:END|FILE)\b|$(?![\s\S]))/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const path = (match[1] ?? '').trim();
    if (!path || path.length > 400) continue;
    const after = text.slice(match.index + match[0].length);
    const terminated = /^[ \t]*={3,}\s*END\b/m.test(after.split('\n')[0] ?? '') || /^[ \t]*={3,}\s*END\b/.test(after);
    // Strip a single trailing newline the marker line contributed.
    files.push({
      path: path.replace(/^["'`]|["'`]$/g, ''),
      content: (match[2] ?? '').replace(/\r?\n$/, ''),
      ...(terminated ? {} : { unterminated: true }),
    });
  }
  return files;
}

/** Parse the action protocol out of free-form model output. */
export function parseProposal(text: string): ParsedProposal {
  const blocks = extractFileBlocks(text);
  // The JSON is whatever comes before the first block; a block's contents can
  // easily contain braces of its own.
  const firstBlock = text.search(/^[ \t]*={3,}\s*FILE\s+/m);
  const jsonPart = firstBlock === -1 ? text : text.slice(0, firstBlock);

  let repaired = false;
  let parsed = extractJsonObject(jsonPart);
  if (!isPlainObject(parsed)) {
    // Source code inside a JSON string breaks in two predictable ways: raw
    // newlines the model did not escape, and a reply cut off at the output
    // ceiling mid-file. Both are recoverable; throwing the reply away is not.
    parsed = repairJsonObject(jsonPart);
    repaired = isPlainObject(parsed);
  }
  if (!isPlainObject(parsed)) {
    // Blocks alone are enough: the files are the work, and a reply that got
    // them right should not be thrown away over a malformed preamble.
    const fromBlocks = fileActions(blocks);
    if (fromBlocks.length > 0) {
      return {
        summary: `Wrote ${fromBlocks.length} file(s): ${fromBlocks.map((a) => a.input.path).join(', ')}.`,
        actions: fromBlocks,
        repaired: true,
      };
    }
    return { summary: jsonPart.trim().slice(0, 2_000), actions: [], unparsed: true };
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
  // Blocks come first: a file the model wrote out in full beats the same path
  // half-declared in the JSON.
  const blockActions = fileActions(blocks);
  const merged = [...blockActions, ...actions.filter((a) => !(a.tool === 'fs.write' && blockActions.some((b) => b.input.path === a.input.path)))];

  return {
    thoughts: typeof objectValue.thoughts === 'string' ? objectValue.thoughts : undefined,
    // A repaired reply often lost its trailing "summary" key, so fall back to
    // describing what did survive rather than dumping raw JSON as the summary.
    summary:
      typeof objectValue.summary === 'string'
        ? objectValue.summary
        : repaired
          ? `Reply was truncated; recovered ${merged.length} action(s).`
          : jsonPart.trim().slice(0, 2_000),
    actions: merged,
    ...(repaired || blocks.some((b) => b.unterminated) ? { repaired: true } : {}),
  };
}

/** Complete file blocks become fs.write actions; a cut-off one is dropped. */
function fileActions(blocks: readonly ExtractedFile[]): ActionRequest[] {
  return blocks
    .filter((block) => !block.unterminated)
    .map((block) => ({
      tool: 'fs.write',
      input: { path: block.path, content: block.content } as JsonObject,
      reason: 'file block',
    }));
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
