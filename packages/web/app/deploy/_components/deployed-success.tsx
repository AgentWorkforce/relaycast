"use client";

import Link from "next/link";
import { CheckCircle2, RotateCcw } from "lucide-react";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import type { DeployResult, PersonaSummary } from "../_lib/types";

type DeployedSuccessProps = {
  result: DeployResult;
  persona: PersonaSummary;
  fallbackReason?: string;
  onReset: () => void;
};

export function DeployedSuccess({ result, persona, fallbackReason, onReset }: DeployedSuccessProps) {
  const isDemoPreview = result.demo || Boolean(fallbackReason);

  return (
    <Card className="w-full max-w-3xl overflow-hidden">
      <CardHeader className="items-center gap-4 p-8 text-center">
        {persona.imageUrl ? (
          <img
            src={persona.imageUrl}
            alt={`${persona.name} card`}
            loading="lazy"
            className="h-16 w-28 rounded-lg border border-[var(--border-default)] object-cover"
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
        ) : (
          <div className="flex size-16 items-center justify-center rounded-full border border-[var(--status-success)] bg-[var(--status-success-soft)] text-[var(--status-success)]">
            <CheckCircle2 aria-hidden="true" />
          </div>
        )}
        <div className="flex flex-col gap-2">
          <CardTitle className="text-3xl">
            {isDemoPreview ? `Previewed ${persona.name}` : `${persona.name} is live`}
          </CardTitle>
          <CardDescription>
            {isDemoPreview
              ? "This was a demo run - no agent was deployed."
              : "The agent is deployed and ready to fire from the triggers in this persona."}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 p-8 pt-0">
        <div className="grid gap-3 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-4 text-sm sm:grid-cols-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Agent id</p>
            <p className="mt-2 truncate font-mono text-foreground">{result.agentId}</p>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Deployment</p>
            <p className="mt-2 truncate font-mono text-foreground">{result.deploymentId}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Status</p>
            <Badge className="mt-2" variant={isDemoPreview ? "warning" : "success"}>
              {isDemoPreview ? "Demo preview" : result.status}
            </Badge>
          </div>
        </div>

        <div className="rounded-2xl border border-[var(--border-default)] p-5">
          <p className="font-medium text-foreground">What happens next</p>
          <div className="mt-4 flex flex-col gap-3">
            {persona.triggers.map((trigger) => (
              <div key={`${trigger.provider}-${trigger.label}`} className="flex gap-3 text-sm">
                <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" />
                <span className="text-muted-foreground">{trigger.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button asChild>
            <Link href="/dashboard/workforce">View in dashboard</Link>
          </Button>
          <Button variant="outline" onClick={onReset}>
            <RotateCcw aria-hidden="true" />
            Deploy another
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
