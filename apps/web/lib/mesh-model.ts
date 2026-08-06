/**
 * The queue, as the website sees it.
 *
 * The types here mirror `@megaai/mesh` deliberately rather than importing it.
 * Vercel builds `apps/web` on its own — it never runs the monorepo's `tsc -b`,
 * so a workspace import would resolve to a `dist/` that does not exist there
 * and the deploy would fail. The collections are the contract instead, and
 * this file names that so the duplication is a decision rather than a drift.
 *
 * Everything in here is pure: no database, so it can be tested.
 */

export type Gear = 'full' | 'background' | 'stop';
export type NodeKind = 'laptop' | 'phone' | 'cloud';
export type TaskState = 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled';

export const CAPABILITIES = [
  'shell',
  'browser',
  'gpu',
  'always-on',
  'sms',
  'whatsapp',
  'camera',
  'location',
  'email',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface MeshNodeDoc {
  _id: string;
  name: string;
  kind: NodeKind;
  capabilities: Capability[];
  priority: number;
  gear: Gear;
  concurrency: number;
  lastSeen: number;
  health?: { cpuLoad?: number; memUsedPct?: number; temperatureC?: number; batteryPct?: number; charging?: boolean };
}

export interface MeshTaskDoc {
  _id: string;
  title: string;
  payload: Record<string, unknown>;
  state: TaskState;
  requires: Capability[];
  interactive: boolean;
  urgent: boolean;
  priority: number;
  createdAt: number;
  updatedAt: number;
  rev: number;
  notBefore?: number;
  claimedBy?: string;
  leaseUntil?: number;
  attempts: number;
  maxAttempts: number;
  checkpoint?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  waitingFor?: string;
}

/** A node unheard from for this long is shown as offline. */
export const OFFLINE_AFTER_MS = 45_000;

export function isOnline(node: MeshNodeDoc, now: number): boolean {
  return now - node.lastSeen <= OFFLINE_AFTER_MS;
}

/* ------------------------------------------------------------------ *
 * What a task from the website may say
 * ------------------------------------------------------------------ */

/**
 * The kinds of work the queue knows how to route.
 *
 * `interactive` is the field that decides whether a task waits while you are
 * using the laptop, so it is set here from what the kind actually does rather
 * than left to whoever fills in the form.
 */
export const TASK_KINDS = [
  {
    kind: 'coder',
    label: 'Write code',
    hint: 'Hand it to Claude Code / Codex / OpenCode in a project folder.',
    requires: ['shell'] as Capability[],
    interactive: false,
    needsProject: true,
  },
  {
    kind: 'shell',
    label: 'Run a command',
    hint: 'A build, a test run, a script. Nothing on screen.',
    requires: ['shell'] as Capability[],
    interactive: false,
    needsProject: true,
  },
  {
    kind: 'desktop',
    label: 'Use the screen',
    hint: 'Open an app and drive it with the mouse and keyboard. Waits until you step away.',
    requires: ['shell', 'browser'] as Capability[],
    interactive: true,
    needsProject: false,
  },
  {
    kind: 'whatsapp',
    label: 'Send a WhatsApp',
    hint: 'Through Chrome on the laptop, or the phone.',
    requires: ['whatsapp'] as Capability[],
    interactive: true,
    needsProject: false,
  },
  {
    kind: 'email',
    label: 'Send an email',
    hint: 'Anything always-on can do this.',
    requires: ['email'] as Capability[],
    interactive: false,
    needsProject: false,
  },
] as const;

export type TaskKind = (typeof TASK_KINDS)[number]['kind'];

export interface NewTaskRequest {
  kind: string;
  title: string;
  goal?: string;
  projectDir?: string;
  notes?: string;
  urgent?: boolean;
}

export interface BuiltTask {
  ok: boolean;
  error?: string;
  task?: Omit<MeshTaskDoc, '_id' | 'createdAt' | 'updatedAt' | 'rev'>;
}

/**
 * Turn what the form sent into a task, or say why it cannot be one.
 *
 * Refusing here matters more than it looks: a coder task without a folder gets
 * as far as a machine before failing, having spent a claim and an attempt on
 * the way, and the person who typed it has walked away by then.
 */
export function buildTask(input: NewTaskRequest): BuiltTask {
  const spec = TASK_KINDS.find((entry) => entry.kind === input.kind);
  if (!spec) {
    return { ok: false, error: `"${input.kind}" is not a kind of task this queue knows about` };
  }
  const title = (input.title ?? '').trim();
  if (!title) return { ok: false, error: 'a task needs a description of what to do' };

  const projectDir = (input.projectDir ?? '').trim();
  if (spec.needsProject && !projectDir) {
    return { ok: false, error: `"${spec.label}" needs a project folder on the machine that will run it` };
  }
  if (projectDir && !/^([a-zA-Z]:[\\/]|\/)/.test(projectDir)) {
    // The same mangling that bit us on the command line: a relative path gets
    // resolved against wherever the agent happens to be running.
    return {
      ok: false,
      error: `"${projectDir}" is not a full path. Use something like C:/projects/velocity or /home/me/projects/velocity.`,
    };
  }

  const payload: Record<string, unknown> = {
    kind: spec.kind,
    task: title,
    goal: (input.goal ?? '').trim() || title,
    ...(projectDir ? { projectDir } : {}),
    ...(input.notes?.trim() ? { notes: [input.notes.trim()] } : {}),
  };

  return {
    ok: true,
    task: {
      title: title.slice(0, 300),
      payload,
      state: 'pending',
      requires: [...spec.requires],
      interactive: spec.interactive,
      urgent: input.urgent === true,
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Saying what is going on
 * ------------------------------------------------------------------ */

/**
 * Why a pending task has not started.
 *
 * The agent writes `waitingFor` when it parks something, and that sentence is
 * always the truest answer. This fills the gap for tasks nothing has touched
 * yet, where the reason lives in the state of the machines rather than on the
 * task.
 */
export function explainWait(task: MeshTaskDoc, nodes: MeshNodeDoc[], now: number): string | undefined {
  if (task.state !== 'pending') return undefined;
  if ((task.notBefore ?? 0) > now) {
    const seconds = Math.ceil(((task.notBefore ?? now) - now) / 1000);
    const when = seconds > 90 ? `${Math.round(seconds / 60)} min` : `${seconds}s`;
    return task.waitingFor ? `${task.waitingFor} (in ${when})` : `retrying in ${when}`;
  }
  if (nodes.length === 0) {
    return 'no machine has joined the queue yet — start the agent on the machine that should do this work';
  }
  const capable = nodes.filter((node) => task.requires.every((need) => node.capabilities.includes(need)));
  if (capable.length === 0) {
    return `no machine can run this — it needs ${task.requires.join(', ')}`;
  }
  const online = capable.filter((node) => isOnline(node, now));
  if (online.length === 0) {
    return `waiting for ${capable.map((node) => node.name).join(', ')} to come online`;
  }
  if (online.every((node) => node.gear === 'stop')) {
    return `every capable machine is paused (${online.map((node) => node.name).join(', ')})`;
  }
  if (task.interactive && !task.urgent && online.every((node) => node.gear === 'background')) {
    return 'needs the mouse and screen, so it waits until you step away from the machine';
  }
  return 'queued, waiting for a free slot';
}

/** What the machine is doing, in one line, for a phone-sized screen. */
export function describeHealth(node: MeshNodeDoc): string {
  const health = node.health ?? {};
  const parts: string[] = [];
  if (health.cpuLoad !== undefined) parts.push(`cpu ${Math.round(health.cpuLoad * 100)}%`);
  if (health.memUsedPct !== undefined) parts.push(`mem ${Math.round(health.memUsedPct * 100)}%`);
  if (health.temperatureC !== undefined) parts.push(`${Math.round(health.temperatureC)}°C`);
  if (health.batteryPct !== undefined) {
    parts.push(`battery ${Math.round(health.batteryPct)}%${health.charging === false ? ' (unplugged)' : ''}`);
  }
  return parts.join(' · ');
}

/** Plain words for what a gear means, since the word alone is not obvious. */
export function describeGear(gear: Gear): string {
  if (gear === 'full') return 'running everything';
  if (gear === 'background') return 'in use — background work only';
  return 'paused';
}
