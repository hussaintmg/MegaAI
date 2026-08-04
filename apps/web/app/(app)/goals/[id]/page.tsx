'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, SessionExpired } from '@/lib/client';

interface GoalDetail {
  _id: string;
  goal: string;
  status: string;
  createdAt: string;
  events: Array<{ at: string; type: string; message: string }>;
  report?: string;
  files?: string[];
  usage?: { requests: number; tokens: number; costUsd: number };
  error?: string;
}

const ACTIVE = new Set(['queued', 'dispatched', 'running']);

export default function GoalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [goal, setGoal] = useState<GoalDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [retrying, setRetrying] = useState(false);
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
          {ACTIVE.has(goal.status) && ' · live'}
        </div>
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
          <h2>Delivery files</h2>
          {goal.files && goal.files.length > 0 ? (
            <div className="events">
              {goal.files.map((file) => (
                <div key={file} className="muted">• {file}</div>
              ))}
            </div>
          ) : (
            <div className="muted">
              {ACTIVE.has(goal.status) ? 'Will appear when the run finishes.' : 'No files recorded.'}
            </div>
          )}
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            Full workspace is attached as an artifact on the GitHub Actions run.
          </div>
        </div>
      </div>

      {goal.report && (
        <div className="panel">
          <h2>Delivery report</h2>
          <pre className="report">{goal.report}</pre>
        </div>
      )}
    </>
  );
}
