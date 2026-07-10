"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { Button } from "../../components/ui/button";
import { PageSurface } from "./page-surface";
import { AgentThumb } from "./agent-art";
import type { CatalogAgent } from "../_lib/agent-catalog";

function CatalogRow({ agent }: { agent: CatalogAgent }) {
  return (
    <div className="flex items-center gap-4 px-2 py-4">
      <AgentThumb
        imageUrl={agent.imageUrl}
        seed={agent.slug}
        name={agent.name}
        className="h-12 w-16 shrink-0 rounded-lg border border-[var(--border-default)]"
      />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-foreground">{agent.name}</h3>
        <p className="mt-0.5 line-clamp-2 text-sm leading-snug text-muted-foreground">{agent.tagline}</p>
      </div>
      <Button asChild size="sm" className="shrink-0">
        <Link href={agent.deployHref}>
          Deploy
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      </Button>
    </div>
  );
}

export function AgentCatalogView({ agents }: { agents: CatalogAgent[] }) {
  return (
    <PageSurface>
      <header className="flex flex-col gap-5 border-b border-[var(--border-default)] pb-8">
        <Link
          href="/dashboard"
          className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          Back to roster
        </Link>
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--primary)]">
            Agent catalog
          </p>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">Browse agents</h1>
            <span className="text-sm text-muted-foreground">{agents.length} ready to deploy</span>
          </div>
          <p className="max-w-xl text-sm text-muted-foreground">
            Pick one to deploy to your workspace, or build your own. Every agent here runs proactively
            once you connect what it needs.
          </p>
        </div>
      </header>

      <section aria-label="Deployable agents" className="mt-6 divide-y divide-[var(--border-default)]">
        {agents.map((agent) => (
          <CatalogRow key={agent.slug} agent={agent} />
        ))}
      </section>
    </PageSurface>
  );
}
