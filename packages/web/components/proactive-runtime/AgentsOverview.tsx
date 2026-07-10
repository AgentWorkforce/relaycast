"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/app/components/ui/table";
import type { AgentInspectorSummary } from "@/lib/proactive-runtime/types";
import { AgentStatusPill } from "./AgentStatusPill";

export type AgentsOverviewRenderState = "loading" | "error" | "empty" | "ready";

export function getAgentsOverviewRenderState(input: {
  loading: boolean;
  error: string | null;
  agentCount: number;
}): AgentsOverviewRenderState {
  if (input.loading) {
    return "loading";
  }
  if (input.error) {
    return "error";
  }
  if (input.agentCount === 0) {
    return "empty";
  }
  return "ready";
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "Never";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatErrorSnippet(value: string | null | undefined): string {
  if (!value) {
    return "None";
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 117)}...`;
}

export function AgentsOverview({ workspaceId }: { workspaceId: string }) {
  const [agents, setAgents] = useState<AgentInspectorSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setAgents([]);
    (async () => {
      const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (cancelled) {
        return;
      }
      if (!response.ok) {
        setError((payload && payload.error) || "Failed to load agents");
        return;
      }
      setAgents((payload?.data?.agents ?? []) as AgentInspectorSummary[]);
    })().catch((fetchError: unknown) => {
      if (!cancelled) {
        setError(fetchError instanceof Error ? fetchError.message : "Failed to load agents");
      }
    }).finally(() => {
      if (!cancelled) {
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const renderState = getAgentsOverviewRenderState({
    loading,
    error,
    agentCount: agents.length,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Running Agents</CardTitle>
        <CardDescription>
          Runtime inventory, current status, and the latest activity observed for each agent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? <div className="text-sm text-[var(--status-danger)]">{error}</div> : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last event</TableHead>
              <TableHead>Last error</TableHead>
              <TableHead>Deploy</TableHead>
              <TableHead>Queue</TableHead>
              <TableHead>Bindings</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {renderState === "loading" ? (
              <TableRow>
                <TableCell colSpan={7} className="text-sm text-[var(--text-muted)]">
                  Loading agents...
                </TableCell>
              </TableRow>
            ) : null}
            {renderState === "ready" ? agents.map((agent) => (
              <TableRow key={agent.agentId}>
                <TableCell>
                  <div className="font-medium">
                    <Link
                      href={`/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agent.agentId)}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {agent.agentName}
                    </Link>
                  </div>
                  <div className="font-mono text-xs text-[var(--text-muted)]">{agent.agentId}</div>
                </TableCell>
                <TableCell><AgentStatusPill status={agent.status} /></TableCell>
                <TableCell>
                  <div>{agent.lastEvent ?? "None"}</div>
                  <div className="text-xs text-[var(--text-muted)]">{formatTimestamp(agent.lastEventAt)}</div>
                </TableCell>
                <TableCell className="max-w-[20rem]">
                  <div
                    className={
                      agent.lastError
                        ? "break-words text-sm text-[var(--status-danger)]"
                        : "break-words text-sm text-[var(--text-muted)]"
                    }
                  >
                    {formatErrorSnippet(agent.lastError)}
                  </div>
                  <div className="text-xs text-[var(--text-muted)]">
                    {agent.lastError ? "Most recent failed delivery." : "No recent delivery failures."}
                  </div>
                </TableCell>
                <TableCell>{formatTimestamp(agent.deployStartedAt)}</TableCell>
                <TableCell>{agent.queueDepth}</TableCell>
                <TableCell className="text-sm text-[var(--text-muted)]">
                  {agent.scheduleCount} sched / {agent.watchCount} watch / {agent.inboxCount} inbox
                </TableCell>
              </TableRow>
            )) : null}
            {renderState === "empty" ? (
              <TableRow>
                <TableCell colSpan={7} className="text-sm text-[var(--text-muted)]">
                  No agents registered for this workspace yet.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
