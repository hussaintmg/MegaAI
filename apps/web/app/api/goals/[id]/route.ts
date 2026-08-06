/**
 * GET /api/goals/:id — the goal, and what the machines are doing about it.
 *
 * The live part is derived from the queue rather than stored on the goal, so
 * there is only one source of truth about what is happening. The goal row's
 * `status` is refreshed from it on the way past, which is what keeps the list
 * on the front page honest without a second writer.
 */

import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { goalsCollection, parseGoalId } from '@/lib/goals';
import { goalRun, statusFromRun } from '@/lib/goal-run';
import type { MeshNodeDoc, MeshTaskDoc } from '@/lib/mesh-model.ts';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  const objectId = parseGoalId(id);
  if (!objectId) return NextResponse.json({ error: 'invalid goal id' }, { status: 400 });

  const goals = await goalsCollection();
  const goal = await goals.findOne({ _id: objectId });
  if (!goal) return NextResponse.json({ error: 'goal not found' }, { status: 404 });

  const db = await getDb();
  const tasks = db.collection<MeshTaskDoc>('mesh_tasks');
  const all = await tasks.find({ 'payload.goalId': id }).toArray();
  const planTask = all.find((task) => task.payload['kind'] === 'plan');
  const children = all.filter((task) => task.payload['kind'] === 'coder');
  const nodes = await db.collection<MeshNodeDoc>('mesh_nodes').find({}).toArray();

  const run = goalRun(planTask, children, nodes, Date.now());
  const status = statusFromRun(run);
  if (status !== goal.status) {
    await goals.updateOne({ _id: objectId }, { $set: { status, updatedAt: new Date() } });
    goal.status = status;
  }

  return NextResponse.json({ goal, run });
}
