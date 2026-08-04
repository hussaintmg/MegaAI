/**
 * POST /api/auth/login — email + password sign-in.
 *
 * No public signup: if the users collection is EMPTY and the credentials match
 * ADMIN_EMAIL / ADMIN_PASSWORD, the first admin account is created on the
 * spot. After that, only accounts an admin added can sign in.
 *
 * Both the seed comparison and the failure path are constant-time-ish: the
 * admin secret is compared with timingSafeEqual, and a wrong email still pays
 * one bcrypt round so response timing does not reveal which emails exist.
 */

import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getDb } from '@/lib/db';
import { createSessionToken, safeEqual, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth';

interface UserDoc {
  email: string;
  name?: string;
  passwordHash: string;
  role: 'admin' | 'member';
  createdAt: Date;
}

// A real cost-10 hash, compared against when no account matches so the
// bcrypt work happens either way (no account-enumeration timing signal).
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) {
    return NextResponse.json({ error: 'email and password are required' }, { status: 400 });
  }

  const db = await getDb();
  const users = db.collection<UserDoc>('users');

  // First-run: seed the admin account from environment credentials.
  if ((await users.countDocuments()) === 0) {
    const adminEmail = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
    const adminPassword = process.env.ADMIN_PASSWORD ?? '';
    if (adminEmail && adminPassword && safeEqual(email, adminEmail) && safeEqual(password, adminPassword)) {
      try {
        await users.insertOne({
          email: adminEmail,
          name: 'Admin',
          passwordHash: await bcrypt.hash(adminPassword, 10),
          role: 'admin',
          createdAt: new Date(),
        });
      } catch {
        // A concurrent request won the race and created it — the unique index
        // on users.email rejected this one. Fall through and sign in normally.
      }
    }
  }

  const user = await users.findOne({ email });
  const matches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !matches) {
    return NextResponse.json({ error: 'invalid email or password' }, { status: 401 });
  }

  const token = await createSessionToken(
    { sub: String(user._id), email: user.email, role: user.role },
    user.passwordHash,
  );
  const res = NextResponse.json({ ok: true, user: { email: user.email, role: user.role } });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
  return res;
}
