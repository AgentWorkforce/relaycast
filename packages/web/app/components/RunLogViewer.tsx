"use client";

import { useEffect, useMemo, useState } from "react";
import { toAppPath } from "@/lib/app-path";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { LogDisplay } from "./LogDisplay";
import { useLogStream } from "./useLogStream";

type RunStep = {
  stepName: string;
  agent: string;
  preset: string;
  cli: string;
  sandboxId: string;
};

type ResolvedRunStep = RunStep & {
  displayAgent: string;
};

type RunLogViewerProps = {
  runId: string;
  workflowConfig: string;
  status: string;
  onClose: () => void;
};

function getWorkflowName(workflowConfig: string) {
  try {
    const parsed: unknown = JSON.parse(workflowConfig);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const name = (parsed as Record<string, unknown>).name;
      if (typeof name === "string" && name) {
        return name;
      }
    }
  } catch {
    // not JSON
  }

  const yamlName = workflowConfig.match(/name:\s*["']?([^\n"']+)/i)?.[1]?.trim();
  if (yamlName) {
    return yamlName;
  }

  const variableName = workflowConfig.match(
    /(?:const|let|var)\s+name\s*=\s*["'`]([^"'`]+)["'`]/,
  )?.[1];
  if (variableName) {
    return variableName.trim();
  }

  const firstLine = workflowConfig.split("\n").find((line) => line.trim().length > 0);
  return firstLine?.trim().slice(0, 60) || "Untitled workflow";
}

function getStatusVariant(status: string) {
  const normalized = status.toLowerCase();

  if (normalized === "completed" || normalized === "success") {
    return "success" as const;
  }

  if (normalized === "running" || normalized === "pending") {
    return "info" as const;
  }

  if (normalized === "failed" || normalized === "error") {
    return "danger" as const;
  }

  return "default" as const;
}

function extractWorkflowAgents(workflowConfig: string) {
  try {
    const parsed: unknown = JSON.parse(workflowConfig);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const agents = (parsed as Record<string, unknown>).agents;
      if (Array.isArray(agents)) {
        return agents
          .map((a) => (a && typeof a === "object" ? (a as Record<string, unknown>).name : null))
          .filter((name): name is string => typeof name === "string" && Boolean(name));
      }
    }
  } catch {
    // not JSON — fall through to regex
  }

  const yamlAgents = [...workflowConfig.matchAll(/^\s*-\s+name:\s*["']?([^\n"']+)/gm)].map(
    (match) => match[1]?.trim() ?? "",
  );
  if (yamlAgents.length > 0) {
    return yamlAgents.filter(Boolean);
  }

  const tsAgents = [...workflowConfig.matchAll(/\.agent\(\s*["'`]([^"'`]+)["'`]/g)].map(
    (match) => match[1]?.trim() ?? "",
  );
  return tsAgents.filter(Boolean);
}

export function RunLogViewer({
  runId,
  workflowConfig,
  status,
  onClose,
}: RunLogViewerProps) {
  const [steps, setSteps] = useState<RunStep[]>([]);
  const [stepsLoading, setStepsLoading] = useState(true);
  const [stepsError, setStepsError] = useState<string | null>(null);
  const [selectedSandboxId, setSelectedSandboxId] = useState<string | null>(null);
  const runnerStream = useLogStream(runId);
  const workflowAgents = useMemo(() => extractWorkflowAgents(workflowConfig), [workflowConfig]);
  const resolvedSteps = useMemo<ResolvedRunStep[]>(
    () =>
      steps.map((step, index) => ({
        ...step,
        displayAgent:
          step.agent.trim() ||
          workflowAgents[index] ||
          step.stepName.trim() ||
          `Agent ${index + 1}`,
      })),
    [steps, workflowAgents],
  );
  const agentStream = useLogStream(
    runId,
    selectedSandboxId ?? undefined,
    2_000,
    Boolean(selectedSandboxId),
  );

  useEffect(() => {
    let active = true;

    const loadSteps = async () => {
      setStepsLoading(true);
      setStepsError(null);

      try {
        const response = await fetch(toAppPath(`/api/v1/workflows/runs/${runId}/steps`), {
          cache: "no-store",
          credentials: "include",
        });

        const payload = (await response.json().catch(() => null)) as
          | { steps?: RunStep[]; error?: string }
          | null;

        if (!response.ok) {
          throw new Error(payload?.error || "Failed to fetch steps");
        }

        if (!active) {
          return;
        }

        const nextSteps = Array.isArray(payload?.steps)
          ? payload.steps.filter((step): step is RunStep => Boolean(step?.sandboxId))
          : [];

        setSteps(nextSteps);
        setSelectedSandboxId((current) => {
          if (current && nextSteps.some((step) => step.sandboxId === current)) {
            return current;
          }

          return nextSteps[0]?.sandboxId ?? null;
        });
      } catch (err) {
        if (!active) {
          return;
        }

        setSteps([]);
        setSelectedSandboxId(null);
        setStepsError(err instanceof Error ? err.message : "Failed to fetch steps");
      } finally {
        if (active) {
          setStepsLoading(false);
        }
      }
    };

    void loadSteps();

    return () => {
      active = false;
    };
  }, [runId]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const selectedStep = useMemo(
    () => resolvedSteps.find((step) => step.sandboxId === selectedSandboxId) ?? null,
    [resolvedSteps, selectedSandboxId],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close run log viewer"
        className="absolute inset-0 bg-[var(--overlay)] backdrop-blur-sm"
        onClick={onClose}
      />

      <Card className="relative z-10 flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden bg-[var(--surface-card)]">
        <CardHeader className="border-b border-[var(--border-default)] bg-[var(--surface-strong)]">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <CardTitle>{getWorkflowName(workflowConfig)}</CardTitle>
                <Badge variant={getStatusVariant(status)}>{status}</Badge>
              </div>
              <CardDescription className="font-mono text-xs text-[var(--text-muted)]">
                Run ID {runId}
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </CardHeader>

        <CardContent className="flex-1 space-y-6 overflow-y-auto p-6">
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--text-secondary)]">
                  Runner Log
                </h3>
                <p className="text-sm text-[var(--text-muted)]">
                  Orchestrator output for the selected run.
                </p>
              </div>
              {runnerStream.isDone ? (
                <Badge variant="default">Complete</Badge>
              ) : (
                <Badge variant="info">Streaming</Badge>
              )}
            </div>
            {runnerStream.error ? (
              <div className="rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] px-4 py-3 text-sm text-[var(--status-danger)]">
                {runnerStream.error}
              </div>
            ) : null}
            <LogDisplay
              content={runnerStream.content}
              isLoading={runnerStream.isLoading}
              isDone={runnerStream.isDone}
            />
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--text-secondary)]">
                  Agent Logs
                </h3>
                <p className="text-sm text-[var(--text-muted)]">
                  Step sandboxes discovered from the run metadata.
                </p>
              </div>
              {selectedStep ? (
                <Badge variant="default">{selectedStep.displayAgent}</Badge>
              ) : null}
            </div>

            {stepsError ? (
              <div className="rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] px-4 py-3 text-sm text-[var(--status-danger)]">
                {stepsError}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {resolvedSteps.map((step) => (
                <Button
                  key={step.sandboxId}
                  variant={step.sandboxId === selectedSandboxId ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelectedSandboxId(step.sandboxId)}
                >
                  {step.displayAgent}
                </Button>
              ))}
            </div>

            {selectedStep ? (
              <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-soft)] px-4 py-3 text-sm text-[var(--text-secondary)]">
                {selectedStep.stepName} · {selectedStep.cli} · {selectedStep.preset}
              </div>
            ) : stepsLoading ? (
              <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-soft)] px-4 py-6 text-sm text-[var(--text-muted)]">
                Loading agent tabs...
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-[var(--border-soft)] bg-[var(--surface-soft)] px-4 py-6 text-sm text-[var(--text-muted)]">
                No agent logs available for this run.
              </div>
            )}

            {selectedStep ? (
              <>
                {agentStream.error ? (
                  <div className="rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] px-4 py-3 text-sm text-[var(--status-danger)]">
                    {agentStream.error}
                  </div>
                ) : null}
                <LogDisplay
                  content={agentStream.content}
                  isLoading={agentStream.isLoading}
                  isDone={agentStream.isDone}
                />
              </>
            ) : null}
          </section>
        </CardContent>
      </Card>
    </div>
  );
}
