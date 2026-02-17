'use client';

import { cn } from '../lib/utils';

const COLORS = [
  'bg-cyan-600',
  'bg-orange-600',
  'bg-purple-600',
  'bg-green-600',
  'bg-rose-600',
  'bg-amber-600',
  'bg-indigo-600',
  'bg-teal-600',
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
        'inline-flex items-center justify-center rounded-lg font-semibold text-white shrink-0',
        size === 'sm' ? 'h-6 w-6 text-xs' : 'h-8 w-8 text-sm',
        color,
        className
      )}
    >
      {letter}
    </div>
  );
}
