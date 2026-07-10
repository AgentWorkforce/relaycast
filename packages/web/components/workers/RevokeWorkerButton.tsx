"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/app/components/ui/button";

type RevokeWorkerButtonProps = {
  workerId: string;
  workerLabel: string;
  workersHref: string;
};

export function RevokeWorkerButton({
  workerId,
  workerLabel,
  workersHref,
}: RevokeWorkerButtonProps) {
  const router = useRouter();
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revokeWorker() {
    const confirmed = window.confirm(
      `Revoke ${workerLabel}? This worker will stop receiving new work.`,
    );
    if (!confirmed) {
      return;
    }

    setRevoking(true);
    setError(null);

    try {
      const response = await fetch(`/api/v1/workers/${encodeURIComponent(workerId)}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!response.ok) {
        setError("Could not revoke worker. Check your permissions and try again.");
        return;
      }

      router.refresh();
      router.push(workersHref);
    } catch {
      setError("Could not revoke worker. Check your connection and try again.");
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        disabled={revoking}
        className="border-[var(--status-danger)]/40 text-[var(--status-danger)] hover:text-[var(--status-danger)]"
        onClick={revokeWorker}
      >
        {revoking ? "Revoking..." : "Revoke worker"}
      </Button>
      {error ? <p className="text-sm text-[var(--status-danger)]">{error}</p> : null}
    </div>
  );
}
