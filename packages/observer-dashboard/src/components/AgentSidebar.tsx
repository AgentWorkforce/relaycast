'use client';

import { useEffect, useState } from 'react';
import { Hash, MessageSquare, LogOut, Sun, Moon } from 'lucide-react';
import { cn, formatDmLabel } from '../lib/utils';
import { AgentAvatar } from './AgentAvatar';
import { clearAuth } from '../lib/auth';
import { useRouter } from 'next/navigation';
import type { Agent, Channel, DmConversationSummary } from '@relaycast/sdk';

type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

interface AgentSidebarProps {
  channels: Channel[];
  agents: Agent[];
  conversations: DmConversationSummary[];
  selectedChannel: string | null;
  selectedAgent: string | null;
  unreadChannelCounts: Record<string, number>;
  wsStatus: ConnectionStatus;
  onSelectChannel: (name: string | null) => void;
  onSelectAgent: (name: string | null) => void;
}

function statusColor(status: string) {
  switch (status) {
    case 'online':
      return 'bg-green-500';
    case 'idle':
      return 'bg-amber-500';
    default:
      return 'bg-stone-400';
  }
}

function getTheme(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'dark';
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'dark' || explicit === 'light') {
    return explicit;
  }
  return document.documentElement.classList.contains('theme-dark') ? 'dark' : 'light';
}

export function AgentSidebar({
  channels,
  agents,
  conversations,
  selectedChannel,
  selectedAgent,
  unreadChannelCounts,
  wsStatus,
  onSelectChannel,
  onSelectAgent,
}: AgentSidebarProps) {
  const router = useRouter();
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    setTheme(getTheme());
  }, []);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    const el = document.documentElement;
    el.classList.add('theme-transitioning');
    el.dataset.theme = next;
    el.style.colorScheme = next;
    el.classList.remove('theme-dark', 'theme-light', 'dark', 'light');
    el.classList.add(next === 'dark' ? 'theme-dark' : 'theme-light', next);
    try {
      localStorage.setItem('agentrelay-theme', next);
    } catch (error) {}
    setTheme(next);
    setTimeout(() => el.classList.remove('theme-transitioning'), 300);
  }

  async function handleLogout() {
    await clearAuth();
    router.push('/login');
  }

  return (
    <aside className="brand-glass m-3 mr-0 flex w-[290px] shrink-0 flex-col overflow-hidden">
      <div className="border-b border-[var(--border-default)] px-5 py-4">
        <div className="mb-1 flex items-center gap-3">
          <img
            src="/observer/brand/agent-relay-mark.svg"
            alt="Agent Relay"
            className="h-6 w-auto shrink-0"
          />
          <div className="min-w-0 flex-1">
            <div className="brand-kicker">Operator Console</div>
            <h1 className="brand-title truncate text-base font-bold"><span className="observer-wordmark">Observer</span></h1>
          </div>
          <span
            className={cn('h-2.5 w-2.5 rounded-full shrink-0', {
              'bg-green-500 shadow-[0_0_0_4px_rgba(57,197,143,0.16)]': wsStatus === 'connected',
              'bg-amber-500 animate-pulse shadow-[0_0_0_4px_rgba(245,158,11,0.14)]': wsStatus === 'connecting' || wsStatus === 'reconnecting',
              'bg-rose-500 shadow-[0_0_0_4px_rgba(244,63,94,0.14)]': wsStatus === 'disconnected',
            })}
            title={`WebSocket: ${wsStatus}`}
          />
        </div>
        <p className="text-xs leading-5 text-[var(--text-secondary)]">Channels, DMs, and active agents with brighter observer accents across the control surface.</p>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        <SidebarSection title="Channels">
          {channels.map((ch) => (
            <button
              key={ch.id}
              onClick={() => {
                onSelectAgent(null);
                onSelectChannel(selectedChannel === ch.name ? null : ch.name);
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-sm transition-all',
                selectedChannel === ch.name
                  ? 'bg-[var(--brand-primary-faint)] text-[var(--foreground)] ring-1 ring-[var(--border-strong)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--color-sidebar-hover)] hover:text-[var(--foreground)]',
                ch.isArchived && 'opacity-70',
              )}
            >
              <Hash className="h-3.5 w-3.5 shrink-0 opacity-70" />
              <span className="flex-1 truncate text-left">{ch.name}</span>
              {(unreadChannelCounts[ch.name] ?? 0) > 0 && (
                <span className="rounded-full bg-[var(--brand-warm)] px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  {unreadChannelCounts[ch.name]}
                </span>
              )}
            </button>
          ))}
          {channels.length === 0 && <EmptyLine>No channels</EmptyLine>}
        </SidebarSection>

        {conversations.length > 0 && (
          <SidebarSection title="Direct Messages">
            {conversations.map((dm) => {
              const dmKey = `dm:${dm.id}`;
              const dmLabel = formatDmLabel(dm.participants, dm.name);
              return (
                <button
                  key={dm.id}
                  onClick={() => {
                    onSelectAgent(null);
                    onSelectChannel(selectedChannel === dmKey ? null : dmKey);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-sm transition-all',
                    selectedChannel === dmKey
                      ? 'bg-[var(--brand-primary-faint)] text-[var(--foreground)] ring-1 ring-[var(--border-strong)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--color-sidebar-hover)] hover:text-[var(--foreground)]',
                  )}
                >
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="flex-1 truncate text-left">{dmLabel}</span>
                  {dm.unreadCount > 0 && (
                    <span className="rounded-full bg-[var(--surface-soft)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                      {dm.unreadCount}
                    </span>
                  )}
                </button>
              );
            })}
          </SidebarSection>
        )}

        <SidebarSection title="Agents">
          {agents.map((agent) => (
            <button
              key={agent.name}
              onClick={() => {
                onSelectAgent(selectedAgent === agent.name ? null : agent.name);
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-sm transition-all',
                selectedAgent === agent.name
                  ? 'bg-[var(--brand-primary-faint)] text-[var(--foreground)] ring-1 ring-[var(--border-strong)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--color-sidebar-hover)] hover:text-[var(--foreground)]',
              )}
            >
              <AgentAvatar name={agent.name} size="sm" />
              <span className="flex-1 truncate text-left">{agent.name}</span>
              <span className={cn('h-2 w-2 rounded-full shrink-0', statusColor(agent.status))} />
            </button>
          ))}
          {agents.length === 0 && <EmptyLine>No agents</EmptyLine>}
        </SidebarSection>
      </div>

      <div className="border-t border-[var(--border-default)] px-3 py-3">
        <button
          onClick={toggleTheme}
          className="flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--color-sidebar-hover)] hover:text-[var(--foreground)]"
        >
          {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>
        <button
          onClick={handleLogout}
          className="mt-1 flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--color-sidebar-hover)] hover:text-[var(--foreground)]"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </div>
    </aside>
  );
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">{title}</div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="px-3 text-xs text-[var(--text-faint)]">{children}</p>;
}
