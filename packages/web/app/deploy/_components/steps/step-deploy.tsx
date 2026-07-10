"use client";

import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Badge } from "@/app/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import type { DeployPhase, HarnessSource, IntegrationState, PersonaSummary } from "../../_lib/types";
import type { DeployWorkspace } from "../../_lib/use-deploy-session";

type StepDeployProps = {
  persona: PersonaSummary;
  workspace: DeployWorkspace | null;
  integrationStates: Record<string, IntegrationState>;
  harnessSource: HarnessSource | null;
  inputValues: Record<string, string>;
  deployPhase: DeployPhase;
  progressMessages: string[];
  deployError: string | null;
  subscriptionCredentialMessage?: string | null;
  subscriptionCredentialChecking?: boolean;
};

function phaseLabel(phase: DeployPhase) {
  if (phase === "idle") return "Ready";
  if (phase === "submitting") return "Submitting";
  if (phase === "provisioning") return "Provisioning";
  if (phase === "ready") return "Ready";
  return "Failed";
}

function harnessSourceLabel(source: HarnessSource): string {
  if (source === "oauth") return "subscription";
  if (source === "managed") return "managed key";
  if (source === "byok") return "BYOK";
  return "plan";
}

export function StepDeploy({
  persona,
  workspace,
  integrationStates,
  harnessSource,
  inputValues,
  deployPhase,
  progressMessages,
  deployError,
  subscriptionCredentialMessage,
  subscriptionCredentialChecking = false,
}: StepDeployProps) {
  const active = deployPhase === "submitting" || deployPhase === "provisioning";

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Ready to deploy</CardTitle>
          <CardDescription>Review the launch configuration before deploying this agent.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-4">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Agent</p>
            <p className="mt-2 font-medium text-foreground">{persona.name}</p>
            <p className="mt-1 text-sm text-muted-foreground">{persona.model ?? persona.harness ?? "Configured runtime"}</p>
          </div>
          <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-4">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Workspace</p>
            <p className="mt-2 font-medium text-foreground">{workspace?.name ?? "No workspace"}</p>
            <p className="mt-1 text-sm text-muted-foreground">{workspace?.slug ?? "Choose a workspace"}</p>
          </div>
          <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-4">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Credentials</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {Object.values(integrationStates).map((state) => (
                <Badge key={state.provider} variant={state.state === "connected" ? "success" : "warning"}>
                  {state.provider}
                </Badge>
              ))}
              {harnessSource ? <Badge variant="info">{harnessSourceLabel(harnessSource)}</Badge> : null}
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-4">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Inputs</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {Object.values(inputValues).filter((value) => value.trim().length > 0).length || "No"} values configured.
            </p>
          </div>
        </CardContent>
      </Card>

      {subscriptionCredentialChecking ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            Checking active subscription credentials…
          </CardContent>
        </Card>
      ) : null}

      {subscriptionCredentialMessage ? (
        <Card className="border-[var(--status-warning)] bg-[var(--status-warning-soft)]">
          <CardContent className="flex items-start gap-3 p-4 text-sm leading-6 text-[var(--status-warning)]">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{subscriptionCredentialMessage}</span>
          </CardContent>
        </Card>
      ) : null}

      {deployPhase !== "idle" ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {active ? <Loader2 aria-hidden="true" className="animate-spin" /> : <CheckCircle2 aria-hidden="true" />}
              {phaseLabel(deployPhase)}
            </CardTitle>
            <CardDescription>Cloud deployment progress.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {progressMessages.map((message, index) => (
              <div key={`${message}-${index}`} className="flex gap-3 rounded-xl border border-[var(--border-default)] p-3 text-sm">
                <span className="mt-1 size-2 shrink-0 rounded-full bg-primary" />
                <span className="text-muted-foreground">{message}</span>
              </div>
            ))}
            {deployError ? (
              <p className="rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] p-3 text-sm text-[var(--status-danger)]">
                {deployError}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
