"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import type { AgentActivityRecord } from "@/lib/proactive-runtime/types";

type EventsPayload = {
  data?: {
    events?: AgentActivityRecord[];
  };
  observer?: {
    wsUrl: string;
  };
};

export function AgentEventsStream({
  workspaceId,
  agentId,
}: {
  workspaceId: string;
  agentId: string;
}) {
  const [events, setEvents] = useState<AgentActivityRecord[]>([]);
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | null = null;

    (async () => {
      const response = await fetch(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/events`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => null)) as EventsPayload | null;
      if (!response.ok || !payload?.observer?.wsUrl) {
        setError("Failed to open the event stream");
        setStatus("offline");
        return;
      }

      setEvents((payload.data?.events ?? []).slice(0, 100));
      socket = new WebSocket(payload.observer.wsUrl);
      socket.onopen = () => setStatus("live");
      socket.onclose = () => setStatus("closed");
      socket.onerror = () => setStatus("error");
      socket.onmessage = (event) => {
        if (closed) {
          return;
        }
        try {
          const message = JSON.parse(event.data) as
            | { type?: string; events?: AgentActivityRecord[]; activity?: AgentActivityRecord }
            | null;
          if (message?.type === "snapshot" && Array.isArray(message.events)) {
            setEvents(message.events.slice(0, 100));
            return;
          }
          if (message?.type === "activity" && message.activity) {
            setEvents((current) => [message.activity!, ...current].slice(0, 100));
          }
        } catch {
          setStatus("error");
        }
      };
    })().catch((fetchError: unknown) => {
      setError(fetchError instanceof Error ? fetchError.message : "Failed to open the event stream");
      setStatus("offline");
    });

    return () => {
      closed = true;
      socket?.close();
    };
  }, [workspaceId, agentId]);

  const ordered = [...events].sort(
    (left, right) => right.occurredAt.localeCompare(left.occurredAt),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Live Event Stream</CardTitle>
        <CardDescription>
          Passive observer websocket against the gateway for runtime activity on this agent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-sm text-[var(--text-muted)]">
          Stream status: <span className="font-medium text-[var(--foreground)]">{status}</span>
        </div>
        {error ? <div className="text-sm text-[var(--status-danger)]">{error}</div> : null}
        <div className="space-y-3">
          {ordered.map((entry) => (
            <div
              key={entry.id}
              className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="font-medium">{entry.eventType ?? entry.kind}</div>
                <div className="text-xs text-[var(--text-muted)]">
                  {new Date(entry.occurredAt).toLocaleString()}
                </div>
              </div>
              {entry.message ? (
                <div className="mt-2 text-sm text-[var(--text-secondary)]">{entry.message}</div>
              ) : null}
              <div className="mt-2 text-xs text-[var(--text-muted)]">
                {entry.kind}
                {entry.attempt ? ` · attempt ${entry.attempt}` : ""}
                {entry.queueDepth !== undefined ? ` · queue ${entry.queueDepth}` : ""}
              </div>
            </div>
          ))}
          {ordered.length === 0 && !error ? (
            <div className="text-sm text-[var(--text-muted)]">No agent activity has been recorded yet.</div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
