import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agent Relay Observer',
  description: 'Agent Relay Observer dashboard',
};

const themeScript = `
  (function () {
    try {
      var key = 'agentrelay-theme';
      var stored = localStorage.getItem(key);
      var theme = stored === 'light' || stored === 'dark' ? stored : 'dark';
      var root = document.documentElement;
      root.dataset.theme = theme;
      root.style.colorScheme = theme;
      root.classList.remove('theme-light', 'theme-dark', 'light', 'dark');
      root.classList.add(theme === 'dark' ? 'theme-dark' : 'theme-light', theme);
    } catch (error) {}
  })();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="theme-dark dark" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen bg-[var(--background)] text-[var(--foreground)] antialiased">
        {children}
      </body>
    </html>
  );
}
