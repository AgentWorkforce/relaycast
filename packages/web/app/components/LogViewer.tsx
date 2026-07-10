"use client";

/**
 * LogViewer — streaming log viewer for workflow sandbox output.
 * Adapted from @agent-relay/dashboard LogViewer for the cloud app.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";

function sanitizeLogContent(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\u001b\][^\u0007]*\u0007/g, "");
}

function isSpinnerFragment(value: string): boolean {
  return /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏.\s]+$/.test(value);
}

export interface LogLine {
  id: string;
  content: string;
  timestamp: number;
  type: "stdout" | "stderr" | "system";
}

export interface LogViewerProps {
  /** Lines to display */
  lines: LogLine[];
  /** Whether we're actively streaming */
  isStreaming: boolean;
  /** Max height of the viewer */
  maxHeight?: string;
  /** Optional class name */
  className?: string;
}

export function LogViewer({
  lines,
  isStreaming,
  maxHeight = "480px",
  className = "",
}: LogViewerProps) {
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filteredLines = useMemo(() => {
    return lines.filter((line) => {
      const stripped = sanitizeLogContent(line.content).trim();
      if (stripped.length === 0) return false;
      if (isSpinnerFragment(stripped)) return false;
      return true;
    });
  }, [lines]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filteredLines, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    if (atBottom && !autoScroll) setAutoScroll(true);
    else if (!atBottom && autoScroll) setAutoScroll(false);
  }, [autoScroll]);

  return (
    <div
      className={`overflow-hidden rounded-2xl border border-[var(--code-border)] ${className}`}
      style={{
        background: "linear-gradient(180deg, var(--code-topbar) 0%, var(--code-bg) 100%)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--code-border)] bg-[color-mix(in_srgb,var(--code-topbar)_84%,transparent)] px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[var(--code-muted)]"
          >
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--code-muted)]">
            Sandbox Output
          </span>
          {isStreaming ? (
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider"
              style={{ background: "var(--status-info-soft)", color: "var(--status-info)" }}>
              <span
                className="w-1.5 h-1.5 rounded-full animate-pulse"
                style={{ backgroundColor: "var(--status-info)", boxShadow: "0 0 6px var(--status-info)" }}
              />
              streaming
            </span>
          ) : (
            <span className="flex items-center gap-1.5 rounded-full bg-[var(--surface-soft)] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[var(--code-muted)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-faint)]" />
              idle
            </span>
          )}
        </div>
        <span className="text-[10px] tabular-nums text-[var(--code-muted)]">
          {filteredLines.length} lines
        </span>
      </div>

      {/* Log content */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="font-mono text-xs leading-relaxed p-4 overflow-y-auto"
        style={{ maxHeight }}
      >
        {filteredLines.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 italic text-[var(--code-muted)]">
            {isStreaming ? (
              <>
                <span
                  className="w-1.5 h-1.5 rounded-full animate-pulse"
                  style={{ backgroundColor: "var(--status-info)" }}
                />
                Waiting for output…
              </>
            ) : (
              "No logs available"
            )}
          </div>
        ) : (
          filteredLines.map((line) => (
            <LogLineItem key={line.id} line={line} />
          ))
        )}
      </div>
    </div>
  );
}

function LogLineItem({ line }: { line: LogLine }) {
  const content = sanitizeLogContent(line.content);

  const colorClass =
    line.type === "stderr"
      ? "text-[var(--status-danger)]"
      : line.type === "system"
      ? "text-[var(--brand-primary)] italic"
      : "text-[var(--code-fg)]";

  return (
    <div className={`${colorClass} leading-5 whitespace-pre-wrap break-all min-w-0 overflow-hidden`}>
      {content}
    </div>
  );
}

export default LogViewer;
