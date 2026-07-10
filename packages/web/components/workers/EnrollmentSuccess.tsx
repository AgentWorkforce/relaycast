"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/app/components/ui/badge";
import { Button, buttonVariants } from "@/app/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import type { WorkerRecord, WorkerStatus } from "@/lib/workers/types";
import { CopyableCommand } from "./CopyableCommand";
import { WorkerStatusBadge } from "./WorkerStatusBadge";

type EnrollmentSuccessProps = {
  workspaceId: string;
  workerName: string;
  token: string;
  expiresAt: string;
  registerCommand: string;
  startCommand: string;
  issuedAt: string;
  workersHref: string;
  minCliVersion: string;
};

type PollState = "waiting" | "registered" | "online" | "timeout";

type WorkersResponse = {
  workers?: WorkerRecord[];
};

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

function parseTime(value: string | null | undefined): number {
  if (!value) {
    return Number.NaN;
  }

  return new Date(value).getTime();
}

function formatTimestamp(value: string) {
  const timestamp = parseTime(value);
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

function statusText(status: WorkerStatus | undefined) {
  if (status === "pending" || status === "offline") {
    return "Registered";
  }

  if (status === "online") {
    return "Online";
  }

  return "Waiting for registration";
}

export function EnrollmentSuccess({
  workspaceId,
  workerName,
  token,
  expiresAt,
  registerCommand,
  startCommand,
  issuedAt,
  workersHref,
  minCliVersion,
}: EnrollmentSuccessProps) {
  const router = useRouter();
  const [pollState, setPollState] = useState<PollState>("waiting");
  const [matchedWorker, setMatchedWorker] = useState<WorkerRecord | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const attemptStartedAtRef = useRef(Date.now());
  const stopPollingRef = useRef<(() => void) | null>(null);
  const issuedAtMs = useMemo(() => parseTime(issuedAt), [issuedAt]);

  useEffect(() => {
    const abortController = new AbortController();
    attemptStartedAtRef.current = Date.now();
    let stopped = false;
    let intervalId: number | undefined;

    function stopPolling() {
      stopped = true;
      abortController.abort();
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
    }
    stopPollingRef.current = stopPolling;

    async function pollWorkers() {
      if (stopped) {
        return;
      }

      if (Date.now() - attemptStartedAtRef.current >= POLL_TIMEOUT_MS) {
        setPollState("timeout");
        stopPolling();
        return;
      }

      try {
        const response = await fetch(
          `/api/v1/workers?workspaceId=${encodeURIComponent(workspaceId)}`,
          {
            cache: "no-store",
            credentials: "include",
            signal: abortController.signal,
          },
        );
        if (stopped) {
          return;
        }

        if (!response.ok) {
          setPollError("Could not refresh worker status.");
          return;
        }

        const payload = (await response.json()) as WorkersResponse;
        if (stopped) {
          return;
        }
        const workers = Array.isArray(payload.workers) ? payload.workers : [];
        const match = workers
          .filter((worker) => worker.name === workerName)
          .filter((worker) => {
            const registeredAt = parseTime(worker.registeredAt);
            return Number.isNaN(issuedAtMs) || Number.isNaN(registeredAt) || registeredAt >= issuedAtMs;
          })
          .sort((left, right) => parseTime(right.registeredAt) - parseTime(left.registeredAt))[0];

        if (!match) {
          setMatchedWorker(null);
          setPollState("waiting");
          setPollError(null);
          return;
        }

        setMatchedWorker(match);
        setPollError(null);
        setPollState(match.status === "online" ? "online" : "registered");
        if (match.status === "online") {
          stopPolling();
        }
      } catch {
        if (!abortController.signal.aborted) {
          setPollError("Could not refresh worker status.");
        }
      }
    }

    void pollWorkers();
    intervalId = window.setInterval(() => {
      void pollWorkers();
    }, POLL_INTERVAL_MS);

    return () => {
      stopPolling();
      if (stopPollingRef.current === stopPolling) {
        stopPollingRef.current = null;
      }
    };
  }, [issuedAtMs, pollAttempt, workerName, workspaceId]);

  function retryPolling() {
    setPollError(null);
    setPollState(matchedWorker ? "registered" : "waiting");
    setPollAttempt((value) => value + 1);
  }

  function cancelPolling() {
    stopPollingRef.current?.();
    router.push(workersHref);
  }

  return (
    <div className="space-y-6">
      <Card className="border-[var(--status-warning)]/40 bg-[var(--status-warning-soft)]">
        <CardContent className="p-4 text-sm font-medium text-[var(--status-warning)]">
          This token is shown only once — copy it now.
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>Run these commands on the worker host</CardTitle>
              <CardDescription>
                Requires agent-relay CLI {minCliVersion} or later.
              </CardDescription>
            </div>
            <Badge variant="warning">Expires {formatTimestamp(expiresAt)}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <CopyableCommand label="Enrollment token" command={token} />
          <CopyableCommand label="Register worker" command={registerCommand} />
          <CopyableCommand label="Start worker" command={startCommand} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>Registration status</CardTitle>
              <CardDescription>
                Waiting for a worker named {workerName} to register and come online.
              </CardDescription>
            </div>
            {matchedWorker ? (
              <WorkerStatusBadge status={matchedWorker.status} />
            ) : (
              <Badge variant="info">Polling</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {pollState === "online" ? (
            <div className="rounded-lg border border-[var(--status-success)]/30 bg-[var(--status-success-soft)] p-4 text-sm text-[var(--status-success)]">
              <div className="font-medium">Online</div>
              <p className="mt-1">The worker is ready to run workflows.</p>
            </div>
          ) : null}

          {pollState === "timeout" ? (
            <div className="rounded-lg border border-[var(--status-warning)]/30 bg-[var(--status-warning-soft)] p-4 text-sm text-[var(--status-warning)]">
              <div className="font-medium">Timed out waiting for this worker</div>
              <p className="mt-1">
                The token may still be valid until {formatTimestamp(expiresAt)}. Retry polling or return to the workers list.
              </p>
            </div>
          ) : null}

          {pollState !== "online" && pollState !== "timeout" ? (
            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-4 text-sm text-[var(--text-secondary)]">
              <div className="font-medium text-[var(--foreground)]">
                {statusText(matchedWorker?.status)}
              </div>
              <p className="mt-1">
                {matchedWorker
                  ? "The worker registered. Start the daemon command to bring it online."
                  : "No matching registration has appeared yet."}
              </p>
            </div>
          ) : null}

          {pollError ? (
            <p className="text-sm text-[var(--status-danger)]">{pollError}</p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            {pollState === "timeout" ? (
              <Button type="button" onClick={retryPolling}>
                Retry
              </Button>
            ) : null}
            {pollState === "online" ? (
              <Link href={workersHref} className={buttonVariants({})}>
                Back to workers
              </Link>
            ) : (
              <Button type="button" variant="outline" onClick={cancelPolling}>
                Cancel
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
