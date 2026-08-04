/**
 * GET  /api/goals — recent goals (without full event streams).
 * POST /api/goals — submit a goal: stored, then a GitHub Actions run is
 * dispatched to execute it with the full MegaAI engine.
 */

import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { goalsCollection, pushGoalEvent, type GoalDoc } from '@/lib/goals';
import { dispatchRunGoal } from '@/lib/github';

export async function GET() {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const goals = await goalsCollection();
  const list = await goals
    .find({}, { projection: { events: 0, report: 0 } })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();
  return NextResponse.json({ goals: list });
}

export async function POST(req: Request) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
  if (goal.length < 3 || goal.length > 2000) {
    return NextResponse.json({ error: 'goal must be 3–2000 characters' }, { status: 400 });
  }

  const goals = await goalsCollection();
  const doc: GoalDoc = {
    goal,
    status: 'queued',
    source: 'dashboard',
    createdBy: session.email,
    createdAt: new Date(),
    updatedAt: new Date(),
    events: [{ at: new Date(), type: 'queued', message: 'Goal accepted' }],
  };
  const { insertedId } = await goals.insertOne(doc);

  try {
    await dispatchRunGoal(String(insertedId));
    await goals.updateOne({ _id: insertedId }, { $set: { status: 'dispatched', updatedAt: new Date() } });
    await pushGoalEvent(insertedId, 'dispatched', 'GitHub Actions runner dispatched');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await goals.updateOne(
      { _id: insertedId },
      { $set: { status: 'error', error: message, updatedAt: new Date() } },
    );
    await pushGoalEvent(insertedId, 'error', `Dispatch failed: ${message}`);
  }

  const saved = await goals.findOne({ _id: insertedId }, { projection: { events: 0 } });
  return NextResponse.json({ goal: saved }, { status: 201 });
}
