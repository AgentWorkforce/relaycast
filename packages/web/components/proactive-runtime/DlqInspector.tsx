"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import type { DlqListItem } from "@/lib/proactive-runtime/types";

type DlqPayload = {
  data?: {
    items?: DlqListItem[];
  };
  error?: string;
};

export function DlqInspector({ workspaceId }: { workspaceId: string }) {
  const [items, setItems] = useState<DlqListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const load = () => {
    startTransition(() => {
      fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/dlq`, { cache: "no-store" })
        .then((response) => response.json().then((payload) => ({ response, payload })))
        .then(({ response, payload }: { response: Response; payload: DlqPayload }) => {
          if (!response.ok) {
            setError(payload.error ?? "Failed to load DLQ");
            return;
          }
          setItems(payload.data?.items ?? []);
        })
        .catch((loadError: unknown) => {
          setError(loadError instanceof Error ? loadError.message : "Failed to load DLQ");
        });
    });
  };

  useEffect(() => {
    load();
  }, [workspaceId]);

  const replay = async (eventId: string) => {
    const response = await fetch(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/dlq/${encodeURIComponent(eventId)}/replay`,
      { method: "POST" },
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError((payload && payload.error) || `Replay failed for ${eventId}`);
      return;
    }
    load();
  };

  const purge = async () => {
    const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/dlq`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError((payload && payload.error) || "Failed to purge DLQ");
      return;
    }
    load();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Dead Letter Queue</CardTitle>
            <CardDescription>Failed events persisted by the gateway for manual replay or purge.</CardDescription>
          </div>
          <Button variant="outline" onClick={purge} disabled={isPending || items.length === 0}>
            Purge all
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <div className="text-sm text-[var(--status-danger)]">{error}</div> : null}
        {items.map((item) => (
          <div
            key={item.eventId}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-3"
          >
            <div>
              <div className="font-medium">{item.eventId}</div>
              <div className="text-xs text-[var(--text-muted)]">
                {item.path} · {new Date(item.lastEditedAt).toLocaleString()}
              </div>
            </div>
            <Button onClick={() => replay(item.eventId)} disabled={isPending}>
              Replay
            </Button>
          </div>
        ))}
        {items.length === 0 && !error ? (
          <div className="text-sm text-[var(--text-muted)]">No DLQ records for this workspace.</div>
        ) : null}
      </CardContent>
    </Card>
  );
}
