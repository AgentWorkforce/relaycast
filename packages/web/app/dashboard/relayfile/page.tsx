"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  PauseCircle,
  RefreshCcw,
} from "lucide-react";
import { toAppPath } from "@/lib/app-path";
import { useDashboard } from "../_components/dashboard-data";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";

type SyncProviderStatus = {
  provider: string;
  status: "healthy" | "lagging" | "error" | "paused";
  cursor?: string | null;
  watermarkTs?: string | null;
  lagSeconds?: number;
  lastError?: string | null;
  failureCodes?: Record<string, number>;
  deadLetteredEnvelopes?: number;
  deadLetteredOps?: number;
  webhookHealthy?: boolean;
  webhookLastEventAt?: string | null;
  webhookLastError?: string | null;
};

type SyncStatusResponse = {
  workspaceId: string;
  providers: SyncProviderStatus[];
};

function statusBadgeVariant(status: SyncProviderStatus["status"]) {
  if (status === "healthy") return "success" as const;
  if (status === "lagging") return "warning" as const;
  if (status === "error") return "danger" as const;
  return "default" as const;
}

function statusIcon(status: SyncProviderStatus["status"]) {
  if (status === "healthy") return <CheckCircle2 className="h-4 w-4 text-[var(--status-success)]" />;
  if (status === "lagging") return <Clock className="h-4 w-4 text-[var(--status-warning)]" />;
  if (status === "error") return <AlertCircle className="h-4 w-4 text-[var(--status-danger)]" />;
  return <PauseCircle className="h-4 w-4 text-muted-foreground" />;
}

function formatLag(seconds: number | undefined) {
  if (!seconds) return null;
  if (seconds < 60) return `${seconds}s lag`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m lag`;
  return `${Math.round(seconds / 3600)}h lag`;
}

function ProviderCard({ provider }: { provider: SyncProviderStatus }) {
  const lag = formatLag(provider.lagSeconds);
  const deadLettered = (provider.deadLetteredEnvelopes ?? 0) + (provider.deadLetteredOps ?? 0);

  return (
    <Card className="rounded-2xl border-border bg-card">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {statusIcon(provider.status)}
            <p className="font-medium text-sm text-foreground capitalize truncate">
              {provider.provider}
            </p>
          </div>
          <Badge variant={statusBadgeVariant(provider.status)}>{provider.status}</Badge>
        </div>

        {(lag || deadLettered > 0 || provider.lastError || !provider.webhookHealthy) && (
          <div className="mt-3 space-y-1.5">
            {lag && (
              <p className="text-xs text-muted-foreground">{lag}</p>
            )}
            {deadLettered > 0 && (
              <p className="text-xs text-[var(--status-danger)]">
                {deadLettered} dead-lettered
              </p>
            )}
            {provider.webhookHealthy === false && (
              <p className="text-xs text-[var(--status-warning)]">Webhook unhealthy</p>
            )}
            {provider.lastError && (
              <p className="text-xs text-muted-foreground truncate" title={provider.lastError}>
                {provider.lastError}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function RelayfilePage() {
  const { authSession } = useDashboard();
  const [status, setStatus] = useState<SyncStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const workspaceId = authSession?.currentWorkspace.id ?? null;

  useEffect(() => {
    if (!workspaceId) {
      setStatus(null);
      setLoading(false);
      return;
    }

    let active = true;
    setStatus(null);
    setLoading(true);
    setError(null);

    fetch(
      toAppPath(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/relayfile/status`),
      { credentials: "include" },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return (await res.json()) as SyncStatusResponse;
      })
      .then((data) => {
        if (!active) return;
        setStatus(data);
      })
      .catch((cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Failed to load relayfile status.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [workspaceId, refreshKey]);

  const providers = status?.providers ?? [];
  const healthy = providers.filter((p) => p.status === "healthy").length;
  const errored = providers.filter((p) => p.status === "error").length;
  const lagging = providers.filter((p) => p.status === "lagging").length;

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 space-y-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Relayfile</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Sync status for your workspace integrations
          </p>
        </div>
        <div className="flex items-center gap-2">
          {authSession && (
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl gap-1.5"
              asChild
            >
              <a
                href={toAppPath(
                  `/api/v1/workspaces/${encodeURIComponent(authSession.currentWorkspace.id)}/relayfile/observer`,
                )}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                File browser
              </a>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="rounded-xl gap-1.5"
            disabled={loading}
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {providers.length > 0 && (
        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-1.5 text-[var(--status-success)]">
            <CheckCircle2 className="h-4 w-4" />
            {healthy} healthy
          </span>
          {lagging > 0 && (
            <span className="flex items-center gap-1.5 text-[var(--status-warning)]">
              <Clock className="h-4 w-4" />
              {lagging} lagging
            </span>
          )}
          {errored > 0 && (
            <span className="flex items-center gap-1.5 text-[var(--status-danger)]">
              <AlertCircle className="h-4 w-4" />
              {errored} error
            </span>
          )}
        </div>
      )}

      {loading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(3)].map((_, i) => (
            <Card key={i} className="rounded-2xl border-border">
              <CardContent className="p-4 space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!loading && error && (
        <Card className="rounded-2xl border-border bg-card">
          <CardContent className="p-6 flex items-center gap-3 text-[var(--status-danger)]">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <p className="text-sm">{error}</p>
          </CardContent>
        </Card>
      )}

      {!loading && !error && providers.length === 0 && (
        <Card className="rounded-2xl border-border bg-card">
          <CardContent className="p-10 flex flex-col items-center gap-3 text-center">
            <Activity className="h-8 w-8 text-muted-foreground opacity-40" />
            <p className="text-sm text-muted-foreground">
              No provider syncs found for this workspace.
            </p>
          </CardContent>
        </Card>
      )}

      {!loading && !error && providers.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {providers.map((provider) => (
            <ProviderCard key={provider.provider} provider={provider} />
          ))}
        </div>
      )}
    </div>
  );
}
