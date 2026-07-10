"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import { buttonVariants } from "@/app/components/ui/button";
import type { AgentInspectorDetail } from "@/lib/proactive-runtime/types";
import { AgentStatusPill } from "./AgentStatusPill";

function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "Never";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

export function AgentDetailPanel({
  workspaceId,
  agentId,
}: {
  workspaceId: string;
  agentId: string;
}) {
  const [agent, setAgent] = useState<AgentInspectorDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`,
        { cache: "no-store" },
      );
      const payload = await response.json().catch(() => null);
      if (cancelled) {
        return;
      }
      if (!response.ok) {
        setError((payload && payload.error) || "Failed to load agent");
        return;
      }
      setAgent((payload?.data?.agent ?? null) as AgentInspectorDetail | null);
    })().catch((fetchError: unknown) => {
      if (!cancelled) {
        setError(fetchError instanceof Error ? fetchError.message : "Failed to load agent");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, agentId]);

  if (error) {
    return <div className="text-sm text-[var(--status-danger)]">{error}</div>;
  }

  if (!agent) {
    return <div className="text-sm text-[var(--text-muted)]">Loading agent details…</div>;
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>{agent.agentName}</CardTitle>
              <CardDescription>Schedules, watch globs, inbox selectors, and recent runtime activity.</CardDescription>
            </div>
            <AgentStatusPill status={agent.status} />
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 md:grid-cols-3">
            <Metric label="Queue depth" value={String(agent.queueDepth)} />
            <Metric label="Max backlog" value={String(agent.policy.maxBacklog)} />
            <Metric label="Timeout" value={`${Math.round(agent.policy.handlerTimeoutMs / 1000)}s`} />
          </div>

          <Section title="Schedules" value={JSON.stringify(agent.schedules, null, 2)} />
          <Section title="Watch globs" value={JSON.stringify(agent.watches, null, 2)} />
          <Section title="Inbox selectors" value={JSON.stringify(agent.inbox, null, 2)} />
        </CardContent>
      </Card>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Lifecycle</CardTitle>
            <CardDescription>Connection and deployment timestamps.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Detail label="Agent ID" value={agent.agentId} mono />
            <Detail label="Last connected" value={formatTimestamp(agent.lastConnectedAt)} />
            <Detail label="Last disconnected" value={formatTimestamp(agent.lastDisconnectedAt)} />
            <Detail label="Last deploy" value={formatTimestamp(agent.deployStartedAt)} />
            <Detail label="Last event" value={agent.lastEvent ?? "None"} />
            <Detail label="Last error" value={agent.lastError ?? "None"} mono />
          </CardContent>
        </Card>

        <div className="grid gap-3">
          <Link
            href={`/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/events`}
            className={buttonVariants({})}
          >
            Live events
          </Link>
          <Link
            href={`/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/metrics`}
            className={buttonVariants({ variant: "outline" })}
          >
            Metrics
          </Link>
          <Link
            href={`/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/cost`}
            className={buttonVariants({ variant: "outline" })}
          >
            Cost
          </Link>
        </div>
      </div>
    </div>
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

function Detail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[var(--text-muted)]">{label}</div>
      <div className={mono ? "break-all font-mono text-xs" : "font-medium"}>{value}</div>
    </div>
  );
}

function Section({ title, value }: { title: string; value: string }) {
  return (
    <div>
      <div className="mb-2 text-sm font-medium">{title}</div>
      <pre className="overflow-x-auto rounded-lg border border-[var(--code-border)] bg-[var(--code-bg)] p-4 text-sm text-[var(--code-fg)]">
        <code>{value}</code>
      </pre>
    </div>
  );
}
