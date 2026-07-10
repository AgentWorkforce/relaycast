"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import "@xterm/xterm/css/xterm.css";

// Dynamic import to avoid SSR issues with xterm.js (needs DOM/canvas)
const XTermLogViewer = dynamic(
  () =>
    import("@agent-relay/dashboard/components/XTermLogViewer").then(
      (m) => m.XTermLogViewer
    ),
  {
    ssr: false,
    loading: () => (
      <div className="h-[500px] bg-[#0d0f14] rounded-xl border border-[#2a2d35] animate-pulse" />
    ),
  }
);

type LogDisplayProps = {
  content: string;
  agentName?: string;
  isLoading: boolean;
  isDone: boolean;
  maxHeight?: string;
  onClose?: () => void;
  className?: string;
};

export function LogDisplay({
  content,
  agentName = "runner",
  isLoading,
  isDone,
  maxHeight = "500px",
  onClose,
}: LogDisplayProps) {
  // Convert accumulated content into mockData format for XTermLogViewer.
  // Each poll appends to content; we re-render the full terminal on each update.
  const mockData = useMemo(() => {
    if (!content && isLoading) {
      return [{ content: "\x1b[90mWaiting for log output...\x1b[0m\n" }];
    }
    if (!content && isDone) {
      return [{ content: "\x1b[90mNo logs captured.\x1b[0m\n" }];
    }
    if (!content) {
      return [{ content: "\x1b[90mWaiting for log output...\x1b[0m\n" }];
    }
    // Feed the raw PTY content — xterm.js handles ANSI natively
    return [{ content }];
  }, [content, isLoading, isDone]);

  return (
    <XTermLogViewer
      agentName={agentName}
      mockData={mockData}
      maxHeight={maxHeight}
      showHeader={true}
      onClose={onClose}
    />
  );
}
