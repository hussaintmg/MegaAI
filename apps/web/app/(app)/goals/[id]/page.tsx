'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState } from 'react';

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
  const eventsRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/goals/${id}`);
      if (res.status === 404 || res.status === 400) {
        setNotFound(true);
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as { goal: GoalDetail };
      setGoal(data.goal);
    } catch {
      /* transient */
    }
  }, [id]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, 3000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const el = eventsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [goal?.events.length]);

  if (notFound) {
    return (
      <div className="panel">
        Goal not found. <Link href="/">Back to dashboard</Link>
      </div>
    );
  }
  if (!goal) return <div className="panel muted">Loading…</div>;

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
