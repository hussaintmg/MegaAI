'use client';

/**
 * Your machines and the queue they share, live.
 *
 * Built to be read on a phone first: this is the screen you look at when you
 * are away from the laptop and want to know whether the night is going well,
 * and the screen you give work from when the laptop is the thing that should
 * do it.
 */

import { useCallback, useEffect, useState } from 'react';
import { SessionExpired } from '@/lib/client';
import { TASK_KINDS } from '@/lib/mesh-model.ts';

interface NodeView {
  id: string;
  name: string;
  kind: string;
  capabilities: string[];
  gear: string;
  gearMeans: string;
  concurrency: number;
  online: boolean;
  lastSeen: number;
  health: string;
  running: number;
}

interface TaskView {
  id: string;
  title: string;
  kind: string;
  state: string;
  interactive: boolean;
  urgent: boolean;
  projectDir: string;
  claimedBy: string;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  waitingFor?: string;
  error: string;
  result: Record<string, unknown> | null;
}

interface Snapshot {
  at: number;
  nodes: NodeView[];
  tasks: TaskView[];
}

const STATE_ORDER: Record<string, number> = { running: 0, claimed: 1, pending: 2, failed: 3, completed: 4, cancelled: 5 };

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export default function MachinesPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [live, setLive] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [kind, setKind] = useState<string>('coder');
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [projectDir, setProjectDir] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const spec = TASK_KINDS.find((entry) => entry.kind === kind);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/mesh');
      if (res.status === 401) throw new SessionExpired();
      setSnapshot((await res.json()) as Snapshot);
      setLoadError('');
    } catch (err) {
      if (err instanceof SessionExpired) {
        window.location.href = '/login';
        return;
      }
      setLoadError(err instanceof Error ? err.message : 'could not read the queue');
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The stream closes itself every few minutes; EventSource reconnects on
    // its own, which is exactly what a phone that locked its screen needs.
    const source = new EventSource('/api/mesh?stream=1');
    source.onmessage = (event) => {
      setSnapshot(JSON.parse(event.data as string) as Snapshot);
      setLive(true);
    };
    source.onerror = () => setLive(false);
    return () => source.close();
  }, [refresh]);

  async function queue(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/mesh/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, title, goal, projectDir, urgent }),
      });
      const data = (await res.json()) as { error?: string; note?: string };
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'could not queue that' });
      } else {
        setMessage({ ok: true, text: data.note ?? 'Queued. The next free machine will pick it up.' });
        setTitle('');
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    await fetch(`/api/mesh/tasks/${id}`, { method: 'DELETE' });
    await refresh();
  }

  const now = snapshot?.at ?? Date.now();
  const tasks = [...(snapshot?.tasks ?? [])].sort(
    (a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || b.updatedAt - a.updatedAt,
  );

  return (
    <>
      <div className="page-head">
        <h1>Machines</h1>
        <span className={`livedot ${live ? 'on' : 'off'}`}>{live ? 'live' : 'reconnecting…'}</span>
      </div>
      {loadError && <div className="panel error">{loadError}</div>}

      <section className="panel">
        <h2>Who is working</h2>
        {(snapshot?.nodes.length ?? 0) === 0 ? (
          <p className="muted">
            No machine has joined yet. Run <code>megaai-node run</code> on the laptop and it will appear here.
          </p>
        ) : (
          <div className="nodegrid">
            {snapshot?.nodes.map((node) => (
              <div key={node.id} className={`nodecard ${node.online ? '' : 'offline'}`}>
                <div className="nodecard-top">
                  <strong>{node.name}</strong>
                  <span className={`pill ${node.online ? `gear-${node.gear}` : 'gear-off'}`}>
                    {node.online ? node.gear : 'offline'}
                  </span>
                </div>
                <div className="muted">{node.online ? node.gearMeans : `last seen ${ago(node.lastSeen, now)}`}</div>
                {node.health && <div className="muted mono">{node.health}</div>}
                <div className="muted">
                  {node.running} of {node.concurrency} running · {node.capabilities.join(', ')}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Give it something to do</h2>
        <form onSubmit={queue}>
          <label>What kind of work</label>
          <div className="kindrow">
            {TASK_KINDS.map((entry) => (
              <button
                type="button"
                key={entry.kind}
                className={`kindbtn ${kind === entry.kind ? 'on' : ''}`}
                onClick={() => setKind(entry.kind)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          {spec && <div className="muted" style={{ marginTop: 6 }}>{spec.hint}</div>}

          <label>What to do</label>
          <textarea
            rows={3}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Add the scroll animations to the hero and verify the build passes"
          />

          <label>The bigger goal (carried into every handoff)</label>
          <input
            type="text"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="A 3D marketing site for the Velocity electric sports car"
          />

          {spec?.needsProject && (
            <>
              <label>Project folder on the machine</label>
              <input
                type="text"
                value={projectDir}
                onChange={(event) => setProjectDir(event.target.value)}
                placeholder="C:/Automation/projects/velocity"
              />
            </>
          )}

          {spec?.interactive && (
            <label className="checkrow">
              <input type="checkbox" checked={urgent} onChange={(event) => setUrgent(event.target.checked)} />
              <span>Do it now, even if I am using the machine</span>
            </label>
          )}

          <button type="submit" disabled={busy || !title.trim()}>
            {busy ? 'Queueing…' : 'Queue it'}
          </button>
          {message && <div className={message.ok ? 'ok' : 'error'} style={{ marginTop: 10 }}>{message.text}</div>}
        </form>
      </section>

      <section className="panel">
        <h2>The queue</h2>
        {tasks.length === 0 ? (
          <p className="muted">Nothing queued.</p>
        ) : (
          tasks.map((task) => (
            <div key={task.id} className={`taskrow state-${task.state}`}>
              <div className="taskrow-main">
                <div>
                  <span className={`pill state-${task.state}`}>{task.state}</span>{' '}
                  <strong>{task.title}</strong>
                </div>
                <div className="muted">
                  {task.kind}
                  {task.interactive ? ' · needs the screen' : ''}
                  {task.projectDir ? ` · ${task.projectDir}` : ''}
                  {task.claimedBy ? ` · on ${task.claimedBy}` : ''}
                  {task.attempts > 1 ? ` · attempt ${task.attempts} of ${task.maxAttempts}` : ''}
                  {` · ${ago(task.updatedAt, now)}`}
                </div>
                {task.waitingFor && <div className="waiting">{task.waitingFor}</div>}
                {task.error && task.state !== 'cancelled' && <div className="error-line">{task.error}</div>}
                {task.result?.['finishedBy'] !== undefined && (
                  <div className="muted">
                    finished by {String(task.result['finishedBy'])}
                    {Number(task.result['handoffs']) > 0 ? ` after ${String(task.result['handoffs'])} handoff(s)` : ''}
                  </div>
                )}
              </div>
              {task.state !== 'completed' && task.state !== 'cancelled' && (
                <button type="button" className="ghost" onClick={() => void cancel(task.id)}>
                  cancel
                </button>
              )}
            </div>
          ))
        )}
      </section>
    </>
  );
}
