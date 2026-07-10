"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Plus } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";
import { PageSurface } from "./page-surface";
import { AgentThumb } from "./agent-art";
import { formatRelative } from "../_lib/agent-format";
import { useDashboard } from "./dashboard-data";
import type { DeployedAgent } from "./dashboard-data";
import type { FeaturedAgent } from "../_lib/agent-catalog";

/** Presentational projection of a deployed agent for the ops board. */
interface OpsAgent {
  agentId: string;
  name: string;
  status: string;
  description: string;
  imageUrl: string | null;
  lastActivityIso: string | null;
  runCount: number;
  scheduleCount: number;
  lastRunFailed: boolean;
  lastError: string | null;
  href: string;
}

function lastActivity(agent: DeployedAgent): string | null {
  return agent.lastCompletedAt ?? agent.lastFiredAt ?? agent.lastUsedAt ?? agent.createdAt ?? null;
}

function toOpsAgent(agent: DeployedAgent): OpsAgent {
  return {
    agentId: agent.agentId,
    name: agent.deployedName,
    status: agent.status,
    description: agent.personaDescription?.trim() || "Deployed proactive persona",
    imageUrl: agent.imageUrl,
    lastActivityIso: lastActivity(agent),
    runCount: agent.runCount,
    scheduleCount: agent.scheduleIds.length,
    lastRunFailed: agent.lastRunStatus?.toLowerCase() === "failed" || Boolean(agent.lastError),
    lastError: agent.lastError,
    href: `/dashboard/workforce/agents/${agent.agentId}`,
  };
}

type StatusTone = "running" | "ready" | "error";

function resolveStatusTone(agent: OpsAgent): StatusTone {
  if (agent.lastRunFailed) return "error";
  const status = (agent.status || "").trim().toLowerCase();
  if (status.includes("error") || status.includes("fail")) return "error";
  if (status.includes("run") || status.includes("active") || status.includes("executing")) {
    return "running";
  }
  // Deployed + healthy but not currently executing — waiting for its trigger.
  return "ready";
}

const STATUS_DOT: Record<StatusTone, string> = {
  running: "var(--status-success)",
  ready: "var(--primary)",
  error: "var(--status-danger)",
};

const STATUS_BADGE: Record<StatusTone, "success" | "info" | "danger"> = {
  running: "success",
  ready: "info",
  error: "danger",
};

function StatusDot({ tone }: { tone: StatusTone }) {
  const color = STATUS_DOT[tone];
  return (
    <span aria-hidden="true" className="relative inline-flex h-2 w-2 shrink-0">
      {tone === "running" ? (
        <span
          className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:animate-none"
          style={{ backgroundColor: color }}
        />
      ) : null}
      <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
    </span>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--primary)]">{children}</p>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="px-6 first:pl-0 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-[var(--border-default)]">
      <p className="font-mono text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      <p className="mt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

const ROW_GRID =
  "grid grid-cols-[1fr_auto] items-center gap-4 sm:grid-cols-[1fr_7rem_7rem] md:grid-cols-[1fr_8rem_8rem_5rem_6rem]";

function OpsHeaderRow() {
  return (
    <div
      className={`${ROW_GRID} border-b border-[var(--border-default)] px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground`}
    >
      <span>Agent</span>
      <span className="hidden sm:block">Status</span>
      <span className="hidden sm:block">Last fire</span>
      <span className="hidden text-right md:block">Runs</span>
      <span className="hidden text-right md:block">Schedules</span>
    </div>
  );
}

