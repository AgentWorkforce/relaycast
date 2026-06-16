'use client';

import { Server, ServerOff, RefreshCw } from 'lucide-react';
import { useFleet } from '../hooks/use-fleet';
import { FleetNodeCard } from './FleetNodeCard';
import { cn } from '../lib/utils';

export function FleetView({ className }: { className?: string }) {
  const { nodes, loading, disabled, error, refresh } = useFleet();
  const onlineCount = nodes.filter((node) => node.live).length;

  return (
    <main className={cn('flex min-w-0 flex-1 flex-col', className)}>
      <div className="brand-glass mb-3 flex items-center justify-between gap-3 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-2xl bg-[var(--brand-primary-faint)] text-[var(--brand-primary)]">
            <Server className="h-4.5 w-4.5" />
          </span>
          <div>
            <h1 className="brand-title text-base font-semibold text-[var(--foreground)]">Fleet</h1>
            <p className="text-xs text-[var(--text-secondary)]">
              {disabled ? 'Fleet not enabled' : `${onlineCount} online · ${nodes.length} node${nodes.length === 1 ? '' : 's'}`}
            </p>
          </div>
        </div>
        <button
          onClick={() => refresh()}
          className="flex items-center gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-soft)] px-3 py-2 text-xs font-semibold text-[var(--foreground)] transition-colors hover:bg-[var(--surface-muted)]"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {disabled ? (
          <EmptyState
            icon={<ServerOff className="h-6 w-6" />}
            title="Fleet is not enabled"
            body="This workspace hasn't opted into the fleet rollout. Enable fleet nodes for the workspace to register nodes and see them here."
          />
        ) : error ? (
          <EmptyState
            icon={<ServerOff className="h-6 w-6" />}
            title="Couldn't load fleet"
            body={error.message}
          />
        ) : loading && nodes.length === 0 ? (
          <EmptyState icon={<Server className="h-6 w-6 animate-pulse" />} title="Loading nodes…" body="" />
        ) : nodes.length === 0 ? (
          <EmptyState
            icon={<Server className="h-6 w-6" />}
            title="No nodes connected"
            body="Register a fleet node and it will appear here as soon as it comes online."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 pb-3 md:grid-cols-2 xl:grid-cols-3">
            {nodes.map((node) => (
              <FleetNodeCard key={node.id} node={node} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="brand-card flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-2xl bg-[var(--surface-soft)] text-[var(--text-muted)]">
        {icon}
      </span>
      <h2 className="brand-title text-lg font-semibold text-[var(--foreground)]">{title}</h2>
      {body && <p className="max-w-md text-sm text-[var(--text-secondary)]">{body}</p>}
    </div>
  );
}
