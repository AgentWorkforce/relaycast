import { Badge } from "@/app/components/ui/badge";
import type { WorkerStatus } from "@/lib/workers/types";

const STATUS_LABELS: Record<WorkerStatus, string> = {
  online: "Online",
  pending: "Pending",
  offline: "Offline",
  revoked: "Revoked",
};

const STATUS_VARIANTS: Record<
  WorkerStatus,
  "success" | "warning" | "default" | "danger"
> = {
  online: "success",
  pending: "warning",
  offline: "default",
  revoked: "danger",
};

function isWorkerStatus(value: string): value is WorkerStatus {
  return value === "online" || value === "pending" || value === "offline" || value === "revoked";
}

export function WorkerStatusBadge({ status }: { status: WorkerStatus | string }) {
  const normalizedStatus = isWorkerStatus(status) ? status : "offline";

  return (
    <Badge variant={STATUS_VARIANTS[normalizedStatus]}>
      {STATUS_LABELS[normalizedStatus]}
    </Badge>
  );
}
