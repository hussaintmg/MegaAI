/**
 * @megaai/orchestrator — the heart of MegaAI.
 *
 * One sentence goes in ("Build this client's ecommerce store"), and the
 * orchestrator drives the whole loop the vision describes:
 *
 *   Think   — meta brain analyses the goal
 *   Plan    — a phased plan is generated
 *   Divide  — the plan becomes projects, milestones and dependent tasks
 *   Assign  — each ready task is claimed for the right agent kind
 *   Monitor — events, metrics, audit and heartbeats stream out
 *   Recover — provider fallback, task retries and agent restarts
 *   Learn   — every outcome lands in the meta brain's learning store
 */

import { mkdirSync, readdirSync, writeFileSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import type { JsonObject, ProjectRecord, TaskRecord, WorkflowRunRecord } from '@megaai/types';
import { Events, MegaError } from '@megaai/types';
import { type Clock, newId, slugify, systemClock } from '@megaai/utils';
import type { MegaConfig } from '@megaai/config';
import type { Logger } from '@megaai/logger';
import type { EventBus } from '@megaai/events';
import type { Database } from '@megaai/database';
import type { AuditLog, PermissionManager } from '@megaai/security';
import type { MetricsRegistry } from '@megaai/runtime';
import type { ResourceMonitor } from '@megaai/resources';
import type { AiSessionManager } from '@megaai/ai';
import type { MemoryEngine } from '@megaai/memory';
import type { ApprovalManager, PolicyEngine } from '@megaai/policy';
import type { PlanningService } from '@megaai/planning';
import { WorkflowEngine } from '@megaai/workflow';
import type { ToolRegistry } from '@megaai/tools';
import { ActionEngine } from '@megaai/actions';
import { buildTaskMessages } from '@megaai/prompt';
import type { ContextEngine } from '@megaai/context';
import { AgentRuntime, type PreparedContext } from '@megaai/agents';
import { GitEngine } from '@megaai/code';
import type { AgentImplementation } from '@megaai/contracts';
import type { MetaBrain } from '@megaai/meta-brain';

/* ------------------------------------------------------------------ *
 * Delivery report helpers
 * ------------------------------------------------------------------ */

/** Keep a markdown table cell from breaking the table. */
function escapeCell(text: string): string {
  const flat = text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat || '—';
}

/** What the agent reported for a task — the summary it wrote, when there is one. */
function taskSummary(task: TaskRecord): string {
  const result = task.result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const summary = (result as JsonObject).summary;
    if (typeof summary === 'string' && summary.trim()) return summary;
  }
  return 'done';
}

/** Every delivered file, workspace-relative (skips git and dependency noise). */
function listWorkspaceFiles(dir: string, base = dir, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listWorkspaceFiles(full, base, out);
    else out.push(relative(base, full));
    if (out.length >= 300) return out;
  }
  return out.sort();
}

export interface OrchestratorOptions {
  config: MegaConfig;
  logger: Logger;
  bus: EventBus;
  database: Database;
  planning: PlanningService;
  workflow: WorkflowEngine;
  policy: PolicyEngine;
  approvals: ApprovalManager;
  permissions: PermissionManager;
  audit: AuditLog;
  sessions: AiSessionManager;
  memory: MemoryEngine;
  contextEngine: ContextEngine;
  tools: ToolRegistry;
  meta: MetaBrain;
  resources: ResourceMonitor;
  metrics: MetricsRegistry;
  agentImplementations: AgentImplementation[];
  clock?: Clock;
}

export interface GoalResult {
  project: ProjectRecord;
  run: WorkflowRunRecord;
  tasks: TaskRecord[];
  workspaceDir: string;
}

export class Orchestrator {
  readonly name = 'orchestrator';
  readonly agents: AgentRuntime;
  readonly actions: ActionEngine;
  private readonly o: OrchestratorOptions;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly workspaceIndex;
  private readonly git = new GitEngine();

