"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import type { WorkspaceMetricsSnapshot } from "@/lib/proactive-runtime/types";
import { Sparkline } from "./Sparkline";

export function AgentMetricsPanel({
  workspaceId,
  agentId,
}: {
  workspaceId: string;
  agentId: string;
}) {
  const [snapshot, setSnapshot] = useState<WorkspaceMetricsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/metrics`,
        { cache: "no-store" },
      );
      const payload = await response.json().catch(() => null);
      if (cancelled) {
        return;
      }
      if (!response.ok) {
        setError((payload && payload.error) || "Failed to load metrics");
        return;
      }
      setSnapshot((payload?.data ?? null) as WorkspaceMetricsSnapshot | null);
    })().catch((fetchError: unknown) => {
      if (!cancelled) {
        setError(fetchError instanceof Error ? fetchError.message : "Failed to load metrics");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, agentId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Metrics</CardTitle>
        <CardDescription>Gateway event throughput, retries, drops, and latency for this agent.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? <div className="text-sm text-[var(--status-danger)]">{error}</div> : null}
        {snapshot ? (
          <>
            <div className="grid gap-3 md:grid-cols-4">
              <Metric label="Events" value={String(snapshot.totals.eventsReceivedTotal)} />
              <Metric label="Retries" value={String(snapshot.totals.retriesTotal)} />
              <Metric label="Drops" value={String(snapshot.totals.dropsTotal)} />
              <Metric label="P50 latency" value={`${Math.round(snapshot.totals.latencyP50Ms)}ms`} />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <GraphCard title="Events/min" points={snapshot.series.eventsPerMinute} />
              <GraphCard title="Retry rate" points={snapshot.series.retryRate} stroke="var(--status-warning)" />
              <GraphCard title="Drop rate" points={snapshot.series.dropRate} stroke="var(--status-danger)" />
              <GraphCard title="Latency p50" points={snapshot.series.latencyP50Ms} stroke="var(--brand-secondary)" />
            </div>
          </>
        ) : !error ? (
          <div className="text-sm text-[var(--text-muted)]">Loading metrics…</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-3">
      <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function GraphCard({
  title,
  points,
  stroke,
}: {
  title: string;
  points: number[];
  stroke?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-4">
      <div className="mb-3 text-sm font-medium">{title}</div>
      <Sparkline points={points} stroke={stroke} />
    </div>
  );
}
