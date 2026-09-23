'use client';

import { CheckCircle2, ChevronRight, Circle, Loader2, PauseCircle, Workflow, XCircle } from 'lucide-react';
import { cn } from '../lib/utils';
import { stepColumns, type RelayflowRun, type RelayflowStep, type RelayflowStepState } from '../lib/relayflow-run';

const STATE_STYLE: Record<RelayflowStepState, { icon: typeof Circle; tone: string }> = {
  pending: { icon: Circle, tone: 'border-[var(--border-default)] text-[var(--text-faint)]' },
  running: { icon: Loader2, tone: 'border-[var(--brand-primary)] text-[var(--brand-primary-strong)] bg-[var(--brand-primary-faint)]' },
  completed: { icon: CheckCircle2, tone: 'border-[var(--status-success)] text-[var(--status-success)] bg-[var(--status-success-soft)]' },
  failed: { icon: XCircle, tone: 'border-[var(--status-danger)] text-[var(--status-danger)] bg-[var(--status-danger-soft)]' },
  parked: { icon: PauseCircle, tone: 'border-[var(--status-warning)] text-[var(--status-warning)] bg-[var(--status-warning-soft)]' },
};

const RUN_TONE: Record<string, string> = {
  running: 'text-[var(--brand-primary-strong)]',
  completed: 'text-[var(--status-success)]',
  failed: 'text-[var(--status-danger)]',
  canceled: 'text-[var(--status-danger)]',
  parked: 'text-[var(--status-warning)]',
};

/** The run's step graph, drawn from the newest snapshot its channel carries. */
export function RunPanel({ run }: { run: RelayflowRun }) {
  const done = run.steps.filter(step => step.state === 'completed').length;
  const columns = stepColumns(run.steps);
  return (
    <div className="sticky top-0 z-10 border-b border-[var(--border-default)] bg-[var(--surface-card)] px-5 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Workflow className="h-4 w-4 text-[var(--brand-primary)]" />
        <span className="font-semibold text-[var(--foreground)]">{run.flow}</span>
        <span className={cn('brand-pill text-[11px] font-medium uppercase tracking-[0.16em]', RUN_TONE[run.status])}>
          {run.status}
        </span>
        {run.completionReason && run.completionReason !== 'success' && (
          <span className="text-xs text-[var(--status-danger)]">{run.completionReason}</span>
        )}
        <span className="ml-auto text-xs text-[var(--text-muted)]">
          {done}/{run.steps.length} steps · <span className="font-mono">{run.runId}</span>
        </span>
      </div>
      {columns.length > 0 && (
        <div className="mt-3 flex items-start gap-2 overflow-x-auto pb-1">
          {columns.map((column, index) => (
            <div key={index} className="flex items-center gap-2">
              {index > 0 && <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-faint)]" />}
              <div className="flex flex-col gap-1.5">
                {column.map(step => <StepChip key={step.id} step={step} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StepChip({ step }: { step: RelayflowStep }) {
  const { icon: Icon, tone } = STATE_STYLE[step.state];
  const detail = [
    step.type,
    step.elapsedMs === undefined ? undefined : formatElapsed(step.elapsedMs),
    step.attempt !== undefined && step.attempt > 1 ? `attempt ${step.attempt}` : undefined,
  ].filter(Boolean).join(' · ');
  return (
    <div
      className={cn('flex min-w-[9rem] items-center gap-2 rounded-xl border px-2.5 py-1.5', tone)}
      title={step.completionReason ? `completionReason: ${step.completionReason}` : undefined}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', step.state === 'running' && 'animate-spin')} />
      <div className="min-w-0">
        <div className="truncate text-xs font-semibold text-[var(--foreground)]">{step.id}</div>
        <div className="truncate text-[11px] opacity-80">{detail}</div>
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}