  constructor(options: OrchestratorOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
    this.log = options.logger.child('orchestrator');
    this.workspaceIndex = options.database.kv('workspaces');

    this.actions = new ActionEngine({
      registry: options.tools,
      policy: options.policy,
      approvals: options.approvals,
      can: (actor, permission) => options.permissions.check(actor, permission),
      bus: options.bus,
      logger: options.logger.child('actions'),
      clock: this.clock,
    });

    this.agents = new AgentRuntime({
      createContext: (task, implementation, instance, signal) =>
        this.createAgentContext(task, implementation, instance.id, signal),
      bus: options.bus,
      logger: options.logger.child('agents'),
      clock: this.clock,
      heartbeatIntervalMs: options.config.agents.heartbeatIntervalMs,
      maxRestarts: options.config.agents.maxRestarts,
      maxConcurrent: options.config.agents.maxConcurrent,
    });

    for (const implementation of options.agentImplementations) {
      this.agents.register(implementation);
      this.grantToolPermissions(implementation);
    }
  }

  /** Give each agent kind exactly the permissions its allowed tools need. */
  private grantToolPermissions(implementation: AgentImplementation): void {
    const actor = `agent:${implementation.descriptor.kind}`;
    const permissions = new Set<string>();
    for (const toolName of implementation.descriptor.allowedTools) {
      const tool = this.o.tools.get(toolName);
      for (const permission of tool?.permissions ?? []) permissions.add(permission);
    }
    if (permissions.size > 0) this.o.permissions.grant(actor, ...permissions);
  }

  /* --------------------------- workspaces --------------------------- */

  private async workspaceFor(projectId: string, projectName?: string): Promise<string> {
    const existing = await this.workspaceIndex.get<string>(projectId);
    if (existing) return existing;
    const dir = join(
      this.o.config.system.workspaceRoot,
      `${slugify(projectName ?? projectId)}-${projectId.slice(-6)}`,
    );
    mkdirSync(dir, { recursive: true });
    await this.workspaceIndex.set(projectId, dir);
    return dir;
  }

  /* ------------------------- agent contexts ------------------------- */

  private async createAgentContext(
    task: TaskRecord,
    implementation: AgentImplementation,
    instanceId: string,
    signal: AbortSignal,
  ): Promise<PreparedContext> {
    const descriptor = implementation.descriptor;
    const project = await this.o.planning.getProject(task.projectId);
    const workspaceRoot = await this.workspaceFor(task.projectId, project?.name);
    const complexity = await this.o.meta.complexityFor(task);
    const session = this.o.sessions.acquire({
      purpose: `task:${task.title}`,
      complexity,
    });
    const agentLogger = this.o.logger.child(`agent.${descriptor.kind}`);
    const actor = `agent:${descriptor.kind}`;

    return {
      ctx: {
        workspaceRoot,
        toolCatalog: this.o.tools.describeForPrompt(descriptor.allowedTools),
        capabilities: { shell: this.o.config.security.allowShell },
        session,
        act: (actions) =>
          this.actions.execute(actions, {
            actor,
            allowedTools: descriptor.allowedTools,
            ctx: {
              workspaceRoot,
              agentId: instanceId,
              taskId: task.id,
              log: (message, fields) => agentLogger.debug(message, fields),
            },
          }),
        remember: async (text, tags) => {
          await this.o.memory.remember({ scope: 'project', refId: task.projectId, text, tags });
        },
        recall: async (query, limit) =>
          (await this.o.memory.search(query, { refId: task.projectId, limit: limit ?? 5 })).map(
            (hit) => hit.record.text,
          ),
        buildContext: (target) => this.o.contextEngine.assemble(target),
        buildMessages: (target, contextText) =>
          buildTaskMessages({ task: target, contextText, priorAttemptError: target.error }),
        log: (message, fields) => agentLogger.info(message, fields),
        signal,
      },
      dispose: () => session.release(),
    };
  }

  /* --------------------------- goal intake --------------------------- */

