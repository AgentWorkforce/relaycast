"use client";

import { useCallback, useEffect, useState } from "react";
import { toAppPath } from "@/lib/app-path";
import { Button } from "@/app/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";

type JoinRequest = {
  id: string;
  githubAccountLogin: string | null;
  createdAt: string;
  user: { id: string; email: string | null; name: string | null };
};

/**
 * Org owners/admins approve/deny GitHub-derived join requests for their org.
 * Lists the current org's pending requests and actions them through the existing
 * org-scoped endpoints (`GET`/`POST .../integrations/github/join[/decision]`).
 * Hidden for non-admins.
 */
export function GithubJoinRequestsCard({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/github/join`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(toAppPath(base), { credentials: "include" });
      if (res.status === 403) {
        setRequests([]);
        return;
      }
      if (!res.ok) throw new Error(`Failed to load join requests (${res.status}).`);
      const body = (await res.json()) as { requests?: JoinRequest[] };
      setRequests(body.requests ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load join requests.");
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    if (canManage) {
      void load();
    } else {
      setLoading(false);
    }
  }, [canManage, load]);

  async function decide(id: string, decision: "approve" | "deny") {
    setPendingId(id);
    setError(null);
    try {
      const res = await fetch(toAppPath(`${base}/decision`), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: id, decision }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${res.status}).`);
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed.");
    } finally {
      setPendingId(null);
    }
  }

  if (!canManage) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub join requests</CardTitle>
        <CardDescription>
          People requesting to join this organization via GitHub. Approving grants them active
          membership.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? (
          <p className="rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] p-3 text-sm text-[var(--status-danger)]">
            {error}
          </p>
        ) : null}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pending join requests.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--border-default)]">
            {requests.map((req) => (
              <li
                key={req.id}
                className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {req.user.email ?? req.user.name ?? "Unknown user"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    GitHub: {req.githubAccountLogin ?? "—"} ·{" "}
                    {new Date(req.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pendingId !== null}
                    onClick={() => void decide(req.id, "deny")}
                  >
                    {pendingId === req.id ? "…" : "Deny"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={pendingId !== null}
                    onClick={() => void decide(req.id, "approve")}
                  >
                    {pendingId === req.id ? "…" : "Approve"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
