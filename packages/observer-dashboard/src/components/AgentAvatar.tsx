'use client';

import { cn } from '../lib/utils';

const COLORS = [
  'from-sky-500 to-sky-700',
  'from-orange-400 to-orange-600',
  'from-violet-500 to-violet-700',
  'from-emerald-500 to-emerald-700',
  'from-rose-500 to-rose-700',
  'from-amber-400 to-amber-600',
  'from-indigo-500 to-indigo-700',
  'from-teal-500 to-teal-700',
];

function hashName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

interface AgentAvatarProps {
  name: string;
  className?: string;
  size?: 'sm' | 'md';
}

export function AgentAvatar({ name, className, size = 'md' }: AgentAvatarProps) {
  const color = COLORS[hashName(name) % COLORS.length];
  const letter = name.charAt(0).toUpperCase();

  return (
    <div
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] ring-1 ring-black/5',
        size === 'sm' ? 'h-7 w-7 text-xs' : 'h-9 w-9 text-sm',
        color,
        className,
      )}
    >
      {letter}
    </div>
  );
}
