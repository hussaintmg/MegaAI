/**
 * @megaai/context — decides what a model gets to see.
 *
 * Before any prompt is built, the context engine gathers the project state,
 * what sibling tasks already produced and the most relevant memories, then
 * trims everything to a token budget. Agents receive curated context, not a
 * raw dump.
 */

import type { TaskRecord } from '@megaai/types';
import { estimateTokens, isPlainObject, truncate } from '@megaai/utils';
import type { MemoryEngine } from '@megaai/memory';
import type { PlanningService } from '@megaai/planning';

export interface ContextEngineOptions {
  memory: MemoryEngine;
  planning: PlanningService;
  /** Rough token budget for the assembled context text. */
  maxTokens?: number;
}

function summaryOfResult(result: unknown): string | undefined {
  if (typeof result === 'string') return result;
  if (isPlainObject(result) && typeof result.summary === 'string') return result.summary;
  return undefined;
}

export class ContextEngine {
  readonly name = 'context';
  private readonly memory: MemoryEngine;
  private readonly planning: PlanningService;
  private readonly maxTokens: number;

  constructor(options: ContextEngineOptions) {
    this.memory = options.memory;
    this.planning = options.planning;
    this.maxTokens = options.maxTokens ?? 2_000;
  }

  /** Build the context block for one task. */
  async assemble(task: TaskRecord): Promise<string> {
    const sections: string[] = [];
    let budget = this.maxTokens;

    const push = (text: string): void => {
      const cost = estimateTokens(text);
      if (cost > budget) return;
      sections.push(text);
      budget -= cost;
    };

    const project = await this.planning.getProject(task.projectId);
    if (project) {
      const progress = await this.planning.progressOf(project.id);
      push(
        `Project: ${project.name}\nGoal: ${truncate(project.goal, 400)}\nProgress: ${progress.completed}/${progress.total} tasks completed`,
      );
    }

    const siblings = await this.planning.tasksOf(task.projectId);
    const done = siblings.filter((sibling) => sibling.state === 'completed' && sibling.id !== task.id);
    if (done.length > 0) {
      const lines = done
        .slice(-8)
        .map((sibling) => {
          const summary = summaryOfResult(sibling.result);
          return `- [done] ${sibling.title}${summary ? ` — ${truncate(summary, 160)}` : ''}`;
        })
        .join('\n');
      push(`Completed so far:\n${lines}`);
    }

    const upcoming = siblings.filter((s) => s.state === 'pending' || s.state === 'ready').slice(0, 5);
    if (upcoming.length > 0) {
      push(`Coming up next (do NOT do these now):\n${upcoming.map((s) => `- ${s.title}`).join('\n')}`);
    }

    const hits = await this.memory.search(`${task.title} ${task.description}`, { limit: 4 });
    const relevant = hits.filter((hit) => hit.score > 0.15);
    if (relevant.length > 0) {
      const lines = relevant
        .map((hit) => `- (${hit.record.scope}) ${truncate(hit.record.text.replace(/\s+/g, ' '), 200)}`)
        .join('\n');
      push(`Relevant memory:\n${lines}`);
    }

    return sections.join('\n\n');
  }
}
