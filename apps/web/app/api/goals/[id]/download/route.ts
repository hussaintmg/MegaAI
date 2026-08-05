/**
 * GET /api/goals/:id/download — the delivery as a .zip.
 *
 * Everything is served as an attachment: the files are model-written HTML and
 * JavaScript, and handing them back with their own content-type would run them
 * on the dashboard's origin. The dashboard previews them in a sandboxed,
 * null-origin iframe instead.
 */

import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { goalsCollection, parseGoalId } from '@/lib/goals';
import { createZip, type ZipEntry } from '@/lib/zip';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  const objectId = parseGoalId(id);
  if (!objectId) return NextResponse.json({ error: 'invalid goal id' }, { status: 400 });

  const goals = await goalsCollection();
  const goal = await goals.findOne({ _id: objectId });
  if (!goal) return NextResponse.json({ error: 'goal not found' }, { status: 404 });

  const entries: ZipEntry[] = (goal.contents ?? [])
    .filter((file) => typeof file.text === 'string')
    .map((file) => ({ path: file.path, content: file.text ?? '' }));
  if (goal.report) entries.push({ path: 'MEGAAI_REPORT.md', content: goal.report });
  if (entries.length === 0) {
    return NextResponse.json({ error: 'this goal has no downloadable files' }, { status: 404 });
  }

  const slug = goal.goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'delivery';
  const zip = createZip(entries, goal.updatedAt);
  return new NextResponse(new Uint8Array(zip), {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(zip.length),
      'content-disposition': `attachment; filename="${slug}.zip"`,
      'cache-control': 'no-store',
    },
  });
}
