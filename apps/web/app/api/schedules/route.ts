/**
 * Recurring goals. A GitHub Actions cron hits /api/cron periodically; due
 * schedules are turned into goal runs automatically.
 * GET  /api/schedules — list.
 * POST /api/schedules — { name?, goal, everyHours } (admin only).
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireAdmin, requireUser } from '@/lib/auth';

export async function GET() {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const db = await getDb();
  const schedules = await db.collection('schedules').find({}).sort({ createdAt: 1 }).toArray();
  return NextResponse.json({ schedules });
}

export async function POST(req: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
  const everyHours = typeof body.everyHours === 'number' ? body.everyHours : Number(body.everyHours);
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : goal.slice(0, 60);
  if (goal.length < 3) return NextResponse.json({ error: 'goal must be at least 3 characters' }, { status: 400 });
  if (!Number.isFinite(everyHours) || everyHours < 1 || everyHours > 24 * 30) {
    return NextResponse.json({ error: 'everyHours must be between 1 and 720' }, { status: 400 });
  }
  const db = await getDb();
  const now = Date.now();
  await db.collection('schedules').insertOne({
    name,
    goal,
    everyHours,
    enabled: true,
    nextRunAt: new Date(now + everyHours * 3_600_000),
    createdAt: new Date(now),
  });
  return NextResponse.json({ ok: true }, { status: 201 });
}
