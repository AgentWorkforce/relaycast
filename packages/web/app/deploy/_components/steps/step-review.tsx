"use client";

import { Bot, CalendarClock, Zap } from "lucide-react";
import { Badge } from "@/app/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import { ProviderLogo } from "@/app/components/ProviderLogo";
import type { PersonaIntegrationSummary, PersonaSummary } from "../../_lib/types";

type StepReviewProps = {
  persona: PersonaSummary;
};

function IntegrationRow({ integration }: { integration: PersonaIntegrationSummary }) {
  return (
    <div className="flex gap-3 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-4">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background text-foreground">
        <ProviderLogo provider={integration.provider} label={integration.label} size={20} />
      </div>
      <div className="min-w-0">
        <p className="font-medium text-foreground">{integration.label}</p>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">{integration.description}</p>
      </div>
    </div>
  );
}

export function StepReview({ persona }: StepReviewProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 gap-4">
            <div className="shrink-0">
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
                <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
                  <Bot aria-hidden="true" />
                </div>
              )}
            </div>
            <div className="min-w-0">
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">{persona.name}</h1>
              <p className="mt-3 text-lg leading-7 text-foreground">{persona.tagline ?? persona.description}</p>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{persona.description}</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {persona.harness ? <Badge variant="info">{persona.harness}</Badge> : null}
            {persona.model ? <Badge>{persona.model}</Badge> : null}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap aria-hidden="true" />
              Fires on
            </CardTitle>
            <CardDescription>The events that wake this agent up.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {persona.triggers.map((trigger) => (
              <div key={`${trigger.provider}-${trigger.label}`} className="flex gap-3 rounded-xl border border-[var(--border-default)] p-3">
                <CalendarClock aria-hidden="true" className="mt-0.5 shrink-0 text-primary" />
                <div>
                  <Badge>{trigger.provider}</Badge>
                  <p className="mt-2 text-sm leading-5 text-muted-foreground">{trigger.label}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>It will connect</CardTitle>
            <CardDescription>Required provider access for this persona.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {persona.integrations.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border-default)] p-4 text-sm text-muted-foreground">
                This persona does not require external integrations.
              </div>
            ) : (
              persona.integrations.map((integration) => (
                <IntegrationRow key={integration.provider} integration={integration} />
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
