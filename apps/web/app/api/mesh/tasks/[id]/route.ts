/**
 * Taking one task off the queue.
 *
 * DELETE /api/mesh/tasks/<id>
 *
 * Allowed even while a machine is part-way through it: you are permitted to
 * change your mind about work you started, and the machine finds out when its
 * next lease renewal is rejected.
 */

import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import type { MeshTaskDoc } from '@/lib/mesh-model.ts';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireUser();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const db = await getDb();
  const tasks = db.collection<MeshTaskDoc>('mesh_tasks');
  const existing = await tasks.findOne({ _id: id });
  if (!existing) return Response.json({ error: 'no such task' }, { status: 404 });
  if (existing.state === 'completed') {
    return Response.json({ error: 'that one is already finished — there is nothing to cancel' }, { status: 400 });
  }

  await tasks.updateOne(
    { _id: id },
    {
      $set: { state: 'cancelled', error: 'cancelled from the dashboard', updatedAt: Date.now(), rev: existing.rev + 1 },
      // Left in place, these keep the task looking claimed by a machine that
      // has been told to stop caring about it.
      $unset: { claimedBy: '', leaseUntil: '', waitingFor: '', notBefore: '' },
    },
  );
  return Response.json({ cancelled: id });
}
