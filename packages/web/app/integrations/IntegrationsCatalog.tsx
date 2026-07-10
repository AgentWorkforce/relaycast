"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/app/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import { toAppPath } from "@/lib/app-path";
import type { IntegrationListEntry } from "@/lib/integrations/integration-list";
import type { WorkspaceIntegrationProvider } from "@/lib/integrations/providers";
import { WORKSPACE_INTEGRATION_LABELS } from "@/lib/integrations/providers";
import { IntegrationConnectionControls } from "./IntegrationConnectionControls";

type IntegrationSummary = {
  providerConfigKey: string | null;
  connectionId: string | null;
  installationId: string | null;
};

export type IntegrationCatalogEntry = {
  provider: WorkspaceIntegrationProvider;
  integration: IntegrationSummary | null;
  providerConfigKey: string;
};

export type IntegrationProviderGroup = {
  title: string;
  description: string;
  providers: WorkspaceIntegrationProvider[];
};

type Props = {
  workspaceId: string;
  nangoHost: string;
  providerGroups: IntegrationProviderGroup[];
  providerDescriptions: Record<WorkspaceIntegrationProvider, string>;
  providerSetupInstructions?: Partial<Record<WorkspaceIntegrationProvider, string[]>>;
  initialEntries: IntegrationCatalogEntry[];
};

async function fetchIntegrations(
  workspaceId: string,
): Promise<IntegrationListEntry[]> {
  const response = await fetch(
    toAppPath(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations`),
    { credentials: "include" },
  );

  if (!response.ok) {
    throw new Error("Failed to refresh workspace integrations.");
  }

  const payload = await response.json() as IntegrationListEntry[];
  return Array.isArray(payload) ? payload : [];
}

export function IntegrationsCatalog({
  workspaceId,
  nangoHost,
  providerGroups,
  providerDescriptions,
  providerSetupInstructions = {},
  initialEntries,
}: Props) {
  const [entries, setEntries] = useState(initialEntries);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const providerEntries = useMemo(
    () => initialEntries.map(({ provider, providerConfigKey }) => ({
      provider,
      providerConfigKey,
    })),
    [initialEntries],
  );

  const refreshIntegrations = useCallback(async () => {
    if (refreshPromiseRef.current) {
      await refreshPromiseRef.current;
      return;
    }

    const refreshPromise = (async () => {
      const integrations = await fetchIntegrations(workspaceId);
      const integrationsByProvider = new Map(
        integrations.map((integration) => [integration.provider, integration]),
      );

      setEntries(
        providerEntries.map((entry) => {
          const integration = integrationsByProvider.get(entry.provider);
          return {
            ...entry,
            integration: integration?.connectionId
              ? {
                providerConfigKey: integration.providerConfigKey,
                connectionId: integration.connectionId,
                installationId: integration.installationId ?? null,
              }
              : null,
          };
        }),
      );
    })();

    refreshPromiseRef.current = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      if (refreshPromiseRef.current === refreshPromise) {
        refreshPromiseRef.current = null;
      }
    }
  }, [providerEntries, workspaceId]);

  useEffect(() => {
    setEntries(initialEntries);
  }, [initialEntries]);

  const integrationsByProvider = useMemo(
    () => new Map(entries.map((entry) => [entry.provider, entry])),
    [entries],
  );

  return (
    <>
      {providerGroups.map((group) => (
        <section key={group.title} className="flex flex-col gap-3">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-[var(--foreground)]">
              {group.title}
            </h2>
            <p className="text-sm text-[var(--muted-foreground)]">
              {group.description}
            </p>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            {group.providers.map((provider) => {
              const entry = integrationsByProvider.get(provider);
              if (!entry) return null;
              const { integration, providerConfigKey } = entry;
              const setupInstructions = providerSetupInstructions[provider] ?? [];
              return (
                <Card key={provider}>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <CardTitle>{WORKSPACE_INTEGRATION_LABELS[provider]}</CardTitle>
                        <CardDescription>{providerDescriptions[provider]}</CardDescription>
                      </div>
                      <Badge variant={integration ? "success" : "default"}>
                        {integration ? "Connected" : "Disconnected"}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--muted-foreground)]">
                      {integration?.providerConfigKey ? (
                        <span>Provider config: {integration.providerConfigKey}</span>
                      ) : (
                        <span>Default provider config: {providerConfigKey}</span>
                      )}
                      {integration?.installationId ? (
                        <span>Installation: {integration.installationId}</span>
                      ) : null}
                    </div>
                    {setupInstructions.length > 0 ? (
                      <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/40 p-3 text-sm text-[var(--foreground)]">
                        <p className="font-medium">Setup notes</p>
                        <ol className="mt-2 list-decimal space-y-1 pl-5 text-[var(--muted-foreground)]">
                          {setupInstructions.map((instruction) => (
                            <li key={instruction}>{instruction}</li>
                          ))}
                        </ol>
                      </div>
                    ) : null}
                    <IntegrationConnectionControls
                      workspaceId={workspaceId}
                      provider={provider}
                      providerLabel={WORKSPACE_INTEGRATION_LABELS[provider]}
                      providerConfigKey={integration?.providerConfigKey ?? providerConfigKey}
                      nangoHost={nangoHost}
                      connected={Boolean(integration)}
                      connectionId={integration?.connectionId ?? null}
                      onMutate={refreshIntegrations}
                    />
                    {provider === "github" ? (
                      <Link
                        href="/integrations/github"
                        className="text-sm font-medium text-[var(--status-info)] hover:underline"
                      >
                        Open GitHub relayfile view
                      </Link>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}
