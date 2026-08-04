'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, SessionExpired } from '@/lib/client';

interface ScheduleRow {
  _id: string;
  name: string;
  goal: string;
  everyHours: number;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
}

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<ScheduleRow[] | null>(null);
  const [goal, setGoal] = useState('');
  const [name, setName] = useState('');
  const [everyHours, setEveryHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ schedules: ScheduleRow[] }>('/api/schedules');
      setSchedules(data.schedules);
    } catch (err) {
      if (err instanceof SessionExpired) return; // redirecting to /login
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'could not load schedules' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, goal, everyHours }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) setMessage({ ok: false, text: data.error ?? 'failed' });
      else {
        setMessage({ ok: true, text: 'Schedule added' });
        setGoal('');
        setName('');
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggle(schedule: ScheduleRow) {
    await fetch(`/api/schedules/${schedule._id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !schedule.enabled }),
    });
    await load();
  }

  async function remove(schedule: ScheduleRow) {
    if (!confirm(`Delete schedule "${schedule.name}"?`)) return;
    await fetch(`/api/schedules/${schedule._id}`, { method: 'DELETE' });
    await load();
  }

  return (
    <>
      <div className="panel">
        <h2>Recurring goals</h2>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          A GitHub Actions cron checks in periodically; due schedules run automatically as goals.
        </div>
        {!schedules ? (
          <div className="muted">Loading…</div>
        ) : schedules.length === 0 ? (
          <div className="muted">No schedules yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Name</th><th>Goal</th><th>Every</th><th>Next run</th><th>State</th><th></th></tr>
            </thead>
            <tbody>
              {schedules.map((schedule) => (
                <tr key={schedule._id}>
                  <td>{schedule.name}</td>
                  <td className="muted">{schedule.goal.slice(0, 60)}{schedule.goal.length > 60 ? '…' : ''}</td>
                  <td className="muted">{schedule.everyHours}h</td>
                  <td className="muted">{new Date(schedule.nextRunAt).toLocaleString()}</td>
                  <td><span className={`chip ${schedule.enabled ? 'running' : ''}`}>{schedule.enabled ? 'on' : 'off'}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="ghost small" onClick={() => toggle(schedule)}>{schedule.enabled ? 'pause' : 'resume'}</button>{' '}
                    <button className="danger small" onClick={() => remove(schedule)}>delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Add schedule</h2>
        <form onSubmit={add}>
          <label>Goal</label>
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder='e.g. "Prepare the weekly status report for all active projects"' />
          <div className="grid2">
            <div>
              <label>Name (optional)</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly report" />
            </div>
            <div>
              <label>Every (hours)</label>
              <input type="number" min={1} max={720} value={everyHours} onChange={(e) => setEveryHours(Number(e.target.value))} />
            </div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button type="submit" disabled={busy || goal.trim().length < 3}>{busy ? 'Adding…' : 'Add schedule'}</button>
            {message && <span className={`msg ${message.ok ? 'ok' : 'err'}`}>{message.text}</span>}
          </div>
        </form>
      </div>
    </>
  );
}
