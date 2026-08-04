/**
 * Session + authorization helpers.
 *
 * - Users sign in with email/password (bcrypt hashes in MongoDB); a signed JWT
 *   lives in an httpOnly cookie. There is NO public signup and NO forgot-
 *   password flow by design: the first admin is seeded from ADMIN_EMAIL /
 *   ADMIN_PASSWORD, and only an admin adds users or resets passwords.
 * - The GitHub Actions executor authenticates with a separate shared secret
 *   (EXECUTOR_TOKEN) — it never holds a user session.
 */

import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
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

export async function createSessionToken(session: Session): Promise<string> {
  return new SignJWT({ email: session.email, role: session.role })
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
    return {
      sub: payload.sub,
      email: payload.email,
      role: payload.role === 'admin' ? 'admin' : 'member',
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

/** Constant-time check of the executor bearer token. */
export function checkExecutor(req: Request): boolean {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const expected = process.env.EXECUTOR_TOKEN ?? '';
  if (!token || !expected) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
