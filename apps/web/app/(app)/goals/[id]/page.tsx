'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, SessionExpired } from '@/lib/client';
import type { GoalFile } from '@/lib/delivery';
import { buildPreview, isHtml } from '@/lib/preview';
import type { GoalRun } from '@/lib/goal-run';

interface GoalDetail {
  _id: string;
  goal: string;
  status: string;
  createdAt: string;
  events: Array<{ at: string; type: string; message: string }>;
  report?: string;
  files?: string[];
  contents?: GoalFile[];
  providers?: Array<{ kind: string; requests: number }>;
  deployment?: { url: string; target: string; simulated: boolean; inspectorUrl?: string; error?: string };
  usage?: { requests: number; tokens: number; costUsd: number };
  error?: string;
}

const ACTIVE = new Set(['queued', 'dispatched', 'running']);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function GoalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [goal, setGoal] = useState<GoalDetail | null>(null);
  const [run, setRun] = useState<GoalRun | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<'preview' | 'code'>('preview');
  const eventsRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ goal: GoalDetail; run?: GoalRun }>(`/api/goals/${id}`);
      setGoal(data.goal);
      setRun(data.run ?? null);
      setLoadError('');
    } catch (err) {
      if (err instanceof SessionExpired) return; // redirecting to /login
      const message = err instanceof Error ? err.message : 'could not load the goal';
      if (/not found|invalid goal id/i.test(message)) setNotFound(true);
      else setLoadError(message);
    }
  }, [id]);

  // Poll only while the run is live; a finished goal never changes again.
  const live = !goal || ACTIVE.has(goal.status);

  useEffect(() => {
    void load();
    if (!live) return;
    const timer = setInterval(() => {
      void load();
    }, 3000);
    return () => clearInterval(timer);
  }, [load, live]);

  useEffect(() => {
    const el = eventsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [goal?.events.length]);

  const contents = useMemo(() => goal?.contents ?? [], [goal?.contents]);

  // Open on the page the goal was about, not on .gitignore.
  useEffect(() => {
    if (selected || contents.length === 0) return;
    const entry =
      contents.find((f) => /(^|\/)index\.html?$/i.test(f.path)) ??
      contents.find((f) => isHtml(f.path)) ??
      contents.find((f) => f.path === 'README.md') ??
      contents[0];
    if (entry) setSelected(entry.path);
  }, [contents, selected]);

  const current = contents.find((f) => f.path === selected);
  const previewable = Boolean(current && isHtml(current.path) && current.text);
  // Screenshots app.preview took of the app while it was actually running.
  const shots = useMemo(() => contents.filter((f) => f.image), [contents]);

  async function retry() {
    setRetrying(true);
    try {
      const res = await fetch(`/api/goals/${id}/retry`, { method: 'POST' });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) setLoadError(data.error ?? 'retry failed');
      await load();
    } finally {
      setRetrying(false);
    }
  }

  function downloadCurrent() {
    if (!current?.text) return;
    const url = URL.createObjectURL(new Blob([current.text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = current.path.split('/').pop() ?? 'file.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (notFound) {
    return (
      <div className="panel">
        Goal not found. <Link href="/">Back to dashboard</Link>
      </div>
    );
  }
  if (!goal) {
    return loadError ? (
      <div className="panel">
        <div className="msg err" style={{ marginLeft: 0 }}>{loadError}</div>
        <div style={{ marginTop: 10 }}>
          <Link href="/">Back to dashboard</Link>
        </div>
      </div>
    ) : (
      <div className="panel muted">Loading…</div>
    );
  }

  const servedBy = goal.providers?.filter((p) => p.requests > 0) ?? [];
  const mockOnly = servedBy.length > 0 && servedBy.every((p) => p.kind === 'mock');

  return (
    <>
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{goal.goal}</h2>
          <span className={`chip ${goal.status}`}>{goal.status}</span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {new Date(goal.createdAt).toLocaleString()}
          {goal.usage &&
            ` · ${goal.usage.requests} AI requests · ${goal.usage.tokens} tokens · ~$${goal.usage.costUsd.toFixed(4)}`}
          {servedBy.length > 0 && ` · written by ${servedBy.map((p) => `${p.kind} ×${p.requests}`).join(', ')}`}
          {ACTIVE.has(goal.status) && ' · live'}
        </div>
        {mockOnly && (
          <div className="msg err" style={{ marginLeft: 0, marginTop: 8 }}>
            <b>Placeholder delivery.</b> Every request was answered by the built-in offline mock, so these files are
            generic scaffolding rather than the thing you asked for. Add a working API key under{' '}
            <Link href="/settings">Settings</Link> and run the goal again.
          </div>
        )}
        {goal.error && <div className="msg err" style={{ marginLeft: 0, marginTop: 8 }}>{goal.error}</div>}
        {loadError && <div className="msg err" style={{ marginLeft: 0, marginTop: 8 }}>{loadError}</div>}
        {!live && (
          <div className="row" style={{ marginTop: 10 }}>
            <button className="ghost small" onClick={retry} disabled={retrying}>
              {retrying ? 'Retrying…' : 'Run this goal again'}
            </button>
            {(goal.status === 'error' || goal.status === 'failed') && (
              <span className="muted" style={{ fontSize: 12 }}>
                Fix the cause first — Settings → Run setup check.
              </span>
            )}
          </div>
        )}
      </div>

      {run && (
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2 style={{ margin: 0 }}>{run.plan ? run.plan.projectName : 'Planning'}</h2>
            <span className="muted" style={{ fontSize: 12 }}>
              {run.done}/{run.total} pieces
            </span>
          </div>
          <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>{run.headline}</div>
          {run.projectDir && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              <code>{run.projectDir}</code>
            </div>
          )}

          {run.plan && (
            <>
              <p style={{ marginTop: 12, marginBottom: 6 }}>{run.plan.summary}</p>
              {run.plan.stack.length > 0 && (
                <div className="muted" style={{ fontSize: 12 }}>{run.plan.stack.join(' · ')}</div>
              )}
              {run.plan.additions.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <b style={{ fontSize: 13 }}>Added, because you would have wanted it</b>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
                    {run.plan.additions.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
              {run.plan.decisions.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <b style={{ fontSize: 13 }}>Decided for you</b>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
                    {run.plan.decisions.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
              {run.plan.risks.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <b style={{ fontSize: 13 }}>Watch out for</b>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
                    {run.plan.risks.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {run.pieces.length > 0 && (
            <table style={{ marginTop: 14 }}>
              <thead>
                <tr>
                  <th>Piece</th>
                  <th>State</th>
                  <th>Written by</th>
                </tr>
              </thead>
              <tbody>
                {run.pieces.map((piece) => (
                  <tr key={piece.taskId}>
                    <td>
                      {piece.surface && <span className="chip">{piece.surface}</span>}{' '}
                      {piece.title.split(' · ').slice(-1)[0]}
                      {piece.files.length > 0 && (
                        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                          {piece.files.slice(0, 4).join(', ')}
                          {piece.files.length > 4 && ` +${piece.files.length - 4}`}
                        </div>
                      )}
                      {piece.error && (
                        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{piece.error}</div>
                      )}
                    </td>
                    <td>
                      <span className={`chip ${piece.state}`}>{piece.state}</span>
                      {piece.waitingFor && (
                        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{piece.waitingFor}</div>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {piece.coders.length > 0 ? piece.coders.join(' → ') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {run.repairs.length > 0 && (
            <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
              The plan needed fixing before it could be used: {run.repairs.join('; ')}
            </div>
          )}
        </div>
      )}

      {goal.deployment && (
        <div className="panel live">
          {goal.deployment.simulated ? (
            <>
              <h2>Deployment was simulated</h2>
              <div className="muted" style={{ fontSize: 13 }}>
                <code>{goal.deployment.url}</code> does not exist — no Vercel token is saved, so the deploy step only
                described what it would do. Add one under <Link href="/settings">Settings → Deployment</Link> and run
                the goal again for a real link.
              </div>
            </>
          ) : (
            <>
              <h2>Live site</h2>
              <a className="live-url" href={goal.deployment.url} target="_blank" rel="noreferrer noopener">
                {goal.deployment.url} ↗
              </a>
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                Deployed to {goal.deployment.target}
                {goal.deployment.inspectorUrl && (
                  <>
                    {' · '}
                    <a href={goal.deployment.inspectorUrl} target="_blank" rel="noreferrer noopener">
                      build log
                    </a>
                  </>
                )}
              </div>
              {goal.deployment.error && (
                <div className="msg err" style={{ marginLeft: 0, marginTop: 8 }}>{goal.deployment.error}</div>
              )}
            </>
          )}
        </div>
      )}

      {shots.length > 0 && (
        <div className="panel">
          <h2>The running app</h2>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            Captured by <code>app.preview</code>: the delivery was installed, built, started, and each route loaded in
            a real browser.
          </div>
          <div className="shots">
            {shots.map((shot) => (
              <figure key={shot.path}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL, not a remote asset */}
                <img src={shot.image} alt={`Screenshot of ${shot.path}`} />
                <figcaption>{shot.path.replace('.megaai/preview/', '')}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Delivery{contents.length > 0 && ` · ${contents.length} files`}</h2>
          {contents.length > 0 && (
            <a className="chip" href={`/api/goals/${id}/download`} style={{ cursor: 'pointer' }}>
              ↓ Download all (.zip)
            </a>
          )}
        </div>

        {contents.length > 0 ? (
          <div className="delivery">
            <div className="filelist">
              {contents.map((file) => (
                <button
                  key={file.path}
                  className={file.path === selected ? 'on' : ''}
                  onClick={() => setSelected(file.path)}
                >
                  {file.path}
                  <span className="sz">{formatBytes(file.bytes)}</span>
                </button>
              ))}
            </div>
            <div className="viewer">
              <div className="bar">
                <span className="path">{current?.path ?? 'Pick a file'}</span>
                {previewable && (
                  <>
                    <button
                      className={mode === 'preview' ? 'small' : 'ghost small'}
                      onClick={() => setMode('preview')}
                    >
                      Preview
                    </button>
                    <button className={mode === 'code' ? 'small' : 'ghost small'} onClick={() => setMode('code')}>
                      Code
                    </button>
                  </>
                )}
                {current?.text && (
                  <button className="ghost small" onClick={downloadCurrent}>
                    ↓
                  </button>
                )}
              </div>
              {current?.image ? (
                // eslint-disable-next-line @next/next/no-img-element -- a data: URL, not a remote asset
                <img src={current.image} alt={current.path} style={{ display: 'block', width: '100%' }} />
              ) : current?.binary ? (
                <pre className="muted">Binary file — download the .zip to open it.</pre>
              ) : previewable && mode === 'preview' ? (
                // No allow-same-origin: model-written scripts run in an opaque
                // origin and cannot reach this page, its cookies, or its API.
                <iframe
                  title={`Preview of ${current?.path}`}
                  sandbox="allow-scripts"
                  srcDoc={current ? buildPreview(current, contents) : ''}
                />
              ) : (
                <pre>
                  {current?.text ?? 'Pick a file on the left.'}
                  {current?.truncated && '\n\n… truncated — download the .zip for the whole file.'}
                </pre>
              )}
            </div>
          </div>
        ) : goal.files && goal.files.length > 0 ? (
          <>
            <div className="events">
              {goal.files.map((file) => (
                <div key={file} className="muted">• {file}</div>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              This run finished before the platform started storing file contents. Run it again to browse and download
              the files here; the originals are still attached as an artifact on the GitHub Actions run.
            </div>
          </>
        ) : (
          <div className="muted">
            {ACTIVE.has(goal.status) ? 'Will appear when the run finishes.' : 'No files were delivered.'}
          </div>
        )}
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>Live events</h2>
          <div className="events" ref={eventsRef}>
            {goal.events.map((event, i) => (
              <div key={i}>
                <span className="t">{new Date(event.at).toLocaleTimeString()}</span>
                <span className="chip" style={{ marginRight: 8 }}>{event.type}</span>
                {event.message}
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h2>Delivery report</h2>
          {goal.report ? (
            <pre className="report" style={{ maxHeight: 420 }}>{goal.report}</pre>
          ) : (
            <div className="muted">No report yet.</div>
          )}
        </div>
      </div>
    </>
  );
}
