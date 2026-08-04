/**
 * @megaai/planning — projects, milestones, tasks and the dependency graph.
 *
 * The meta brain produces a PlanSpec; this service materialises it into
 * durable records, then answers the orchestrator's only two questions:
 * "what can run next?" and "how far along are we?".
 */

import type {
  Id,
  JsonObject,
  JsonValue,
  MilestoneRecord,
  PlanSpec,
  Priority,
  ProjectRecord,
  TaskAttachment,
  TaskRecord,
} from '@megaai/types';
import { Events, MegaError } from '@megaai/types';
import { type Clock, newId, systemClock } from '@megaai/utils';
import type { Database, Collection } from '@megaai/database';
import type { EventBus } from '@megaai/events';

const PRIORITY_ORDER: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export interface CreateTaskInput {
  projectId: Id;
  milestoneId?: Id;
  title: string;
  description?: string;
  agentKind: string;
  priority?: Priority;
  complexity?: TaskRecord['complexity'];
  dependsOn?: Id[];
  maxAttempts?: number;
  /** Images the assigned agent should look at, e.g. for `vision` tasks. */
  attachments?: TaskAttachment[];
}

export class PlanningService {
  readonly name = 'planning';
  private readonly projects: Collection<ProjectRecord>;
  private readonly milestones: Collection<MilestoneRecord>;
  private readonly tasks: Collection<TaskRecord>;

  constructor(
    database: Database,
    private readonly bus?: EventBus,
    private readonly clock: Clock = systemClock,
  ) {
    this.projects = database.collection<ProjectRecord>('projects');
    this.milestones = database.collection<MilestoneRecord>('milestones');
    this.tasks = database.collection<TaskRecord>('tasks');
  }

  /* ---------------------------- projects ---------------------------- */

  async createProject(input: { name: string; goal: string; meta?: JsonObject }): Promise<ProjectRecord> {
    const now = this.clock.now();
    const project: ProjectRecord = {
      id: newId('prj'),
      name: input.name,
      goal: input.goal,
      status: 'active',
      progress: 0,
      createdAt: now,
      updatedAt: now,
      meta: input.meta ?? {},
    };
    await this.projects.put(project);
    this.bus?.emit(Events.ProjectCreated, { project }, 'planning');
    return project;
  }

  async getProject(id: Id): Promise<ProjectRecord | undefined> {
    return this.projects.get(id);
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return (await this.projects.all()).sort((a, b) => b.createdAt - a.createdAt);
  }

  private async saveProject(project: ProjectRecord): Promise<void> {
    project.updatedAt = this.clock.now();
    await this.projects.put(project);
    this.bus?.emit(Events.ProjectUpdated, { project }, 'planning');
  }

  /* --------------------------- milestones --------------------------- */

  async addMilestone(projectId: Id, name: string, order: number): Promise<MilestoneRecord> {
    const milestone: MilestoneRecord = { id: newId('mls'), projectId, name, order };
    await this.milestones.put(milestone);
    return milestone;
  }

  async milestonesOf(projectId: Id): Promise<MilestoneRecord[]> {
    return (await this.milestones.find((m) => m.projectId === projectId)).sort((a, b) => a.order - b.order);
  }

  /* ------------------------------ tasks ------------------------------ */

  async addTask(input: CreateTaskInput): Promise<TaskRecord> {
    const now = this.clock.now();
    const task: TaskRecord = {
      id: newId('tsk'),
      projectId: input.projectId,
      milestoneId: input.milestoneId,
      title: input.title,
      description: input.description ?? '',
      agentKind: input.agentKind,
      state: 'pending',
      priority: input.priority ?? 'normal',
      complexity: input.complexity ?? 'standard',
      dependsOn: input.dependsOn ?? [],
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 2,
      attachments: input.attachments,
      createdAt: now,
      updatedAt: now,
    };
    await this.tasks.put(task);
    this.bus?.emit(Events.TaskUpdated, { task }, 'planning');
    return task;
  }

  async getTask(id: Id): Promise<TaskRecord | undefined> {
    return this.tasks.get(id);
  }

  async tasksOf(projectId: Id): Promise<TaskRecord[]> {
    return (await this.tasks.find((task) => task.projectId === projectId)).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }

  private async saveTask(task: TaskRecord): Promise<TaskRecord> {
    task.updatedAt = this.clock.now();
    await this.tasks.put(task);
    this.bus?.emit(Events.TaskUpdated, { task }, 'planning');
    return task;
  }