function OpsRow({ agent }: { agent: OpsAgent }) {
  const tone = resolveStatusTone(agent);
  return (
    <Link href={agent.href} className="block px-2 transition-colors hover:bg-[var(--surface-soft)]/40">
      <div className={`${ROW_GRID} py-3`}>
        <div className="flex min-w-0 items-center gap-3">
          <AgentThumb
            imageUrl={agent.imageUrl}
            seed={agent.agentId}
            name={agent.name}
            className="h-9 w-9 shrink-0 rounded-lg border border-[var(--border-default)]"
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{agent.name}</p>
            <p className="truncate text-xs text-muted-foreground">{agent.description}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <StatusDot tone={tone} />
          <Badge variant={STATUS_BADGE[tone]} className="hidden sm:inline-flex">
            {tone}
          </Badge>
        </div>

        <span
          suppressHydrationWarning
          className="hidden font-mono text-xs text-muted-foreground sm:block"
        >
          {formatRelative(agent.lastActivityIso)}
        </span>
        <span className="hidden text-right font-mono text-xs tabular-nums text-foreground md:block">
          {agent.runCount}
        </span>
        <span className="hidden text-right font-mono text-xs tabular-nums text-muted-foreground md:block">
          {agent.scheduleCount}
        </span>
      </div>

      {agent.lastRunFailed && agent.lastError ? (
        <p className="-mt-1 truncate pb-3 pl-12 font-mono text-xs text-[var(--status-danger)]">
          {agent.lastError}
        </p>
      ) : null}
    </Link>
  );
}

function AvailableUnit({ agent }: { agent: FeaturedAgent }) {
  return (
    <div className="flex items-center gap-4 px-2 py-4">
      <AgentThumb
        imageUrl={agent.imageUrl}
        seed={agent.slug}
        name={agent.name}
        className="h-11 w-11 shrink-0 rounded-lg border border-[var(--border-default)]"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground">{agent.name}</p>
        <p className="mt-0.5 line-clamp-2 text-sm leading-snug text-muted-foreground">{agent.tagline}</p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href={agent.deployHref}>
          Deploy
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      </Button>
    </div>
  );
}

function DashboardHomeSkeleton() {
  return (
    <PageSurface>
      <header className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-11 w-36 rounded-xl" />
      </header>

      <div className="mt-8 flex items-end border-y border-[var(--border-default)] py-5 gap-6">
        <Skeleton className="h-12 w-16" />
        <Skeleton className="h-12 w-16" />
        <Skeleton className="h-12 w-24" />
      </div>

      <div className="mt-8 space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    </PageSurface>
  );
}

export function DashboardHomeView({ featured }: { featured: FeaturedAgent[] }) {
  const { deploymentAgents, loadingData, sessionLoading, authenticated } = useDashboard();

  if (sessionLoading || (authenticated && loadingData)) {
    return <DashboardHomeSkeleton />;
  }

  const deployed = deploymentAgents.map(toOpsAgent);
  const hasDeployed = deployed.length > 0;

  const onDuty = deployed.length;
  const fired = deployed.reduce((sum, a) => sum + a.runCount, 0);
  const attention = deployed.filter((a) => a.lastRunFailed).length;

  return (
    <PageSurface>
      <header className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Eyebrow>Ops board</Eyebrow>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Agents</h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            Live status of the agents deployed to this workspace.
          </p>
        </div>

        <Button asChild size="lg">
          <Link href="/dashboard/agents">
            <Plus aria-hidden="true" className="h-4 w-4" />
            Browse agents
          </Link>
        </Button>
      </header>

      <div className="mt-8 flex items-end border-y border-[var(--border-default)] py-5">
        <Stat value={onDuty} label="On duty" />
        <Stat value={fired} label="Fires" />
        <Stat value={attention} label="Needs attention" />
      </div>

      {hasDeployed ? (
        <section aria-label="Deployed agents" className="mt-8">
          <OpsHeaderRow />
          <div className="divide-y divide-[var(--border-default)]">
            {deployed.map((agent) => (
              <OpsRow key={agent.agentId} agent={agent} />
            ))}
          </div>
        </section>
      ) : (
        <section aria-label="Available agents" className="mt-10">
          <div className="space-y-1 border-b border-[var(--border-default)] pb-3">
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              No agents deployed — bring units online
            </h2>
            <p className="text-sm text-muted-foreground">Deploy one to start receiving fires here.</p>
          </div>
          <div className="divide-y divide-[var(--border-default)]">
            {featured.map((agent) => (
              <AvailableUnit key={agent.slug} agent={agent} />
            ))}
          </div>
        </section>
      )}
    </PageSurface>
  );
}
