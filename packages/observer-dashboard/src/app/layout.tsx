import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agent Relay Observer',
  description: 'Observer dashboard for Agent Relay workspaces',
  icons: {
    icon: '/favicon.svg',
  },
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
