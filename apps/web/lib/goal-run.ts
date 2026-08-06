/**
 * A goal, as the website can see it.
 *
 * The website has no agents of its own. A goal is a row in `goals` and a plan
 * task in `mesh_tasks`; everything that happens to it happens on a machine
 * running `megaai-node`, which writes its progress back into the same queue.
 * So the live view is derived from those documents rather than reported
 * separately — there is no second source to fall out of step with.
 *
 * This file is pure on purpose: no database, no `next`, so the derivation can
 * be tested against the exact documents a real run produces.
 */

import type { MeshNodeDoc, MeshTaskDoc } from './mesh-model.ts';
import { explainWait, isOnline } from './mesh-model.ts';

export type RunState = 'planning' | 'building' | 'completed' | 'failed' | 'waiting';

export interface RunPiece {
  id: string;
  taskId: string;
  title: string;
  surface: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  /** Which coding agent finished it — Claude Code, Codex or OpenCode. */
  finishedBy?: string;
  /** The agents that had a go, in order, when it was handed on. */
  coders: string[];
  files: string[];
  waitingFor?: string;
  error?: string;
}

/** The plan itself, as the planner wrote it. */
export interface RunPlan {
  projectName: string;
  summary: string;
  stack: string[];
  decisions: string[];
  additions: string[];
  risks: string[];
  pieces: Array<{ id: string; title: string; surface: string; intent: string; files: string[]; dependsOn: string[] }>;
}

export interface GoalRun {
  state: RunState;
  /** One sentence for the top of the page. */
  headline: string;
  projectDir?: string;
  plan?: RunPlan;
  pieces: RunPiece[];
  done: number;
  total: number;
  /** Repairs the plan needed when it was read — worth seeing before a night on it. */
  repairs: string[];
}

function strings(value: unknown, limit = 40): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, limit)
    : [];
}

/** The plan the supervisor wrote down, out of its checkpoint. */
export function planOf(planTask: MeshTaskDoc | undefined): { plan?: RunPlan; projectDir?: string; repairs: string[] } {
  const memory = planTask?.checkpoint?.['plan'];
  if (typeof memory !== 'object' || memory === null) return { repairs: [] };
  const record = memory as Record<string, unknown>;
  const projectDir = typeof record['projectDir'] === 'string' ? record['projectDir'] : undefined;
  const repairs = strings(record['repairs'], 20);
  const raw = record['blueprint'];
  if (typeof raw !== 'object' || raw === null) {
    return { ...(projectDir ? { projectDir } : {}), repairs };
  }
  const blueprint = raw as Record<string, unknown>;
  const pieces = Array.isArray(blueprint['pieces']) ? blueprint['pieces'] : [];
  return {
    ...(projectDir ? { projectDir } : {}),
    repairs,
    plan: {
      projectName: String(blueprint['projectName'] ?? ''),
      summary: String(blueprint['summary'] ?? ''),
      stack: strings(blueprint['stack'], 20),
      decisions: strings(blueprint['decisions'], 20),
      additions: strings(blueprint['additions'], 20),
      risks: strings(blueprint['risks'], 20),
      pieces: pieces.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const piece = entry as Record<string, unknown>;
        return [
          {
            id: String(piece['id'] ?? ''),
            title: String(piece['title'] ?? ''),
            surface: String(piece['surface'] ?? ''),
            intent: String(piece['intent'] ?? ''),
            files: strings(piece['files'], 60),
            dependsOn: strings(piece['dependsOn'], 20),
          },
        ];
      }),
    },
  };
}

function pieceStateOf(task: MeshTaskDoc): RunPiece['state'] {
  if (task.state === 'completed') return 'done';
  if (task.state === 'failed') return 'failed';
  if (task.state === 'cancelled') return 'cancelled';
  if (task.state === 'pending') return 'queued';
  return 'running';
}

/**
 * Everything a goal page needs, from the queue alone.
 *
 * `planTask` is the supervisor; `children` are the `coder` tasks it queued.
 * `nodes` are only used to explain why something has not started, which is the
 * single most common question and the one a bare "queued" never answers.
 */
