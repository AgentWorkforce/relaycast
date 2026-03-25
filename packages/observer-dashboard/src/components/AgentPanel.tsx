'use client';

import { X, Bot, User, Clock, Cpu, CircleDot, Sparkles } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import type { Agent } from '@relaycast/sdk';

function relativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDate(timestamp: string | undefined | null): string {
  if (!timestamp) return 'Unknown';
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function statusLabel(status: string) {
  switch (status) {
    case 'online':
      return { text: 'Online', color: 'text-emerald-500', dot: 'bg-emerald-500' };
    case 'idle':
    case 'away':
      return { text: 'Idle', color: 'text-amber-500', dot: 'bg-amber-500' };
    default:
      return { text: 'Offline', color: 'text-[var(--text-faint)]', dot: 'bg-stone-400' };
  }
}

interface AgentPanelProps {
  agent: Agent;
  onClose: () => void;
}

export function AgentPanel({ agent, onClose }: AgentPanelProps) {
  const status = statusLabel(agent.status);
  const cli = (agent.metadata?.cli as string) || (agent.metadata?.spawn as Record<string, unknown>)?.cli as string || 'unknown';
  const model = (agent.metadata?.model as string) || '';
  const currentTask = (agent.metadata?.current_task as string) || '';
  const identityLabel = agent.type === 'human' ? 'Human' : agent.type === 'system' ? 'System' : 'Agent';
  const identityIcon = agent.type === 'human' ? <User className="h-3.5 w-3.5" /> : agent.type === 'system' ? <Sparkles className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />;
  const extraMeta = Object.entries(agent.metadata || {}).filter(([key]) => !['cli', 'current_task', 'model'].includes(key));

  return (
    <aside className="brand-card flex w-[380px] shrink-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--border-default)] px-5 py-4">
        <h2 className="brand-title text-base font-semibold text-[var(--foreground)]">Agent profile</h2>
        <button onClick={onClose} className="rounded-xl p-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-soft)] hover:text-[var(--foreground)]">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-6">
        <div className="flex flex-col items-center pb-5 text-center">
          <AgentAvatar name={agent.name} size="md" className="mb-3 h-16 w-16 text-xl" />
          <h3 className="brand-title text-xl font-bold text-[var(--foreground)]">{agent.name}</h3>
          <div className="mt-2 flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${status.dot}`} />
            <span className={`text-xs font-medium ${status.color}`}>{status.text}</span>
            <span className="text-xs text-[var(--text-faint)]">•</span>
            <span className="text-xs text-[var(--text-secondary)]">{identityLabel}</span>
          </div>
        </div>

        {agent.persona && <p className="pb-5 text-sm leading-6 text-[var(--text-secondary)] whitespace-pre-wrap">{agent.persona}</p>}

        <div className="space-y-3 border-t border-[var(--border-default)] pt-5">
          {currentTask && <InfoRow icon={<CircleDot className="h-3.5 w-3.5" />} label="Current task" value={currentTask} />}
          <InfoRow icon={<Cpu className="h-3.5 w-3.5" />} label="CLI" value={cli} />
          {model && <InfoRow icon={<Sparkles className="h-3.5 w-3.5" />} label="Model" value={model} />}
          <InfoRow icon={<Clock className="h-3.5 w-3.5" />} label="Last seen" value={relativeTime(agent.lastSeen)} />
          <InfoRow icon={identityIcon} label="Created" value={formatDate(agent.createdAt ?? agent.lastSeen)} />
        </div>

        {extraMeta.length > 0 && (
          <div className="mt-5 border-t border-[var(--border-default)] pt-5">
            <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">Metadata</h4>
            <div className="space-y-2">
              {extraMeta.map(([key, value]) => (
                <div key={key} className="brand-soft flex items-start gap-3 px-3 py-2">
                  <span className="min-w-[84px] text-xs text-[var(--text-muted)]">{key}</span>
                  <span className="break-all text-xs text-[var(--text-secondary)]">{typeof value === 'string' ? value : JSON.stringify(value)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="brand-soft flex items-start gap-3 px-3 py-3">
      <span className="mt-0.5 shrink-0 text-[var(--brand-primary)]">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-[var(--text-muted)]">{label}</p>
        <p className="break-words text-sm text-[var(--foreground)]">{value}</p>
      </div>
    </div>
  );
}
