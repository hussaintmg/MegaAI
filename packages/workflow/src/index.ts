/**
 * @megaai/workflow — durable, resumable step execution.
 *
 * Workflows are named sequences of steps with per-step retries, optional
 * rollback handlers, conditions, approval gates and a checkpoint after every
 * step. Runs can be paused, resumed (even from a fresh process, via the
 * persisted checkpoint) and cancelled.
 */

import type { JsonObject, JsonValue, StepRecord, WorkflowRunRecord } from '@megaai/types';
import { Events, MegaError } from '@megaai/types';
import { type Clock, backoffDelay, newId, sleep, systemClock } from '@megaai/utils';
import type { Database, Collection } from '@megaai/database';
import type { EventBus } from '@megaai/events';
import type { ApprovalManager } from '@megaai/policy';

export interface WorkflowContext {
  runId: string;
  /** Shared mutable state persisted with every checkpoint. */
  data: JsonObject;
  outputs: Record<string, JsonValue>;
}

export interface StepDefinition {
  name: string;
  run(ctx: WorkflowContext): Promise<JsonValue | void> | JsonValue | void;
  rollback?(ctx: WorkflowContext): Promise<void> | void;
  /** Overrides the engine-wide max attempts for this step. */
  maxAttempts?: number;
  /** Skip the step (marked `skipped`) when this returns false. */
  condition?(ctx: WorkflowContext): boolean;
  requiresApproval?: boolean;
  approvalDescription?: string;
}

export interface WorkflowDefinition {
  name: string;
  steps: StepDefinition[];
}

export interface WorkflowEngineOptions {
  bus?: EventBus;
  approvals?: ApprovalManager;
  clock?: Clock;
  maxStepAttempts?: number;
  retryBaseMs?: number;
  /** Injectable wait for tests. */
  wait?: (ms: number) => Promise<void>;
}

interface ActiveExecution {
  pauseRequested: boolean;
  cancelRequested: boolean;
}

export class WorkflowEngine {
  readonly name = 'workflow';
  private readonly runs: Collection<WorkflowRunRecord>;
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly active = new Map<string, ActiveExecution>();
  private readonly bus?: EventBus;
  private readonly approvals?: ApprovalManager;
  private readonly clock: Clock;
  private readonly maxStepAttempts: number;
  private readonly retryBaseMs: number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(database: Database, options: WorkflowEngineOptions = {}) {
    this.runs = database.collection<WorkflowRunRecord>('workflow-runs');
    this.bus = options.bus;
    this.approvals = options.approvals;
    this.clock = options.clock ?? systemClock;
    this.maxStepAttempts = options.maxStepAttempts ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 250;
    this.wait = options.wait ?? sleep;
  }

  /** Register a reusable definition (needed to resume after a restart). */
  define(definition: WorkflowDefinition): void {
    this.definitions.set(definition.name, definition);
  }

  async getRun(runId: string): Promise<WorkflowRunRecord | undefined> {
    return this.runs.get(runId);
  }

