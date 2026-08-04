/**
 * Admin-managed access — there is no public signup.
 * GET  /api/users — list accounts (admin only).
 * POST /api/users — add an account with a password the admin sets.
 */

import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const db = await getDb();
  const users = await db
    .collection('users')
    .find({}, { projection: { passwordHash: 0 } })
    .sort({ createdAt: 1 })
    .toArray();
  return NextResponse.json({ users });
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
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  const role = body.role === 'admin' ? 'admin' : 'member';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'a valid email is required' }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'password must be at least 8 characters' }, { status: 400 });
  }
  const db = await getDb();
  const users = db.collection('users');
  if (await users.findOne({ email })) {
    return NextResponse.json({ error: 'an account with this email already exists' }, { status: 409 });
  }
  await users.insertOne({
    email,
    name: name || email.split('@')[0],
    passwordHash: await bcrypt.hash(password, 10),
    role,
    createdAt: new Date(),
  });
  return NextResponse.json({ ok: true }, { status: 201 });
}
