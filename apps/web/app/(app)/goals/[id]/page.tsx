'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, SessionExpired } from '@/lib/client';
import type { GoalFile } from '@/lib/delivery';
import { buildPreview, isHtml } from '@/lib/preview';

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
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<'preview' | 'code'>('preview');
  const eventsRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ goal: GoalDetail }>(`/api/goals/${id}`);
      setGoal(data.goal);
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
              {current?.binary ? (
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
