/**
 * POST /api/goals/:id/retry — put a goal back in front of the machines.
 *
 * What it retries depends on where it stopped, which is the only useful
 * behaviour: a plan that failed is queued again from the sentence, while a
 * plan that finished with a piece or two failing re-queues *those pieces* —
 * with everything the other agents already built left alone. Re-planning a
 * project that is nine tenths finished would be the expensive wrong answer.
 */

import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { goalsCollection, parseGoalId, pushGoalEvent } from '@/lib/goals';
import { buildGoalTask, type MeshTaskDoc } from '@/lib/mesh-model.ts';

export const dynamic = 'force-dynamic';

function newTaskId(): string {
  return `mtask_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
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
  const mine = await tasks.find({ 'payload.goalId': id }).toArray();
  const now = Date.now();

  // The pieces that did not make it: back to pending, keeping their brief and
  // their checkpoint so whichever agent takes them continues rather than
  // starting the piece again.
  const stalled = mine.filter((task) => task.payload['kind'] === 'coder' && ['failed', 'cancelled'].includes(task.state));
  for (const task of stalled) {
    await tasks.updateOne(
      { _id: task._id },
      {
        $set: { state: 'pending', attempts: 0, updatedAt: now, rev: task.rev + 1 },
        $unset: { error: '', claimedBy: '', leaseUntil: '', notBefore: '', waitingFor: '' },
      },
    );
  }

  const planTask = mine.find((task) => task.payload['kind'] === 'plan');
  const planStalled = !planTask || ['failed', 'cancelled'].includes(planTask.state);

  if (planStalled) {
    // The supervisor is what hands work out, so it has to be alive again for
    // any re-queued piece to be followed up on.
    if (planTask) {
      await tasks.updateOne(
        { _id: planTask._id },
        {
          $set: { state: 'pending', attempts: 0, updatedAt: now, rev: planTask.rev + 1 },
          $unset: { error: '', claimedBy: '', leaseUntil: '', notBefore: '', waitingFor: '' },
        },
      );
    } else {
      const built = buildGoalTask({ goal: goal.goal }, id);
      if (!built.ok || !built.task) {
        return NextResponse.json({ error: built.error ?? 'this goal cannot be queued again' }, { status: 400 });
      }
      await tasks.insertOne({ _id: newTaskId(), ...built.task, createdAt: now, updatedAt: now, rev: 1 });
    }
  } else if (planTask.state === 'completed' && stalled.length > 0) {
    // Finished, but with holes in it. Waking the supervisor is what notices
    // the re-queued pieces and carries on from there.
    await tasks.updateOne(
      { _id: planTask._id },
      {
        $set: { state: 'pending', attempts: 0, updatedAt: now, rev: planTask.rev + 1 },
        $unset: { claimedBy: '', leaseUntil: '', notBefore: '', waitingFor: '' },
      },
    );
  } else if (stalled.length === 0) {
    return NextResponse.json({ error: 'nothing about this goal has failed — there is nothing to retry' }, { status: 409 });
  }

  await goals.updateOne(
    { _id: objectId },
    { $set: { status: 'queued', updatedAt: new Date() }, $unset: { error: '' } },
  );
  await pushGoalEvent(
    objectId,
    'queued',
    stalled.length > 0
      ? `Retried by ${session.email} — ${stalled.length} piece(s) queued again, the finished ones left alone`
      : `Retried by ${session.email}`,
  );

  return NextResponse.json({ ok: true, requeued: stalled.length });
}
