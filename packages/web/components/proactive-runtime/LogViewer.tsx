"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import type { LogFileRecord } from "@/lib/proactive-runtime/types";

type LogEntry = Record<string, unknown>;

export function LogViewer({ workspaceId }: { workspaceId: string }) {
  const [files, setFiles] = useState<LogFileRecord[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/logs`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (cancelled) {
        return;
      }
      if (!response.ok) {
        setError((payload && payload.error) || "Failed to load log files");
        return;
      }
      const nextFiles = (payload?.data?.items ?? []) as LogFileRecord[];
      setFiles(nextFiles);
      if (nextFiles[0]?.path) {
        setSelectedPath(nextFiles[0].path);
      }
    })().catch((fetchError: unknown) => {
      if (!cancelled) {
        setError(fetchError instanceof Error ? fetchError.message : "Failed to load log files");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }
    let cancelled = false;
    (async () => {
      const url = new URL(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/logs`, window.location.origin);
      url.searchParams.set("path", selectedPath);
      const response = await fetch(url.toString(), { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (cancelled) {
        return;
      }
      if (!response.ok) {
        setError((payload && payload.error) || "Failed to read logs");
        return;
      }
      setEntries((payload?.data?.entries ?? []) as LogEntry[]);
    })().catch((fetchError: unknown) => {
      if (!cancelled) {
        setError(fetchError instanceof Error ? fetchError.message : "Failed to read logs");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, selectedPath]);

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Log files</CardTitle>
          <CardDescription>Structured gateway log bundles stored under the workspace relayfile mount.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => setSelectedPath(file.path)}
              className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                selectedPath === file.path
                  ? "border-[var(--brand-primary)] bg-[var(--surface-soft)]"
                  : "border-[var(--border-default)]"
              }`}
            >
              <div className="font-medium">{file.path.split("/").pop()}</div>
              <div className="text-xs text-[var(--text-muted)]">{new Date(file.lastEditedAt).toLocaleString()}</div>
            </button>
          ))}
          {files.length === 0 ? (
            <div className="text-sm text-[var(--text-muted)]">No structured log files found.</div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Entries</CardTitle>
          <CardDescription>Parsed JSONL entries from the selected structured log file.</CardDescription>
        </CardHeader>
        <CardContent>
          {error ? <div className="mb-3 text-sm text-[var(--status-danger)]">{error}</div> : null}
          <pre className="max-h-[720px] overflow-auto rounded-lg border border-[var(--code-border)] bg-[var(--code-bg)] p-4 text-sm text-[var(--code-fg)]">
            <code>{JSON.stringify(entries, null, 2)}</code>
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
