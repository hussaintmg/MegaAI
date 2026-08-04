/**
 * GET /api/executor/goals/:id — the GitHub Actions runner picks up its job:
 * the goal text plus DECRYPTED provider keys/settings. Guarded by the
 * EXECUTOR_TOKEN shared secret; this is the only place keys leave the
 * database in plain form, over TLS, to the owner's own repository runner.
 */

import { NextResponse } from 'next/server';
import { checkExecutor } from '@/lib/auth';
import { goalsCollection, parseGoalId, pushGoalEvent } from '@/lib/goals';
import { executorSettings, loadSettingsDoc } from '@/lib/settings';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!checkExecutor(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  const objectId = parseGoalId(id);
  if (!objectId) return NextResponse.json({ error: 'invalid goal id' }, { status: 400 });

  const goals = await goalsCollection();
  const goal = await goals.findOne({ _id: objectId });
  if (!goal) return NextResponse.json({ error: 'goal not found' }, { status: 404 });

  await goals.updateOne({ _id: objectId }, { $set: { status: 'running', updatedAt: new Date() } });
  await pushGoalEvent(objectId, 'running', 'Runner picked up the goal');

  const settings = await loadSettingsDoc();
  return NextResponse.json({ goal: goal.goal, settings: executorSettings(settings) });
}