  /**
   * Tasks whose dependencies are all completed and that are waiting to run.
   * Also transitions tasks to `blocked` when a dependency permanently failed.
   */
  async readyTasks(projectId: Id): Promise<TaskRecord[]> {
    const tasks = await this.tasksOf(projectId);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const ready: TaskRecord[] = [];
    for (const task of tasks) {
      if (task.state !== 'pending' && task.state !== 'ready') continue;
      const deps = task.dependsOn.map((id) => byId.get(id)).filter((dep): dep is TaskRecord => Boolean(dep));
      if (deps.some((dep) => dep.state === 'failed' || dep.state === 'cancelled')) {
        task.state = 'blocked';
        await this.saveTask(task);
        continue;
      }
      if (deps.every((dep) => dep.state === 'completed')) ready.push(task);
    }
    return ready.sort(
      (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt,
    );
  }

  /** Atomically pick the next ready task and mark it in-progress. */
  async claimNextTask(projectId: Id): Promise<TaskRecord | undefined> {
    const [next] = await this.readyTasks(projectId);
    if (!next) return undefined;
    next.state = 'in-progress';
    next.attempts += 1;
    return this.saveTask(next);
  }

  async completeTask(id: Id, result?: JsonValue): Promise<TaskRecord> {
    const task = await this.mustGetTask(id);
    task.state = 'completed';
    task.result = result;
    task.error = undefined;
    const saved = await this.saveTask(task);
    await this.refreshProject(task.projectId);
    return saved;
  }

  /** Fail a task; retries stay `pending` until attempts exhaust. */
  async failTask(id: Id, error: string): Promise<TaskRecord> {
    const task = await this.mustGetTask(id);
    task.error = error;
    task.state = task.attempts >= task.maxAttempts ? 'failed' : 'pending';
    const saved = await this.saveTask(task);
    await this.refreshProject(task.projectId);
    return saved;
  }

  private async mustGetTask(id: Id): Promise<TaskRecord> {
    const task = await this.tasks.get(id);
    if (!task) throw new MegaError('NOT_FOUND', `Task "${id}" not found`);
    return task;
  }

  /* ----------------------------- progress ---------------------------- */

  async progressOf(projectId: Id): Promise<{ total: number; completed: number; failed: number; ratio: number }> {
    const tasks = await this.tasksOf(projectId);
    const total = tasks.length;
    const completed = tasks.filter((task) => task.state === 'completed').length;
    const failed = tasks.filter((task) => task.state === 'failed' || task.state === 'blocked').length;
    return { total, completed, failed, ratio: total === 0 ? 0 : completed / total };
  }

  private async refreshProject(projectId: Id): Promise<void> {
    const project = await this.projects.get(projectId);
    if (!project) return;
    const { total, completed, failed, ratio } = await this.progressOf(projectId);
    project.progress = ratio;
    if (total > 0 && completed === total) {
      project.status = 'completed';
      await this.saveProject(project);
      this.bus?.emit(Events.ProjectCompleted, { project }, 'planning');
      return;
    }
    if (total > 0 && failed > 0 && completed + failed === total) {
      project.status = 'failed';
    }
    await this.saveProject(project);
  }

  /* ------------------------- plan materialising ---------------------- */

  /**
   * Turn a PlanSpec into project + milestones + tasks. Phases run
   * sequentially: every task depends on all tasks of the previous phase,
   * plus any explicit same-plan `dependsOnTitles`.
   */
  async materializePlan(plan: PlanSpec, goal: string): Promise<{ project: ProjectRecord; tasks: TaskRecord[] }> {
    const project = await this.createProject({
      name: plan.projectName,
      goal,
      meta: { domain: plan.domain, summary: plan.summary, risks: plan.risks },
    });

    const created: TaskRecord[] = [];
    const idByTitle = new Map<string, Id>();
    let previousPhaseIds: Id[] = [];

    for (const [order, phase] of plan.phases.entries()) {
      const milestone = await this.addMilestone(project.id, phase.name, order);
      const phaseIds: Id[] = [];
      for (const planTask of phase.tasks) {
        const explicit = (planTask.dependsOnTitles ?? [])
          .map((title) => idByTitle.get(title))
          .filter((id): id is Id => Boolean(id));
        const task = await this.addTask({
          projectId: project.id,
          milestoneId: milestone.id,
          title: planTask.title,
          description: planTask.description,
          agentKind: planTask.agentKind,
          complexity: planTask.complexity,
          dependsOn: [...new Set([...previousPhaseIds, ...explicit])],
        });
        created.push(task);
        idByTitle.set(task.title, task.id);
        phaseIds.push(task.id);
      }
      previousPhaseIds = phaseIds;
    }
    return { project, tasks: created };
  }
}
