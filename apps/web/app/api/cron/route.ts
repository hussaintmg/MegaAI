/**
 * POST /api/cron — the scheduler tick. Two jobs: turn every due schedule into
 * a goal, and tidy up goals that nothing is working on any more.
 *
 * The tidying used to fail anything that had not reported in 90 minutes, which
 * was right when a goal was one GitHub Actions run and wrong now that it is a
 * plan on your own machine. A goal legitimately waits far longer than that:
 * Claude Code's weekly limit resets on a Sunday, and the whole point of the
 * queue is that the work is still there when it does. So the rule is not "how
 * long has it been" — it is **is there still a task in the queue that could
 * move this**. If there is, it is waiting, not stuck, however long it takes.
 */

import { NextResponse } from 'next/server';
import { checkExecutor } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { goalsCollection, pushGoalEvent, type GoalDoc } from '@/lib/goals';
import { buildGoalTask, LIVE_TASK_STATES, type MeshTaskDoc } from '@/lib/mesh-model.ts';

export const dynamic = 'force-dynamic';

function newTaskId(): string {
  return `mtask_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export async function POST(req: Request) {
  if (!checkExecutor(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const db = await getDb();
  const schedules = db.collection('schedules');
  const tasks = db.collection<MeshTaskDoc>('mesh_tasks');
  const goals = await goalsCollection();
  const now = new Date();

  /* ---------- goals nothing is working on any more ---------- */

  // A day's grace before even looking: a goal queued for a machine that is
  // switched off overnight is fine, and saying otherwise every morning would
  // make the sweep something to ignore rather than read.
  const cutoff = new Date(now.getTime() - 24 * 3_600_000);
  const open = await goals
    .find({ status: { $in: ['queued', 'dispatched', 'running'] }, updatedAt: { $lte: cutoff } })
    .limit(100)
    .toArray();

  let abandoned = 0;
  for (const goal of open) {
    const live = await tasks.countDocuments({
      'payload.goalId': String(goal._id),
      state: { $in: LIVE_TASK_STATES },
    });
    if (live > 0) continue; // waiting on a machine or a quota — leave it alone
    await goals.updateOne(
      { _id: goal._id },
      {
        $set: {
          status: 'failed',
          error:
            'Nothing in the queue is working on this any more. Retry it, or check that a machine is running ' +
            '`megaai-node run` with a coding agent installed.',
          updatedAt: now,
        },
      },
    );
    abandoned += 1;
  }

  /* ---------- schedules that are due ---------- */

  const due = await schedules.find({ enabled: true, nextRunAt: { $lte: now } }).limit(10).toArray();
  let queued = 0;
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

    const built = buildGoalTask(
      { goal: doc.goal, ...(typeof schedule.projectDir === 'string' ? { projectDir: schedule.projectDir } : {}) },
      String(insertedId),
    );
    if (!built.ok || !built.task) {
      const message = built.error ?? 'this schedule cannot be queued';
      await goals.updateOne({ _id: insertedId }, { $set: { status: 'error', error: message, updatedAt: now } });
      await pushGoalEvent(insertedId, 'error', message);
      errors.push(message);
    } else {
      const task: MeshTaskDoc = {
        _id: newTaskId(),
        ...built.task,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        rev: 1,
      };
      await tasks.insertOne(task);
      await goals.updateOne(
        { _id: insertedId },
        { $set: { status: 'dispatched', planTaskId: task._id, updatedAt: now } },
      );
      queued += 1;
    }

    // Advance from *now* so a long outage does not cause a burst of catch-up runs.
    await schedules.updateOne(
      { _id: schedule._id },
      { $set: { lastRunAt: now, nextRunAt: new Date(Date.now() + Number(schedule.everyHours) * 3_600_000) } },
    );
  }

  return NextResponse.json({ due: due.length, queued, abandoned, errors });
}
