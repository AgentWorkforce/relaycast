"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/app/components/ui/badge";
import { Button, buttonVariants } from "@/app/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/app/components/ui/table";
import type { WorkerHostInfo, WorkerRecord } from "@/lib/workers/types";
import { WorkerStatusBadge } from "./WorkerStatusBadge";

type WorkersTableProps = {
  workspaceId: string;
  workers: WorkerRecord[];
};

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return "Never";
  }

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return "Unknown";
  }

  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatHostInfo(hostInfo: WorkerHostInfo) {
  const os =
    stringValue(hostInfo.os) ??
    stringValue(hostInfo.platform) ??
    stringValue(hostInfo.operatingSystem);
  const arch = stringValue(hostInfo.arch) ?? stringValue(hostInfo.architecture);
  const version =
    stringValue(hostInfo.agentRelayVersion) ??
    stringValue(hostInfo.agent_relay_version) ??
    stringValue(hostInfo.cliVersion) ??
    stringValue(hostInfo.version);

  return [os, arch, version].filter(Boolean).join(" / ") || "Not reported";
}

export function WorkersTable({ workspaceId, workers }: WorkersTableProps) {
  const router = useRouter();
  const [busyWorkerId, setBusyWorkerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revokeWorker(worker: WorkerRecord) {
    const confirmed = window.confirm(
      `Revoke ${worker.displayName || worker.name}? This worker will stop receiving new work.`,
    );
    if (!confirmed) {
      return;
    }

    setBusyWorkerId(worker.id);
    setError(null);

    try {
      const response = await fetch(`/api/v1/workers/${encodeURIComponent(worker.id)}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!response.ok) {
        setError("Could not revoke worker. Check your permissions and try again.");
        return;
      }

      router.refresh();
    } catch {
      setError("Could not revoke worker. Check your connection and try again.");
    } finally {
      setBusyWorkerId(null);
    }
  }

  async function setAsDefault(worker: WorkerRecord) {
    setBusyWorkerId(worker.id);
    setError(null);

    try {
      const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/runtime`, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "worker",
          config: {
            workerId: worker.id,
          },
        }),
      });

      if (!response.ok) {
        setError("Could not update the default runtime. Check your permissions and try again.");
        return;
      }

      router.refresh();
    } catch {
      setError("Could not update the default runtime. Check your connection and try again.");
    } finally {
      setBusyWorkerId(null);
    }
  }

  if (workers.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-6 text-sm text-[var(--text-secondary)]">
        No workers registered yet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <div className="rounded-lg border border-[var(--status-danger)]/30 bg-[var(--status-danger-soft)] p-3 text-sm text-[var(--status-danger)]">
          {error}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Display name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead>OS / arch / version</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workers.map((worker) => {
              const busy = busyWorkerId === worker.id;
              const canSetDefault = worker.status === "online";

              return (
                <TableRow key={worker.id}>
                  <TableCell className="font-medium">{worker.name}</TableCell>
                  <TableCell>{worker.displayName || worker.name}</TableCell>
                  <TableCell>
                    <WorkerStatusBadge status={worker.status} />
                  </TableCell>
                  <TableCell>
                    {worker.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {worker.tags.map((tag) => (
                          <Badge key={tag} variant="default" className="normal-case tracking-normal">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[var(--text-muted)]">None</span>
                    )}
                  </TableCell>
                  <TableCell>{formatTimestamp(worker.lastSeen)}</TableCell>
                  <TableCell>{formatHostInfo(worker.hostInfo)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Link
                        href={`/workspaces/${encodeURIComponent(workspaceId)}/runtimes/workers/${encodeURIComponent(worker.id)}`}
                        className={buttonVariants({ variant: "outline", size: "sm" })}
                      >
                        View
                      </Link>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!canSetDefault || busy}
                        onClick={() => setAsDefault(worker)}
                      >
                        Set as Default
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={worker.status === "revoked" || busy}
                        className="text-[var(--status-danger)] hover:text-[var(--status-danger)]"
                        onClick={() => revokeWorker(worker)}
                      >
                        Revoke
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
