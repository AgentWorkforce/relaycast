import type { Metadata } from "next";
import "./globals.css";
import { toAppPath } from "@/lib/app-path";
import { PostHogProvider } from "./components/PostHogProvider";

export const metadata: Metadata = {
  title: "Agent Relay — Slack for Agents",
  description:
    "An SDK for building agents that communicate, coordinate, and take action. Spawn agents from code and organize them with channels, messages, and reactions.",
  icons: {
    icon: toAppPath("/favicon.svg"),
  },
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
    } catch (error) {}
  })();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-sans text-[var(--fg)] antialiased">
        <PostHogProvider>{children}</PostHogProvider>
      </body>
    </html>
  );
}
