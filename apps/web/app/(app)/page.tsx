'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

interface GoalRow {
  _id: string;
  goal: string;
  status: string;
  source: string;
  createdAt: string;
  error?: string;
}

export default function DashboardPage() {
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/goals');
      if (!res.ok) return;
      const data = (await res.json()) as { goals: GoalRow[] };
      setGoals(data.goals);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (goal.trim().length < 3) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: goal.trim() }),
      });
      const data = (await res.json()) as { goal?: GoalRow; error?: string };
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'failed to submit' });
      } else if (data.goal?.status === 'error') {
        setMessage({ ok: false, text: data.goal.error ?? 'dispatch failed — check Settings' });
      } else {
        setMessage({ ok: true, text: 'Dispatched — the GitHub Actions runner is on it.' });
        setGoal('');
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  const counts = {
    total: goals.length,
    active: goals.filter((g) => ['queued', 'dispatched', 'running'].includes(g.status)).length,
    completed: goals.filter((g) => g.status === 'completed').length,
    failed: goals.filter((g) => g.status === 'failed' || g.status === 'error').length,
  };

  return (
    <>
      <div className="stats">
        <div className="stat"><b>{counts.total}</b><span>goals</span></div>
        <div className="stat"><b>{counts.active}</b><span>active</span></div>
        <div className="stat"><b>{counts.completed}</b><span>completed</span></div>
        <div className="stat"><b>{counts.failed}</b><span>failed</span></div>
      </div>

      <div className="panel">
        <h2>New goal</h2>
        <form onSubmit={submit}>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder='e.g. "Build this client a complete ecommerce store: catalog, cart, checkout, auth"'
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button type="submit" disabled={busy || goal.trim().length < 3}>
              {busy ? 'Dispatching…' : 'Run goal'}
            </button>
            {message && <span className={`msg ${message.ok ? 'ok' : 'err'}`}>{message.text}</span>}
          </div>
        </form>
      </div>

      <div className="panel">
        <h2>Goals</h2>
        {goals.length === 0 ? (
          <div className="muted">No goals yet — submit one above.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Goal</th><th>Status</th><th>Source</th><th>Created</th></tr>
            </thead>
            <tbody>
              {goals.map((g) => (
                <tr key={g._id}>
                  <td><Link href={`/goals/${g._id}`}>{g.goal.slice(0, 90)}{g.goal.length > 90 ? '…' : ''}</Link></td>
                  <td><span className={`chip ${g.status}`}>{g.status}</span></td>
                  <td className="muted">{g.source}</td>
                  <td className="muted">{new Date(g.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
