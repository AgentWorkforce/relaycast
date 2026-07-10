"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/app/components/ui/table";
import type { WorkspaceMetricsSnapshot } from "@/lib/proactive-runtime/types";
import { Sparkline } from "./Sparkline";

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value);
}

export function AgentCostPanel({
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
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/cost`,
        { cache: "no-store" },
      );
      const payload = await response.json().catch(() => null);
      if (cancelled) {
        return;
      }
      if (!response.ok) {
        setError((payload && payload.error) || "Failed to load cost");
        return;
      }
      setSnapshot((payload?.data ?? null) as WorkspaceMetricsSnapshot | null);
    })().catch((fetchError: unknown) => {
      if (!cancelled) {
        setError(fetchError instanceof Error ? fetchError.message : "Failed to load cost");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, agentId]);

  const totalCost = snapshot?.costByEventType.reduce((sum, row) => sum + row.costUsd, 0) ?? 0;
  const totalInputTokens =
    snapshot?.costByEventType.reduce((sum, row) => sum + row.inputTokens, 0) ?? 0;
  const totalOutputTokens =
    snapshot?.costByEventType.reduce((sum, row) => sum + row.outputTokens, 0) ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Burn Cost</CardTitle>
        <CardDescription>Cost samples tagged by the gateway for this agent and its event types.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? <div className="text-sm text-[var(--status-danger)]">{error}</div> : null}
        {snapshot ? (
          <>
            <div className="grid gap-3 md:grid-cols-3">
              <Metric label="Total cost" value={formatUsd(totalCost)} />
              <Metric label="Input tokens" value={String(totalInputTokens)} />
              <Metric label="Output tokens" value={String(totalOutputTokens)} />
            </div>

            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-4">
              <div className="mb-3 text-sm font-medium">Cost/min</div>
              <Sparkline points={snapshot.series.costUsdPerMinute} stroke="var(--status-success)" />
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event type</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Input</TableHead>
                  <TableHead>Output</TableHead>
                  <TableHead>Samples</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.costByEventType.map((row) => (
                  <TableRow key={row.eventType}>
                    <TableCell>{row.eventType}</TableCell>
                    <TableCell>{formatUsd(row.costUsd)}</TableCell>
                    <TableCell>{row.inputTokens}</TableCell>
                    <TableCell>{row.outputTokens}</TableCell>
                    <TableCell>{row.sampleCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        ) : !error ? (
          <div className="text-sm text-[var(--text-muted)]">Loading cost samples…</div>
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
