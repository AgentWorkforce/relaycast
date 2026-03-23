'use client';

import { X, Bot, User, Clock, Cpu, CircleDot, Sparkles } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { cn } from '../lib/utils';
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
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function statusLabel(status: string) {
  switch (status) {
    case 'online':
      return { text: 'Online', color: 'text-green-400', dot: 'bg-green-500' };
    case 'idle':
      return { text: 'Idle', color: 'text-yellow-400', dot: 'bg-yellow-500' };
    case 'away':
      return { text: 'Away', color: 'text-yellow-400', dot: 'bg-yellow-500' };
    default:
      return { text: 'Offline', color: 'text-[var(--color-text-dim)]', dot: 'bg-gray-500' };
  }
}

interface AgentPanelProps {
  agent: Agent;
  onClose: () => void;
  className?: string;
}

export function AgentPanel({ agent, onClose, className }: AgentPanelProps) {
  const status = statusLabel(agent.status);
  const cli = (agent.metadata?.cli as string) || (agent.metadata?.spawn as Record<string, unknown>)?.cli as string || 'unknown';
  const model = (agent.metadata?.model as string) || '';
  const currentTask = (agent.metadata?.current_task as string) || '';
  const identityLabel = agent.type === 'human' ? 'Human' : agent.type === 'system' ? 'System' : 'Agent';
  const identityIcon = agent.type === 'human'
    ? <User className="h-3.5 w-3.5" />
    : agent.type === 'system'
      ? <Sparkles className="h-3.5 w-3.5" />
      : <Bot className="h-3.5 w-3.5" />;

  const extraMeta = Object.entries(agent.metadata || {}).filter(
    ([key]) => !['cli', 'current_task', 'model'].includes(key)
  );

  return (
    <div className={cn('flex h-full w-full min-w-0 flex-col bg-[var(--color-bg-primary)] lg:w-[360px] lg:shrink-0 lg:border-l lg:border-[var(--color-border-default)]', className)}>
      <div className="flex min-h-14 items-center justify-between border-b border-[var(--color-border-default)] px-4 py-3 shrink-0">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Agent Profile</h2>
        <button
          onClick={onClose}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="flex flex-col items-center px-4 pb-4 pt-6 text-center">
          <AgentAvatar name={agent.name} size="md" className="mb-3 h-14 w-14 text-xl" />
          <h3 className="break-words text-lg font-bold text-[var(--color-text-primary)]">{agent.name}</h3>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-1.5 text-center">
            <span className={`h-2 w-2 rounded-full ${status.dot}`} />
            <span className={`text-xs ${status.color}`}>{status.text}</span>
            <span className="mx-1 text-xs text-[var(--color-text-dim)]">&middot;</span>
            <span className="text-xs text-[var(--color-text-muted)]">{identityLabel}</span>
          </div>
        </div>

        {agent.persona && (
          <div className="px-4 pb-4">
            <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--color-text-secondary)]">
              {agent.persona}
            </p>
          </div>
        )}

        <div className="mx-4 border-t border-[var(--color-border-subtle)]" />

        <div className="space-y-4 px-4 py-4">
          {currentTask && (
            <InfoRow
              icon={<CircleDot className="h-3.5 w-3.5" />}
              label="Current task"
              value={currentTask}
            />
          )}
          <InfoRow
            icon={<Cpu className="h-3.5 w-3.5" />}
            label="CLI"
            value={cli}
          />
          {model && (
            <InfoRow
              icon={<Sparkles className="h-3.5 w-3.5" />}
              label="Model"
              value={model}
            />
          )}
          <InfoRow
            icon={<Clock className="h-3.5 w-3.5" />}
            label="Last seen"
            value={relativeTime(agent.lastSeen)}
          />
          <InfoRow
            icon={identityIcon}
            label="Created"
            value={formatDate(agent.createdAt ?? agent.lastSeen)}
          />
        </div>

        {extraMeta.length > 0 && (
          <>
            <div className="mx-4 border-t border-[var(--color-border-subtle)]" />
            <div className="px-4 py-4">
              <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Metadata
              </h4>
              <div className="space-y-3">
                {extraMeta.map(([key, value]) => (
                  <div key={key} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-2">
                    <span className="shrink-0 text-xs text-[var(--color-text-muted)] sm:min-w-[96px]">{key}</span>
                    <span className="break-all text-xs leading-5 text-[var(--color-text-secondary)]">
                      {typeof value === 'string' ? value : JSON.stringify(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0 text-[var(--color-text-muted)]">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-[var(--color-text-muted)]">{label}</p>
        <p className="break-words text-sm leading-6 text-[var(--color-text-primary)]">{value}</p>
      </div>
    </div>
  );
}