  /**
   * The one-sentence entrypoint: plan the goal, materialise it, then run a
   * checkpointed workflow that executes every task through agents.
   */
  async submitGoal(goal: string): Promise<GoalResult> {
    this.o.bus.emit(Events.GoalReceived, { goal }, 'orchestrator');
    this.o.metrics.inc('goals.received');
    this.log.info('goal received', { goal });

    const plan = await this.o.meta.makePlan(goal);
    const { project, tasks } = await this.o.planning.materializePlan(plan, goal);
    const workspaceDir = await this.workspaceFor(project.id, project.name);
    await this.o.audit.record({
      actor: 'orchestrator',
      action: 'goal.planned',
      target: project.id,
      outcome: 'ok',
      details: { goal, domain: plan.domain, tasks: tasks.length },
    });

    const definition = {
      name: `goal-${project.id}`,
      steps: [
        {
          name: 'approve-plan',
          requiresApproval: true,
          approvalDescription: `Execute plan for "${project.name}": ${plan.summary}`,
          run: async () => ({ approved: true }),
        },
        {
          name: 'execute-tasks',
          maxAttempts: 1,
          run: async () => this.executeAllTasks(project.id),
        },
        {
          name: 'finalize',
          run: async () => this.finalizeProject(project.id, goal, workspaceDir),
        },
      ],
    };

    const run = await this.o.workflow.start(definition, { projectId: project.id, goal } as JsonObject);

    const refreshed = (await this.o.planning.getProject(project.id)) ?? project;
    const finishedTasks = await this.o.planning.tasksOf(project.id);
    const completedAll = refreshed.status === 'completed';
    this.o.bus.emit(
      completedAll ? Events.GoalCompleted : Events.GoalFailed,
      { projectId: project.id, goal, status: refreshed.status },
      'orchestrator',
    );
    this.o.metrics.inc(completedAll ? 'goals.completed' : 'goals.failed');
    return { project: refreshed, run, tasks: finishedTasks, workspaceDir };
  }

  /** Claim and run ready tasks in waves until nothing is left to do. */
  private async executeAllTasks(projectId: string): Promise<JsonObject> {
    let completed = 0;
    let failed = 0;
    for (;;) {
      const wave: TaskRecord[] = [];
      const limit = Math.max(1, this.o.meta.concurrency(this.o.config.agents.maxConcurrent));
      for (let slot = 0; slot < limit; slot += 1) {
        const claimed = await this.o.planning.claimNextTask(projectId);
        if (!claimed) break;
        wave.push(claimed);
      }
      if (wave.length === 0) break;
      const results = await Promise.all(wave.map((task) => this.runOneTask(task)));
      for (const ok of results) {
        if (ok) completed += 1;
        else failed += 1;
      }
    }
    const progress = await this.o.planning.progressOf(projectId);
    return { completedThisRun: completed, failedThisRun: failed, ...progress } as unknown as JsonObject;
  }

  private async runOneTask(task: TaskRecord): Promise<boolean> {
    const start = this.clock.now();
    this.log.info('task started', { task: task.title, agent: task.agentKind, attempt: task.attempts });
    let ok = false;
    let provider = 'unknown';
    let model = 'unknown';
    let error: string | undefined;
    try {
      const result = await this.agents.runTask(task);
      ok = result.ok;
      error = result.error;
      const output = result.output as { provider?: string; model?: string } | undefined;
      provider = output?.provider ?? provider;
      model = output?.model ?? model;
      if (result.ok) {
        await this.o.planning.completeTask(task.id, { summary: result.summary } as JsonObject);
      } else {
        await this.o.planning.failTask(task.id, result.error ?? 'agent reported failure');
      }
    } catch (err) {
      const megaError = MegaError.from(err);
      error = megaError.message;
      await this.o.planning.failTask(task.id, megaError.message);
    }
    const durationMs = this.clock.now() - start;
    this.o.metrics.inc(ok ? 'tasks.completed' : 'tasks.failed');
    this.o.metrics.observe('tasks.duration', durationMs);
    await this.o.meta.recordOutcome({
      projectId: task.projectId,
      taskId: task.id,
      agentKind: task.agentKind,
      provider,
      model,
      ok,
      durationMs,
      error,
    });
    await this.o.audit.record({
      actor: `agent:${task.agentKind}`,
      action: 'task.run',
      target: task.title,
      outcome: ok ? 'ok' : 'error',
      details: { taskId: task.id, durationMs, error: error ?? null },
    });
    this.log.info(ok ? 'task completed' : 'task failed', { task: task.title, durationMs, error: error ?? null });
    return ok;
  }

