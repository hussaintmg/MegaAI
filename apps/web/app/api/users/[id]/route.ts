/**
 * PATCH  /api/users/:id — reset an account's password (admin only; this is
 *                          the "forgot password" path — the admin sets a new one).
 * DELETE /api/users/:id — remove an account (admin only; cannot remove
 *                          yourself or the last admin).
 */

import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import bcrypt from 'bcryptjs';
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
  if (!objectId) return NextResponse.json({ error: 'invalid user id' }, { status: 400 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 8) {
    return NextResponse.json({ error: 'password must be at least 8 characters' }, { status: 400 });
  }
  const db = await getDb();
  const result = await db
    .collection('users')
    .updateOne({ _id: objectId }, { $set: { passwordHash: await bcrypt.hash(password, 10) } });
  if (result.matchedCount === 0) return NextResponse.json({ error: 'user not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const { id } = await params;
  const objectId = parseId(id);
  if (!objectId) return NextResponse.json({ error: 'invalid user id' }, { status: 400 });
  if (String(objectId) === session.sub) {
    return NextResponse.json({ error: 'you cannot remove your own account' }, { status: 400 });
  }
  const db = await getDb();
  const users = db.collection('users');
  const target = await users.findOne({ _id: objectId });
  if (!target) return NextResponse.json({ error: 'user not found' }, { status: 404 });
  if (target.role === 'admin' && (await users.countDocuments({ role: 'admin' })) <= 1) {
    return NextResponse.json({ error: 'cannot remove the last admin' }, { status: 400 });
  }
  await users.deleteOne({ _id: objectId });
  return NextResponse.json({ ok: true });
}
