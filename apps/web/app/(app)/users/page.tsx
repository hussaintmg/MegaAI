'use client';

import { useCallback, useEffect, useState } from 'react';

interface UserRow {
  _id: string;
  email: string;
  name?: string;
  role: string;
  createdAt: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/users');
    if (res.status === 403) {
      setDenied(true);
      return;
    }
    if (!res.ok) return;
    const data = (await res.json()) as { users: UserRow[] };
    setUsers(data.users);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, role }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) setMessage({ ok: false, text: data.error ?? 'failed' });
      else {
        setMessage({ ok: true, text: `Added ${email}` });
        setEmail('');
        setPassword('');
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(user: UserRow) {
    const next = prompt(`New password for ${user.email} (min 8 chars):`);
    if (!next) return;
    const res = await fetch(`/api/users/${user._id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: next }),
    });
    const data = (await res.json()) as { error?: string };
    setMessage(res.ok ? { ok: true, text: `Password updated for ${user.email}` } : { ok: false, text: data.error ?? 'failed' });
  }

  async function removeUser(user: UserRow) {
    if (!confirm(`Remove ${user.email}?`)) return;
    const res = await fetch(`/api/users/${user._id}`, { method: 'DELETE' });
    const data = (await res.json()) as { error?: string };
    setMessage(res.ok ? { ok: true, text: `Removed ${user.email}` } : { ok: false, text: data.error ?? 'failed' });
    await load();
  }

  if (denied) {
    return <div className="panel muted">Only the administrator can manage access.</div>;
  }

  return (
    <>
      <div className="panel">
        <h2>Access</h2>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          No public signup exists. You add every account here and you set (or reset) its password.
        </div>
        {!users ? (
          <div className="muted">Loading…</div>
        ) : (
          <table>
            <thead>
              <tr><th>Email</th><th>Role</th><th>Added</th><th></th></tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user._id}>
                  <td>{user.email}</td>
                  <td><span className="chip">{user.role}</span></td>
                  <td className="muted">{new Date(user.createdAt).toLocaleDateString()}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="ghost small" onClick={() => resetPassword(user)}>reset password</button>{' '}
                    <button className="danger small" onClick={() => removeUser(user)}>remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Add access</h2>
        <form onSubmit={addUser} className="grid2">
          <div>
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label>Password (you set it)</label>
            <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          </div>
          <div>
            <label>Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">member (use the platform)</option>
              <option value="admin">admin (settings + users too)</option>
            </select>
          </div>
          <div style={{ alignSelf: 'end' }}>
            <button type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add user'}</button>
            {message && <span className={`msg ${message.ok ? 'ok' : 'err'}`}>{message.text}</span>}
          </div>
        </form>
      </div>
    </>
  );
}
