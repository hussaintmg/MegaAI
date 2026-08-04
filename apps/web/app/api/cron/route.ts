/**
 * POST /api/cron — the scheduler tick, called by the GitHub Actions cron
 * workflow (executor token). Two jobs: reconcile goals whose runner died
 * without reporting, then turn every due, enabled schedule into a goal run.
 */

import { NextResponse } from 'next/server';
import { checkExecutor } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { goalsCollection, pushGoalEvent, type GoalDoc } from '@/lib/goals';
import { dispatchRunGoal } from '@/lib/github';

export async function POST(req: Request) {
  if (!checkExecutor(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const db = await getDb();
  const schedules = db.collection('schedules');
  const now = new Date();
  const goals = await goalsCollection();

  // Reconcile goals whose runner died without reporting: nothing else ever
  // moves them out of queued/dispatched/running, so without this sweep they
  // would show as "live" forever in the dashboard.
  const staleCutoff = new Date(now.getTime() - 90 * 60_000);
  const stale = await goals.updateMany(
    { status: { $in: ['queued', 'dispatched', 'running'] }, updatedAt: { $lte: staleCutoff } },
    {
      $set: {
        status: 'failed',
        error: 'No response from the GitHub Actions runner within 90 minutes — check the workflow run.',
        updatedAt: now,
      },
    },
  );

  const due = await schedules.find({ enabled: true, nextRunAt: { $lte: now } }).limit(10).toArray();
  let dispatched = 0;
  const errors: string[] = [];
  for (const schedule of due) {
    const doc: GoalDoc = {
      goal: String(schedule.goal),
      status: 'queued',
      source: 'schedule',
      createdBy: `schedule:${schedule.name}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      events: [{ at: new Date(), type: 'queued', message: `Scheduled run: ${schedule.name}` }],
    };
    const { insertedId } = await goals.insertOne(doc);
    try {
      await dispatchRunGoal(String(insertedId));
      await goals.updateOne({ _id: insertedId }, { $set: { status: 'dispatched', updatedAt: new Date() } });
      dispatched += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await goals.updateOne({ _id: insertedId }, { $set: { status: 'error', error: message, updatedAt: new Date() } });
      await pushGoalEvent(insertedId, 'error', `Dispatch failed: ${message}`);
      errors.push(message);
    }
    // Advance from *now* so a long outage doesn't cause a burst of catch-up runs.
    await schedules.updateOne(
      { _id: schedule._id },
      { $set: { lastRunAt: now, nextRunAt: new Date(Date.now() + Number(schedule.everyHours) * 3_600_000) } },
    );
  }
  return NextResponse.json({ due: due.length, dispatched, staleReconciled: stale.modifiedCount, errors });
}
