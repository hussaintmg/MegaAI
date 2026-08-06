'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/machines', label: 'Machines' },
  { href: '/schedules', label: 'Schedules' },
  { href: '/settings', label: 'Settings' },
  { href: '/users', label: 'Users' },
];

export default function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [who, setWho] = useState<{ email: string; role: string } | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : { user: null }))
      .then((d: { user: { email: string; role: string } | null }) => setWho(d.user))
      .catch(() => setWho(null));
  }, []);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="topnav">
      <div className="brand">
        MEGA<span>AI</span>
      </div>
      {LINKS.map((link) => (
        <Link key={link.href} href={link.href} className={`nav ${pathname === link.href ? 'active' : ''}`}>
          {link.label}
        </Link>
      ))}
      <div className="spacer" />
      {who && (
        <span className="who">
          {who.email} · {who.role}
        </span>
      )}
      <button className="ghost small" onClick={logout}>
        Sign out
      </button>
    </div>
  );
}
