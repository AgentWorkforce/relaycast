'use client';

import { Server, Cpu, Boxes, Clock, Tag, Activity } from 'lucide-react';
import { cn } from '../lib/utils';
import type { NodeRosterEntry } from '@relaycast/sdk';

function relativeTime(timestamp: string | null): string {
  if (!timestamp) return 'never';
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function nodeStatus(node: NodeRosterEntry): { text: string; color: string; dot: string } {
  if (node.live) return { text: 'Online', color: 'text-emerald-500', dot: 'bg-emerald-500' };
  if (node.status === 'online') return { text: 'Stale', color: 'text-amber-500', dot: 'bg-amber-500' };
  return { text: 'Offline', color: 'text-[var(--text-faint)]', dot: 'bg-stone-400' };
}

function capabilityLabel(capability: NodeRosterEntry['capabilities'][number]): string {
  return typeof capability === 'string' ? capability : capability.name;
}

export function FleetNodeCard({ node }: { node: NodeRosterEntry }) {
  const status = nodeStatus(node);
  const capacityLabel = node.maxAgents > 0 ? `${node.activeAgents} / ${node.maxAgents}` : `${node.activeAgents}`;
  const loadPct = Math.max(0, Math.min(100, Math.round(node.load * 100)));

  return (
    <div className="brand-card flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[var(--brand-primary-faint)] text-[var(--brand-primary)]">
            <Server className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="brand-title truncate text-base font-semibold text-[var(--foreground)]">{node.name}</h3>
            <p className="truncate text-xs text-[var(--text-muted)]">v{node.version}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className={cn('h-2.5 w-2.5 rounded-full', status.dot, node.live && 'shadow-[0_0_0_4px_rgba(16,185,129,0.16)]')} />
          <span className={cn('text-xs font-medium', status.color)}>{status.text}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat icon={<Boxes className="h-3.5 w-3.5" />} label="Agents" value={capacityLabel} />
        <Stat icon={<Clock className="h-3.5 w-3.5" />} label="Heartbeat" value={relativeTime(node.lastHeartbeatAt)} />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-[var(--text-muted)]">
          <span className="flex items-center gap-1.5"><Activity className="h-3.5 w-3.5" /> Load</span>
          <span>{loadPct}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-soft)]">
          <div
            className={cn('h-full rounded-full transition-all', loadPct >= 85 ? 'bg-rose-500' : loadPct >= 60 ? 'bg-amber-500' : 'bg-emerald-500')}
            style={{ width: `${loadPct}%` }}
          />
        </div>
      </div>

      <div>
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
          <Cpu className="h-3.5 w-3.5" /> Capabilities
        </p>
        {node.capabilities.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {node.capabilities.map((capability) => (
              <span
                key={capabilityLabel(capability)}
                className="rounded-lg bg-[var(--surface-soft)] px-2 py-1 text-xs text-[var(--text-secondary)] ring-1 ring-[var(--border-default)]"
              >
                {capabilityLabel(capability)}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-[var(--text-faint)]">No capabilities advertised</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--border-default)] pt-3 text-xs text-[var(--text-muted)]">
        <span className="flex items-center gap-1.5">
          <span className={cn('h-1.5 w-1.5 rounded-full', node.handlersLive ? 'bg-emerald-500' : 'bg-stone-400')} />
          Handlers {node.handlersLive ? 'live' : 'down'}
        </span>
        {node.tags.length > 0 && (
          <span className="flex items-center gap-1.5">
            <Tag className="h-3 w-3" />
            {node.tags.join(', ')}
          </span>
        )}
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="brand-soft flex items-center gap-2.5 px-3 py-2">
      <span className="shrink-0 text-[var(--brand-primary)]">{icon}</span>
      <div className="min-w-0">
        <p className="text-[11px] text-[var(--text-muted)]">{label}</p>
        <p className="truncate text-sm text-[var(--foreground)]">{value}</p>
      </div>
    </div>
  );
}
