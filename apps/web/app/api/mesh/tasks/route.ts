/**
 * Giving the machines work from the website — or from a phone.
 *
 * POST /api/mesh/tasks — { kind, title, goal?, projectDir?, notes?, urgent? }
 *
 * The task lands in the same queue the laptop agent watches, so "tell it from
 * my phone and have the laptop do it" needs nothing else: the laptop is
 * already looking at this collection.
 */

import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { buildTask, type MeshTaskDoc, type NewTaskRequest } from '@/lib/mesh-model.ts';

export const dynamic = 'force-dynamic';

function newTaskId(): string {
  return `mtask_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export async function POST(req: Request) {
  const session = await requireUser();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let body: NewTaskRequest;
  try {
    body = (await req.json()) as NewTaskRequest;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const built = buildTask(body);
  if (!built.ok || !built.task) {
    return Response.json({ error: built.error ?? 'that task cannot be queued' }, { status: 400 });
  }

  const now = Date.now();
  const doc: MeshTaskDoc = { _id: newTaskId(), ...built.task, createdAt: now, updatedAt: now, rev: 1 };
  const db = await getDb();
  await db.collection<MeshTaskDoc>('mesh_tasks').insertOne(doc);

  return Response.json({
    task: { id: doc._id, title: doc.title, interactive: doc.interactive },
    // Said now rather than discovered later: an interactive task queued while
    // you are at the laptop will sit there until you walk away, and that looks
    // like nothing happening unless it is spelled out.
    note: doc.interactive && !doc.urgent
      ? 'This one needs the mouse and screen, so it waits until you step away from the machine.'
      : undefined,
  });
}