  async listRuns(limit = 50): Promise<WorkflowRunRecord[]> {
    return (await this.runs.all()).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  pause(runId: string): void {
    const execution = this.active.get(runId);
    if (execution) execution.pauseRequested = true;
  }

  cancel(runId: string): void {
    const execution = this.active.get(runId);
    if (execution) execution.cancelRequested = true;
  }

  /** Start a new run of `definition` (also registers the definition). */
  async start(definition: WorkflowDefinition, initialData: JsonObject = {}): Promise<WorkflowRunRecord> {
    this.define(definition);
    const now = this.clock.now();
    const run: WorkflowRunRecord = {
      id: newId('run'),
      workflowName: definition.name,
      state: 'pending',
      steps: definition.steps.map((step) => ({
        id: newId('stp'),
        name: step.name,
        state: 'pending',
        attempts: 0,
      })),
      context: initialData,
      createdAt: now,
      updatedAt: now,
    };
    await this.checkpoint(run);
    return this.execute(run.id);
  }

  /** Continue a paused/crashed run from its last checkpoint. */
  async resume(runId: string): Promise<WorkflowRunRecord> {
    const run = await this.runs.get(runId);
    if (!run) throw new MegaError('NOT_FOUND', `Workflow run "${runId}" not found`);
    if (run.state === 'completed' || run.state === 'cancelled') return run;
    this.bus?.emit(Events.WorkflowResumed, { runId }, 'workflow');
    return this.execute(runId);
  }

  private async checkpoint(run: WorkflowRunRecord): Promise<void> {
    run.updatedAt = this.clock.now();
    await this.runs.put(run);
  }

  private async execute(runId: string): Promise<WorkflowRunRecord> {
    const run = await this.runs.get(runId);
    if (!run) throw new MegaError('NOT_FOUND', `Workflow run "${runId}" not found`);
    const definition = this.definitions.get(run.workflowName);
    if (!definition) {
      throw new MegaError('NOT_FOUND', `Workflow definition "${run.workflowName}" is not registered`);
    }

    const execution: ActiveExecution = { pauseRequested: false, cancelRequested: false };
    this.active.set(run.id, execution);
    run.state = 'running';
    await this.checkpoint(run);
    this.bus?.emit(Events.WorkflowStarted, { runId: run.id, workflow: run.workflowName }, 'workflow');

    const ctx: WorkflowContext = {
      runId: run.id,
      data: run.context,
      outputs: this.collectOutputs(run),
    };

    try {
      for (let index = 0; index < definition.steps.length; index += 1) {
        const stepDef = definition.steps[index] as StepDefinition;
        const step = run.steps[index] as StepRecord;
        if (step.state === 'completed' || step.state === 'skipped') continue;

        if (execution.cancelRequested) return this.finish(run, 'cancelled');
        if (execution.pauseRequested) {
          run.state = 'paused';
          await this.checkpoint(run);
          this.bus?.emit(Events.WorkflowPaused, { runId: run.id }, 'workflow');
          return run;
        }

        if (stepDef.condition && !stepDef.condition(ctx)) {
          step.state = 'skipped';
          await this.checkpoint(run);
          continue;
        }

        if (stepDef.requiresApproval) {
          const outcome = await this.gateOnApproval(run, step, stepDef);
          if (!outcome) {
            step.state = 'failed';
            step.error = 'approval rejected';
            await this.checkpoint(run);
            await this.rollback(run, definition, ctx);
            return this.finish(run, 'failed');
          }
        }

        const ok = await this.runStep(run, step, stepDef, ctx);
        if (!ok) {
          await this.rollback(run, definition, ctx);
          return this.finish(run, 'failed');
        }
      }
      return this.finish(run, 'completed');
    } finally {
      this.active.delete(run.id);
    }
  }

  private collectOutputs(run: WorkflowRunRecord): Record<string, JsonValue> {
    const outputs: Record<string, JsonValue> = {};
    for (const step of run.steps) {
      if (step.output !== undefined) outputs[step.name] = step.output;
    }
    return outputs;
  }

  private async gateOnApproval(
    run: WorkflowRunRecord,
    step: StepRecord,
    stepDef: StepDefinition,
  ): Promise<boolean> {
    if (!this.approvals) return true; // no approval manager wired: nothing to gate on
    step.state = 'awaiting-approval';
    run.state = 'awaiting-approval';
    await this.checkpoint(run);
    const approval = this.approvals.request(
      `workflow:${run.workflowName}:${step.name}`,
      stepDef.approvalDescription ?? `Approve step "${step.name}" of workflow "${run.workflowName}"`,
    );
    const resolved = await this.approvals.waitFor(approval.id);
    run.state = 'running';
    await this.checkpoint(run);
    return resolved.status === 'approved';
  }

  private async runStep(
    run: WorkflowRunRecord,
    step: StepRecord,
    stepDef: StepDefinition,
    ctx: WorkflowContext,
  ): Promise<boolean> {
    const maxAttempts = stepDef.maxAttempts ?? this.maxStepAttempts;
    step.state = 'running';
    step.startedAt = this.clock.now();
    await this.checkpoint(run);
    this.bus?.emit(Events.StepStarted, { runId: run.id, step: step.name }, 'workflow');

    while (step.attempts < maxAttempts) {
      step.attempts += 1;
      try {
        const output = await stepDef.run(ctx);
        step.state = 'completed';
        step.finishedAt = this.clock.now();
        if (output !== undefined) {
          step.output = output;
          ctx.outputs[step.name] = output;
        }
        step.error = undefined;
        await this.checkpoint(run);
        this.bus?.emit(Events.StepFinished, { runId: run.id, step: step.name, ok: true }, 'workflow');
        return true;
      } catch (err) {
        const error = MegaError.from(err);
        step.error = error.message;
        await this.checkpoint(run);
        if (step.attempts >= maxAttempts) break;
        await this.wait(backoffDelay(step.attempts, this.retryBaseMs, 5_000));
      }
    }
    step.state = 'failed';
    step.finishedAt = this.clock.now();
    await this.checkpoint(run);
    this.bus?.emit(Events.StepFinished, { runId: run.id, step: step.name, ok: false, error: step.error }, 'workflow');
    return false;
  }

  /** Run rollback handlers of completed steps in reverse order. */
  private async rollback(
    run: WorkflowRunRecord,
    definition: WorkflowDefinition,
    ctx: WorkflowContext,
  ): Promise<void> {
    for (let index = run.steps.length - 1; index >= 0; index -= 1) {
      const step = run.steps[index] as StepRecord;
      const stepDef = definition.steps[index] as StepDefinition;
      if (step.state !== 'completed' || !stepDef.rollback) continue;
      try {
        await stepDef.rollback(ctx);
        step.state = 'rolled-back';
      } catch {
        // Rollback is best-effort; the step keeps its completed state.
      }
      await this.checkpoint(run);
    }
  }

  private async finish(run: WorkflowRunRecord, state: 'completed' | 'failed' | 'cancelled'): Promise<WorkflowRunRecord> {
    run.state = state;
    await this.checkpoint(run);
    this.bus?.emit(Events.WorkflowFinished, { runId: run.id, state }, 'workflow');
    return run;
  }
}
