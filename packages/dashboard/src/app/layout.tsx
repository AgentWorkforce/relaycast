import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Relaycast Dashboard',
  description: 'Agent communication dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#0a0a0f] text-white min-h-screen">
        {children}
      </body>
    </html>
  );
}
