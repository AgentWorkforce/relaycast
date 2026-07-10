"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import type { RuntimeDescriptor, WorkerRecord } from "@/lib/workers/types";

type RuntimeDefaultPickerProps = {
  workspaceId: string;
  currentRuntime: RuntimeDescriptor;
  onlineWorkers: WorkerRecord[];
};

function selectedWorkerId(runtime: RuntimeDescriptor): string | null {
  return runtime.id === "worker" && typeof runtime.config?.workerId === "string"
    ? runtime.config.workerId
    : null;
}

export function RuntimeDefaultPicker({
  workspaceId,
  currentRuntime,
  onlineWorkers,
}: RuntimeDefaultPickerProps) {
  const router = useRouter();
  const currentWorkerId = selectedWorkerId(currentRuntime);
  const initialValue = onlineWorkers.some((worker) => worker.id === currentWorkerId)
    ? currentWorkerId ?? "daytona"
    : "daytona";
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedWorker = useMemo(
    () => onlineWorkers.find((worker) => worker.id === selected) ?? null,
    [onlineWorkers, selected],
  );

  async function saveDefaultRuntime() {
    setSaving(true);
    setError(null);

    try {
      const runtime =
        selected === "daytona"
          ? { id: "daytona" }
          : {
              id: "worker",
              config: {
                workerId: selected,
              },
            };

      const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/runtime`, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(runtime),
      });

      if (!response.ok) {
        setError("Could not update the default runtime. Check your permissions and try again.");
        return;
      }

      setOpen(false);
      router.refresh();
    } catch {
      setError("Could not update the default runtime. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <Button type="button" variant="outline" onClick={() => setOpen((value) => !value)}>
        Change default
      </Button>

      {open ? (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <label className="space-y-2">
              <span className="text-sm font-medium text-[var(--foreground)]">Default runtime</span>
              <select
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
                className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-strong)] px-3 py-2 text-sm text-[var(--foreground)] shadow-sm outline-none transition-colors focus:border-[var(--border-strong)]"
              >
                <option value="daytona">Daytona</option>
                {onlineWorkers.map((worker) => (
                  <option key={worker.id} value={worker.id}>
                    {worker.displayName || worker.name}
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" disabled={saving} onClick={saveDefaultRuntime}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
            <Badge variant={selected === "daytona" ? "info" : "success"}>
              {selected === "daytona" ? "Sandbox provider" : "Worker"}
            </Badge>
            <span>
              {selectedWorker
                ? `${selectedWorker.name} is online and available for new workflows.`
                : "Only online workers are available in this picker."}
            </span>
          </div>

          {error ? (
            <p className="mt-3 text-sm text-[var(--status-danger)]">{error}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