export function goalRun(
  planTask: MeshTaskDoc | undefined,
  children: MeshTaskDoc[],
  nodes: MeshNodeDoc[],
  now: number,
): GoalRun {
  const { plan, projectDir, repairs } = planOf(planTask);

  const pieces: RunPiece[] = children
    .map((task) => {
      const state = pieceStateOf(task);
      const coders = strings(task.result?.['coders'], 10);
      const finishedBy = typeof task.result?.['finishedBy'] === 'string' ? task.result['finishedBy'] : undefined;
      const waitingFor = state === 'queued' ? explainWait(task, nodes, now) : undefined;
      return {
        id: String(task.payload['pieceId'] ?? task._id),
        taskId: task._id,
        title: task.title,
        surface: String(task.payload['surface'] ?? ''),
        state,
        coders,
        files: strings(task.payload['scope'], 60),
        ...(finishedBy ? { finishedBy } : {}),
        ...(waitingFor ? { waitingFor } : {}),
        ...(task.error ? { error: task.error } : {}),
      };
    })
    // The order in the plan, so the page reads like the plan rather than like
    // whatever finished first.
    .sort((a, b) => orderOf(plan, a.id) - orderOf(plan, b.id));

  const total = plan?.pieces.length ?? pieces.length;
  const done = pieces.filter((piece) => piece.state === 'done').length;

  if (!planTask) {
    return {
      state: 'failed',
      headline: 'this goal has no work queued for it — it was never handed to the machines',
      pieces,
      done,
      total,
      repairs,
    };
  }
  if (planTask.state === 'completed') {
    const failed = pieces.filter((piece) => piece.state === 'failed');
    return {
      state: failed.length > 0 ? 'building' : 'completed',
      headline:
        failed.length > 0
          ? `${done} of ${total} pieces finished; ${failed.length} did not`
          : `finished — all ${total} pieces built`,
      ...(projectDir ? { projectDir } : {}),
      ...(plan ? { plan } : {}),
      pieces,
      done,
      total,
      repairs,
    };
  }
  if (planTask.state === 'failed' || planTask.state === 'cancelled') {
    return {
      state: 'failed',
      headline: planTask.error ?? `the plan was ${planTask.state}`,
      ...(projectDir ? { projectDir } : {}),
      ...(plan ? { plan } : {}),
      pieces,
      done,
      total,
      repairs,
    };
  }
  if (!plan) {
    const waiting = explainWait(planTask, nodes, now);
    return {
      state: waiting && !/queued, waiting/.test(waiting) ? 'waiting' : 'planning',
      headline: waiting ?? 'working out what this needs — backend, frontend, database, security, look and motion',
      ...(projectDir ? { projectDir } : {}),
      pieces,
      done,
      total,
      repairs,
    };
  }

  const running = pieces.filter((piece) => piece.state === 'running');
  const stuck = pieces.find((piece) => piece.waitingFor);
  return {
    state: running.length === 0 && stuck ? 'waiting' : 'building',
    headline:
      running.length > 0
        ? `${done}/${total} done · ${running.length} being written right now`
        : stuck
          ? (stuck.waitingFor ?? 'waiting')
          : `${done}/${total} done · working out what goes next`,
    ...(projectDir ? { projectDir } : {}),
    plan,
    pieces,
    done,
    total,
    repairs,
  };
}

function orderOf(plan: RunPlan | undefined, pieceId: string): number {
  const at = plan?.pieces.findIndex((piece) => piece.id === pieceId) ?? -1;
  return at < 0 ? Number.MAX_SAFE_INTEGER : at;
}

/** The goal row's status, kept in step with what the queue actually shows. */
export function statusFromRun(run: GoalRun): 'queued' | 'running' | 'completed' | 'failed' {
  if (run.state === 'completed') return 'completed';
  if (run.state === 'failed') return 'failed';
  if (run.state === 'waiting') return 'queued';
  return 'running';
}

/** Whether any machine could pick this up at all — asked before it is queued. */
export function machinesReady(nodes: MeshNodeDoc[], now: number): { ok: boolean; note?: string } {
  if (nodes.length === 0) {
    return {
      ok: false,
      note: 'No machine has joined yet. Run `megaai-node run` on the laptop with Claude Code, Codex or OpenCode on it — the goal will be waiting for it.',
    };
  }
  const shells = nodes.filter((node) => node.capabilities.includes('shell'));
  if (shells.length === 0) {
    return { ok: false, note: 'No machine here can run a shell, so no coding agent can be started.' };
  }
  if (!shells.some((node) => isOnline(node, now))) {
    return {
      ok: false,
      note: `${shells.map((node) => node.name).join(', ')} ${shells.length === 1 ? 'is' : 'are'} offline. The goal is queued and will start when one comes back.`,
    };
  }
  return { ok: true };
}
