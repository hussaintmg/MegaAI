/**
 * POST /api/goals/:id/retry — re-dispatch a goal that failed to start (or
 * failed on the runner). Useful after fixing a setup problem: the same goal
 * text runs again instead of having to retype it.
 */

import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { goalsCollection, parseGoalId, pushGoalEvent } from '@/lib/goals';
import { dispatchRunGoal } from '@/lib/github';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  const objectId = parseGoalId(id);
  if (!objectId) return NextResponse.json({ error: 'invalid goal id' }, { status: 400 });

  const goals = await goalsCollection();
  const goal = await goals.findOne({ _id: objectId });
  if (!goal) return NextResponse.json({ error: 'goal not found' }, { status: 404 });
  if (['queued', 'dispatched', 'running'].includes(goal.status)) {
    return NextResponse.json({ error: 'this goal is still running' }, { status: 409 });
  }

  await goals.updateOne(
    { _id: objectId },
    { $set: { status: 'queued', updatedAt: new Date() }, $unset: { error: '' } },
  );
  await pushGoalEvent(objectId, 'queued', `Retried by ${session.email}`);

  try {
    await dispatchRunGoal(String(objectId));
    await goals.updateOne({ _id: objectId }, { $set: { status: 'dispatched', updatedAt: new Date() } });
    await pushGoalEvent(objectId, 'dispatched', 'GitHub Actions runner dispatched');
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await goals.updateOne({ _id: objectId }, { $set: { status: 'error', error: message, updatedAt: new Date() } });
    await pushGoalEvent(objectId, 'error', `Dispatch failed: ${message}`);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
