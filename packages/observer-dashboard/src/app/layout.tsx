import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agent Relay Observer',
  description: 'Agent Relay Observer dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark theme-dark">
      <body className="bg-[var(--color-bg-deep)] text-[var(--color-text-primary)] min-h-screen">
        {children}
      </body>
    </html>
  );
}
