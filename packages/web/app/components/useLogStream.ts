"use client";

import { useEffect, useRef, useState } from "react";
import { toAppPath } from "@/lib/app-path";

type LogStreamResponse = {
  content?: string;
  offset?: number;
  done?: boolean;
  error?: string;
};

type LogStreamState = {
  content: string;
  isLoading: boolean;
  isDone: boolean;
  error: string | null;
};

export function useLogStream(
  runId: string,
  sandboxId?: string,
  pollIntervalMs = 2_000,
  enabled = true,
): LogStreamState {
  const [content, setContent] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isDone, setIsDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    setContent("");
    setIsLoading(enabled);
    setIsDone(false);
    setError(null);
  }, [enabled, runId, sandboxId]);

  useEffect(() => {
    const clearPendingTimeout = () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };

    if (!enabled) {
      clearPendingTimeout();
      return;
    }

    let cancelled = false;
    let currentOffset = 0;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const search = new URLSearchParams({ offset: String(currentOffset) });
        if (sandboxId) {
          search.set("sandboxId", sandboxId);
        }

        const response = await fetch(toAppPath(`/api/v1/workflows/runs/${runId}/logs?${search.toString()}`), {
          cache: "no-store",
          credentials: "include",
          signal: controller.signal,
        });

        const payload = (await response.json().catch(() => null)) as LogStreamResponse | null;
        if (!response.ok) {
          throw new Error(payload?.error || "Failed to fetch logs");
        }

        if (cancelled) {
          return;
        }

        const nextContent = payload?.content ?? "";
        const nextOffset = payload?.offset ?? currentOffset;
        const nextDone = payload?.done ?? false;

        if (nextContent) {
          setContent((previous) => previous + nextContent);
        }

        currentOffset = nextOffset;
        setIsDone(nextDone);
        setError(null);
        setIsLoading(false);

        if (!nextDone) {
          clearPendingTimeout();
          timeoutRef.current = window.setTimeout(poll, pollIntervalMs);
        }
      } catch (err) {
        if (cancelled || controller.signal.aborted) {
          return;
        }

        setError(err instanceof Error ? err.message : "Failed to fetch logs");
        setIsLoading(false);
        clearPendingTimeout();
        timeoutRef.current = window.setTimeout(poll, pollIntervalMs);
      }
    };

    void poll();

    return () => {
      cancelled = true;
      controller.abort();
      clearPendingTimeout();
    };
  }, [enabled, runId, sandboxId, pollIntervalMs]);

  return { content, isLoading, isDone, error };
}
