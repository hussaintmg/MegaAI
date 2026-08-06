'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiGet, SessionExpired } from '@/lib/client';

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
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ goals: GoalRow[] }>('/api/goals');
      setGoals(data.goals);
      setLoadError('');
    } catch (err) {
      if (err instanceof SessionExpired) return; // redirecting to /login
      setLoadError(err instanceof Error ? err.message : 'could not load goals');
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
        body: JSON.stringify({ goal: goal.trim(), ...(folder.trim() ? { projectDir: folder.trim() } : {}) }),
      });
      const data = (await res.json()) as { goal?: GoalRow; error?: string; note?: string };
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'failed to submit' });
      } else if (data.note) {
        // Queued, but nothing can pick it up yet. Saying so now beats an empty
        // page in ten minutes.
        setMessage({ ok: false, text: data.note });
        setGoal('');
      } else {
        setMessage({
          ok: true,
          text: 'Handed over — it gets planned first, then Claude Code, Codex and OpenCode build it.',
        });
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
        <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
          A planner works out what it needs — database, backend, frontend, design, motion, security — and then your
          own coding agents write it: Claude Code, Codex and OpenCode, several pieces at a time. Nothing here writes
          code on their behalf. <Link href="/machines">Your machines</Link> do the work.
        </div>
        <form onSubmit={submit}>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder='e.g. "Build this client a complete ecommerce store: catalog, cart, checkout, auth"'
          />
          <input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="Project folder on the machine (optional) — e.g. C:/projects/shop"
            style={{ marginTop: 8 }}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button type="submit" disabled={busy || goal.trim().length < 3}>
              {busy ? 'Handing over…' : 'Run goal'}
            </button>
            {message && <span className={`msg ${message.ok ? 'ok' : 'err'}`}>{message.text}</span>}
          </div>
        </form>
      </div>

      <div className="panel">
        <h2>Goals</h2>
        {loadError && <div className="msg err" style={{ marginLeft: 0, marginBottom: 10 }}>{loadError}</div>}
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
