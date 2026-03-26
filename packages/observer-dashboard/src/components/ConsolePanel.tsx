'use client';

import { ActivityLog } from './ActivityLog';
import { cn } from '../lib/utils';

export function ConsolePanel({ className }: { className?: string }) {
  return (
    <aside className={cn('console-surface flex w-[440px] shrink-0 flex-col overflow-hidden', className)}>
      <ActivityLog className="w-full border-l-0 border-none bg-transparent" />
    </aside>
  );
}
