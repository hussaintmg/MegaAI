import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MegaAI Cloud',
  description: 'MegaAI — autonomous AI delivery team, in the cloud',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
