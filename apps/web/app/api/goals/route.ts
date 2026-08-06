/**
 * GET  /api/goals — recent goals.
 * POST /api/goals — hand a goal to the machines.
 *
 * A goal used to be dispatched to GitHub Actions, where MegaAI's own agents
 * wrote the code. It is not any more, for two reasons that turned out to be
 * the same reason: it needed a repository token and a workflow to be wired up
 * before anything could happen at all, and the code it produced was written by
 * a general-purpose model rather than by the coding agents that are actually
 * good at it and are already paid for.
 *
 * So a goal is now a `plan` task in the same queue the laptop watches. A model
 * plans it — properly, across backend, frontend, database, security, look and
 * motion — and then Claude Code, Codex and OpenCode write every line.
 */

import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { goalsCollection, pushGoalEvent, type GoalDoc } from '@/lib/goals';
import { buildGoalTask, type MeshNodeDoc, type MeshTaskDoc, type NewGoalRequest } from '@/lib/mesh-model.ts';
import { machinesReady } from '@/lib/goal-run';

export const dynamic = 'force-dynamic';

function newTaskId(): string {
  return `mtask_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export async function GET() {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const goals = await goalsCollection();
  const list = await goals
    .find({}, { projection: { events: 0, report: 0, contents: 0 } })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();
  return NextResponse.json({ goals: list });
}

export async function POST(req: Request) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: NewGoalRequest;
  try {
    body = (await req.json()) as NewGoalRequest;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const goals = await goalsCollection();
  const doc: GoalDoc = {
    goal: (body.goal ?? '').trim(),
    status: 'queued',
    source: 'dashboard',
    createdBy: session.email,
    createdAt: new Date(),
    updatedAt: new Date(),
    events: [],
  };

  const built = buildGoalTask(body, 'pending');
  if (!built.ok || !built.task) {
    return NextResponse.json({ error: built.error ?? 'that goal cannot be queued' }, { status: 400 });
  }

  const { insertedId } = await goals.insertOne({
    ...doc,
    events: [{ at: new Date(), type: 'queued', message: 'Goal accepted' }],
  });

  const db = await getDb();
  const task: MeshTaskDoc = {
    _id: newTaskId(),
    ...built.task,
    // Written now that the goal has an id, so every piece of work the plan
    // produces can be traced back to the sentence that asked for it.
    payload: { ...built.task.payload, goalId: String(insertedId) },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    rev: 1,
  };
  await db.collection<MeshTaskDoc>('mesh_tasks').insertOne(task);
  await goals.updateOne(
    { _id: insertedId },
    { $set: { status: 'dispatched', planTaskId: task._id, updatedAt: new Date() } },
  );

  // Said now rather than discovered on an empty page in ten minutes: with no
  // machine listening, a goal is a note in a queue and nothing more.
  const nodes = await db.collection<MeshNodeDoc>('mesh_nodes').find({}).toArray();
  const ready = machinesReady(nodes, Date.now());
  await pushGoalEvent(
    insertedId,
    'queued',
    ready.ok ? 'Handed to the machines — planning starts on the next round' : (ready.note ?? 'Queued'),
  );

  const saved = await goals.findOne({ _id: insertedId }, { projection: { events: 0 } });
  return NextResponse.json({ goal: saved, ...(ready.ok ? {} : { note: ready.note }) }, { status: 201 });
}
