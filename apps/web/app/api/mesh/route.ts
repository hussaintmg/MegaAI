/**
 * What every machine is doing, and everything in the queue.
 *
 * GET /api/mesh — one snapshot.
 * GET /api/mesh?stream=1 — the same, pushed as Server-Sent Events.
 *
 * SSE rather than a WebSocket because Vercel's functions cannot hold a socket
 * open, and because EventSource reconnects on its own — a phone that locks its
 * screen picks the stream back up without any code of ours.
 */

import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { describeGear, describeHealth, explainWait, isOnline, type MeshNodeDoc, type MeshTaskDoc } from '@/lib/mesh-model.ts';

export const dynamic = 'force-dynamic';

/** How long a stream stays open before the browser is asked to reconnect. */
const STREAM_MS = 4 * 60_000;
const POLL_MS = 2_000;

async function snapshot(): Promise<Record<string, unknown>> {
  const db = await getDb();
  const now = Date.now();
  const [nodes, tasks] = await Promise.all([
    db.collection<MeshNodeDoc>('mesh_nodes').find({}).sort({ priority: -1 }).toArray(),
    db.collection<MeshTaskDoc>('mesh_tasks').find({}).sort({ createdAt: -1 }).limit(200).toArray(),
  ]);

  return {
    at: now,
    nodes: nodes.map((node) => ({
      id: node._id,
      name: node.name,
      kind: node.kind,
      capabilities: node.capabilities ?? [],
      gear: node.gear,
      gearMeans: describeGear(node.gear),
      concurrency: node.concurrency,
      online: isOnline(node, now),
      lastSeen: node.lastSeen,
      health: describeHealth(node),
      running: tasks.filter((task) => task.claimedBy === node._id && (task.state === 'claimed' || task.state === 'running')).length,
    })),
    tasks: tasks.map((task) => ({
      id: task._id,
      title: task.title,
      kind: typeof task.payload?.['kind'] === 'string' ? task.payload['kind'] : 'task',
      state: task.state,
      interactive: task.interactive === true,
      urgent: task.urgent === true,
      projectDir: typeof task.payload?.['projectDir'] === 'string' ? task.payload['projectDir'] : '',
      claimedBy: task.claimedBy ?? '',
      attempts: task.attempts,
      maxAttempts: task.maxAttempts,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      // Whatever the machine wrote when it parked this wins; the fallback only
      // covers tasks nothing has touched yet.
      waitingFor: explainWait(task, nodes, now),
      error: task.error ?? '',
      result: task.result ?? null,
    })),
  };
}

export async function GET(req: Request) {
  const session = await requireUser();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const wantsStream = new URL(req.url).searchParams.get('stream') === '1';
  if (!wantsStream) return Response.json(await snapshot());

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      let previous = '';
      const push = async () => {
        try {
          const body = JSON.stringify(await snapshot());
          // Only send when something actually changed. A dashboard left open
          // on a phone should not burn its battery redrawing the same thing
          // thirty times a minute.
          if (body === previous) return;
          previous = body;
          controller.enqueue(encoder.encode(`data: ${body}\n\n`));
        } catch (error) {
          controller.enqueue(
            encoder.encode(`event: problem\ndata: ${JSON.stringify({ message: (error as Error).message })}\n\n`),
          );
        }
      };

      await push();
      timer = setInterval(() => void push(), POLL_MS);
      closeTimer = setTimeout(() => {
        if (timer) clearInterval(timer);
        controller.close();
      }, STREAM_MS);
    },
    cancel() {
      if (timer) clearInterval(timer);
      if (closeTimer) clearTimeout(closeTimer);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Without this a proxy will happily buffer the whole stream and deliver
      // it when the connection closes, which is the opposite of live.
      'x-accel-buffering': 'no',
    },
  });
}
