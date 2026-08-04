/**
 * Session + authorization helpers.
 *
 * - Users sign in with email/password (bcrypt hashes in MongoDB); a signed JWT
 *   lives in an httpOnly cookie. There is NO public signup and NO forgot-
 *   password flow by design: the first admin is seeded from ADMIN_EMAIL /
 *   ADMIN_PASSWORD, and only an admin adds users or resets passwords.
 * - Sessions are re-checked against the database on every use, so removing an
 *   account or resetting its password revokes existing cookies immediately
 *   rather than leaving them valid until the JWT expires. The token carries a
 *   `pv` (password version) fingerprint for exactly that.
 * - The GitHub Actions executor authenticates with a separate shared secret
 *   (EXECUTOR_TOKEN) — it never holds a user session.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { ObjectId } from 'mongodb';
import { SignJWT, jwtVerify } from 'jose';
import { getDb } from './db';
import { SESSION_COOKIE } from './constants';

export { SESSION_COOKIE };
const SESSION_DAYS = 7;

export interface Session {
  sub: string;
  email: string;
  role: 'admin' | 'member';
}

function authSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is not set');
  return new TextEncoder().encode(secret);
}

/** Short fingerprint of the stored password hash — changes on every reset. */
export function passwordVersion(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);
}

export async function createSessionToken(session: Session, passwordHash: string): Promise<string> {
  return new SignJWT({ email: session.email, role: session.role, pv: passwordVersion(passwordHash) })
    .setSubject(session.sub)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(authSecret());
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_DAYS * 24 * 60 * 60,
};

export async function getSession(): Promise<Session | null> {
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const { payload } = await jwtVerify(token, authSecret());
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;

    // The account must still exist with the same password — a removed user or
    // an admin password reset invalidates the cookie immediately.
    let objectId: ObjectId;
    try {
      objectId = new ObjectId(payload.sub);
    } catch {
      return null;
    }
    const db = await getDb();
    const user = await db.collection('users').findOne({ _id: objectId });
    if (!user) return null;
    if (payload.pv !== passwordVersion(String(user.passwordHash))) return null;

    return {
      sub: String(user._id),
      email: String(user.email),
      role: user.role === 'admin' ? 'admin' : 'member',
    };
  } catch {
    return null;
  }
}

export async function requireUser(): Promise<Session | null> {
  return getSession();
}

export async function requireAdmin(): Promise<Session | null> {
  const session = await getSession();
  return session?.role === 'admin' ? session : null;
}

/** Length-safe constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Constant-time check of the executor bearer token. */
export function checkExecutor(req: Request): boolean {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const expected = process.env.EXECUTOR_TOKEN ?? '';
  if (!token || !expected) return false;
  return safeEqual(token, expected);
}