  /** Write the human-readable delivery report into the workspace. */
  private async finalizeProject(projectId: string, goal: string, workspaceDir: string): Promise<JsonObject> {
    const project = await this.o.planning.getProject(projectId);
    const tasks = await this.o.planning.tasksOf(projectId);
    const usage = this.o.sessions.usage();
    const files = listWorkspaceFiles(workspaceDir);
    const failed = tasks.filter((task) => task.state === 'failed' || task.state === 'blocked');

    const lines = [
      `# MegaAI delivery report`,
      ``,
      `**Goal:** ${goal}`,
      `**Project:** ${project?.name ?? projectId}`,
      `**Status:** ${project?.status ?? 'unknown'} (${Math.round((project?.progress ?? 0) * 100)}%)`,
      ``,
      `## Tasks`,
      `| State | Task | Agent | Attempts | Outcome |`,
      `| --- | --- | --- | --- | --- |`,
      ...tasks.map((task) => {
        const outcome = task.state === 'completed' ? taskSummary(task) : (task.error ?? '—');
        return `| ${task.state} | ${task.title} | ${task.agentKind} | ${task.attempts} | ${escapeCell(outcome)} |`;
      }),
    ];

    // A failed delivery must say what went wrong where the human is looking,
    // not only in the logs.
    if (failed.length > 0) {
      lines.push(``, `## What went wrong`);
      for (const task of failed) {
        lines.push(`- **${task.title}** (${task.agentKind}, ${task.attempts} attempt(s)): ${task.error ?? 'no error recorded'}`);
      }
    }

    lines.push(
      ``,
      `## Delivered files (${files.length})`,
      ...(files.length > 0 ? files.map((file) => `- \`${file}\``) : ['_No files were written._']),
      ``,
      `## AI usage`,
      `- Requests: ${usage.requests}`,
      `- Tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`,
      `- Estimated cost: $${usage.estimatedCostUsd.toFixed(4)}`,
      ``,
      `_Generated ${new Date(this.clock.now()).toISOString()} by MegaAI._`,
    );
    writeFileSync(join(workspaceDir, 'MEGAAI_REPORT.md'), `${lines.join('\n')}\n`, 'utf8');

    // Version the delivery: every finished workspace becomes a git repo with
    // the whole delivery (report included) as a commit. Best-effort — a
    // machine without git still gets its files and report.
    let commitSha: string | null = null;
    try {
      if (await GitEngine.isAvailable()) {
        commitSha =
          (await this.git.commitAll(workspaceDir, `MegaAI delivery: ${project?.name ?? goal}`)) ?? null;
        if (commitSha) this.log.info('delivery versioned', { commit: commitSha.slice(0, 8) });
      }
    } catch (err) {
      this.log.warn('could not version the delivery workspace', { error: String(err) });
    }
    return { report: 'MEGAAI_REPORT.md', commit: commitSha };
  }

  /* ---------------------------- observability ------------------------ */

  async overview(): Promise<JsonObject> {
    const projects = await this.o.planning.listProjects();
    const projectSummaries = await Promise.all(
      projects.slice(0, 20).map(async (project) => {
        const progress = await this.o.planning.progressOf(project.id);
        return {
          id: project.id,
          name: project.name,
          status: project.status,
          progress: Math.round(project.progress * 100),
          tasksTotal: progress.total,
          tasksCompleted: progress.completed,
          tasksFailed: progress.failed,
        };
      }),
    );
    return {
      projects: projectSummaries,
      agents: this.agents.list() as unknown as JsonObject['agents'],
      providers: this.o.sessions.providerStatus() as unknown as JsonObject['providers'],
      aiUsage: this.o.sessions.usage() as unknown as JsonObject['aiUsage'],
      resources: (this.o.resources.latest() ?? null) as unknown as JsonObject['resources'],
      pressure: this.o.resources.pressure(),
      pendingApprovals: this.o.approvals.pending() as unknown as JsonObject['pendingApprovals'],
      metrics: this.o.metrics.snapshot() as unknown as JsonObject['metrics'],
      learning: (await this.o.meta.stats()) as unknown as JsonObject['learning'],
    } as JsonObject;
  }

  approve(approvalId: string, approved: boolean, by = 'human'): void {
    this.o.approvals.resolve(approvalId, approved, by);
  }

  /** Ids are convenient for tests and the CLI. */
  newTraceId(): string {
    return newId('trace');
  }
}

export type { WorkflowEngine };
