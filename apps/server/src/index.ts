/**
 * MegaAI API server — REST + Server-Sent Events + the live dashboard.
 *
 *   node apps/server/dist/index.js          (default http://127.0.0.1:4100)
 *
 * Endpoints:
 *   GET  /                     dashboard
 *   GET  /api/overview         everything the dashboard shows
 *   GET  /api/projects         projects with progress
 *   GET  /api/projects/:id     one project + its tasks
 *   GET  /api/events           recent event history
 *   GET  /api/stream           live events (SSE)
 *   GET  /api/logs             recent log entries
 *   GET  /api/health           service health reports
 *   POST /api/goals            { goal } — start a new goal (async)
 *   POST /api/approvals/:id    { approved } — resolve a pending approval
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import process from 'node:process';
import { createMegaAI } from '@megaai/sdk';
import { DASHBOARD_HTML } from './dashboard.js';

const megaai = createMegaAI();

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
    return;
  }

  if (method === 'GET' && path === '/api/overview') {
    json(res, 200, await megaai.orchestrator.overview());
    return;
  }

  if (method === 'GET' && path === '/api/projects') {
    const projects = await megaai.planning.listProjects();
    json(res, 200, projects);
    return;
  }

  const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if (method === 'GET' && projectMatch) {
    const id = projectMatch[1] as string;
    const project = await megaai.planning.getProject(id);
    if (!project) {
      json(res, 404, { error: 'project not found' });
      return;
    }
    json(res, 200, { project, tasks: await megaai.planning.tasksOf(id) });
    return;
  }

  if (method === 'GET' && path === '/api/events') {
    const limit = Number(url.searchParams.get('limit') ?? 100);
    json(res, 200, megaai.bus.history(undefined, Number.isFinite(limit) ? limit : 100));
    return;
  }

  if (method === 'GET' && path === '/api/logs') {
    json(res, 200, megaai.logBuffer.entries.slice(-200));
    return;
  }

  if (method === 'GET' && path === '/api/notifications') {
    const channel = megaai.comm.get('captured');
    const messages = channel && 'messages' in channel ? (channel as { messages: unknown[] }).messages : [];
    json(res, 200, messages.slice(-50).reverse());
    return;
  }

  if (method === 'GET' && path === '/api/health') {
    json(res, 200, await megaai.container.healthAll());
    return;
  }

  if (method === 'GET' && path === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const subscription = megaai.bus.on('*', (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      subscription.unsubscribe();
    });
    return;
  }

  if (method === 'POST' && path === '/api/goals') {
    const body = await readBody(req);
    const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
    if (goal.length < 3) {
      json(res, 400, { error: 'body must be { "goal": "…" }' });
      return;
    }
    // Long-running: kick off in the background; the dashboard follows along
    // via /api/overview and /api/stream. Approval gates pause it until a
    // human resolves them (unless autoApprove is on).
    megaai
      .submitGoal(goal)
      .then((result) =>
        megaai.logger.info('goal finished', { project: result.project.name, status: result.project.status }),
      )
      .catch((err) => megaai.logger.error('goal crashed', { error: String(err) }));
    json(res, 202, { accepted: true, goal });
    return;
  }

  const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)$/);
  if (method === 'POST' && approvalMatch) {
    const body = await readBody(req);
    try {
      megaai.orchestrator.approve(approvalMatch[1] as string, body.approved === true, 'dashboard');
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 404, { error: String(err) });
    }
    return;
  }

  json(res, 404, { error: `no route for ${method} ${path}` });
}

async function main(): Promise<void> {
  await megaai.start();
  const { host, port } = megaai.config.server;
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      megaai.logger.error('request failed', { url: req.url ?? '', error: String(err) });
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
  server.listen(port, host, () => {
    megaai.logger.info(`dashboard ready`, { url: `http://${host}:${port}` });
  });

  const shutdown = async () => {
    server.close();
    await megaai.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
