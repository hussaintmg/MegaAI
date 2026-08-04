import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

function parseId(id: string): ObjectId | undefined {
  try {
    return new ObjectId(id);
  } catch {
    return undefined;
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const { id } = await params;
  const objectId = parseId(id);
  if (!objectId) return NextResponse.json({ error: 'invalid schedule id' }, { status: 400 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'body must include enabled: boolean' }, { status: 400 });
  }
  const db = await getDb();
  const result = await db.collection('schedules').updateOne({ _id: objectId }, { $set: { enabled: body.enabled } });
  if (result.matchedCount === 0) return NextResponse.json({ error: 'schedule not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const { id } = await params;
  const objectId = parseId(id);
  if (!objectId) return NextResponse.json({ error: 'invalid schedule id' }, { status: 400 });
  const db = await getDb();
  const result = await db.collection('schedules').deleteOne({ _id: objectId });
  if (result.deletedCount === 0) return NextResponse.json({ error: 'schedule not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
