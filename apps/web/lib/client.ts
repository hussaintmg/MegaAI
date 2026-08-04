/**
 * Client-side fetch helper.
 *
 * Middleware only guards page navigations — an in-page fetch whose session has
 * expired just returns 401, which would otherwise leave stale data on screen
 * looking live. `apiGet` sends the user back to /login in that case and
 * surfaces every other failure instead of swallowing it.
 */

export class SessionExpired extends Error {
  constructor() {
    super('session expired');
    this.name = 'SessionExpired';
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (res.status === 401) {
    window.location.href = '/login';
    throw new SessionExpired();
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}
