/**
 * POST /api/executor/goals/:id/events — live progress + final result from the
 * GitHub Actions runner (executor token).
 *   { type: 'event', event: string, message: string }
 *   { type: 'final', status: 'completed'|'failed', report?, files?, usage?, error? }
 */

import { NextResponse } from 'next/server';
import { checkExecutor } from '@/lib/auth';
import { goalsCollection, parseGoalId, pushGoalEvent } from '@/lib/goals';
import { sanitizeGoalFiles, sanitizeProviderTallies } from '@/lib/delivery';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!checkExecutor(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  const objectId = parseGoalId(id);
  if (!objectId) return NextResponse.json({ error: 'invalid goal id' }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const goals = await goalsCollection();
  if (body.type === 'final') {
    const status = body.status === 'completed' ? 'completed' : 'failed';
    const update: Record<string, unknown> = { status, updatedAt: new Date() };
    if (typeof body.report === 'string') update.report = body.report.slice(0, 200_000);
    if (Array.isArray(body.files)) update.files = body.files.filter((f) => typeof f === 'string').slice(0, 300);
    if (Array.isArray(body.contents)) update.contents = sanitizeGoalFiles(body.contents);
    if (Array.isArray(body.providers)) update.providers = sanitizeProviderTallies(body.providers);
    if (body.usage && typeof body.usage === 'object') {
      const u = body.usage as Record<string, unknown>;
      update.usage = {
        requests: Number(u.requests) || 0,
        tokens: Number(u.tokens) || 0,
        costUsd: Number(u.costUsd) || 0,
      };
    }
    if (typeof body.error === 'string') update.error = body.error.slice(0, 2000);
    const result = await goals.updateOne({ _id: objectId }, { $set: update });
    if (result.matchedCount === 0) return NextResponse.json({ error: 'goal not found' }, { status: 404 });
    await pushGoalEvent(objectId, status, status === 'completed' ? 'Delivery completed' : 'Run failed');
    return NextResponse.json({ ok: true });
  }

  const eventType = typeof body.event === 'string' ? body.event.slice(0, 60) : 'event';
  const message = typeof body.message === 'string' ? body.message : '';
  if (!message) return NextResponse.json({ error: 'message is required' }, { status: 400 });
  await pushGoalEvent(objectId, eventType, message);
  return NextResponse.json({ ok: true });
}
