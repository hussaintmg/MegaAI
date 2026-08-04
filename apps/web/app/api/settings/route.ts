/**
 * GET  /api/settings — masked settings for the settings page.
 * POST /api/settings — save (admin only). Empty/masked keys keep the stored
 * value; new keys are encrypted before they reach MongoDB.
 */

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { loadSettingsDoc, mergeSettings, redactSettings, saveSettingsDoc } from '@/lib/settings';

// Admin-only both ways: even masked keys and the email transport config are
// operator secrets, so a member must not be able to read them.
export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const doc = await loadSettingsDoc();
  return NextResponse.json({ settings: redactSettings(doc) });
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
  const existing = await loadSettingsDoc();
  const merged = mergeSettings(existing, body);
  await saveSettingsDoc(merged);
  return NextResponse.json({ ok: true, settings: redactSettings(merged) });
}
