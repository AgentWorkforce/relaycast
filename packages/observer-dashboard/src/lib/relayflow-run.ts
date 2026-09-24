/**
 * A relayflow run projects itself into its `wf-<runId>` channel: every message
 * carries the whole run snapshot under `metadata.relayflow` (version 1). The
 * newest valid snapshot is the run's current state. Metadata is caller-authored,
 * so it is parsed field by field and anything malformed is ignored.
 */

import type { MessageWithMeta } from '@relaycast/sdk';

export type RelayflowStepState = 'pending' | 'running' | 'completed' | 'failed' | 'parked';

export interface RelayflowStep {
  id: string;
  type: string;
  dependsOn: string[];
  state: RelayflowStepState;
  attempt?: number;
  elapsedMs?: number;
  completionReason?: string;
}

export interface RelayflowRun {
  runId: string;
  flow: string;
  status: string;
  completionReason?: string;
  steps: RelayflowStep[];
}

const STATES = new Set<string>(['pending', 'running', 'completed', 'failed', 'parked']);

/**
 * Return the newest valid run snapshot among `messages`, regardless of array
 * or delivery order. Relaycast message IDs are sortable snowflakes, so their
 * server-assigned order is authoritative even under replay or clock skew.
 */
export function latestRelayflowRun(messages: readonly MessageWithMeta[]): RelayflowRun | null {
  let latest: { id: string; run: RelayflowRun } | null = null;
  for (const message of messages) {
    const run = parseRun((message.metadata as Record<string, unknown> | undefined)?.relayflow);
    if (run === null) continue;
    if (latest === null || compareIds(message.id, latest.id) > 0) {
      latest = { id: message.id, run };
    }
  }
  return latest?.run ?? null;
}

/** Compare decimal snowflake IDs without losing precision to Number. */
function compareIds(a: string, b: string): number {
  return a.length === b.length ? a.localeCompare(b) : a.length - b.length;
}

/** Parse the closed relayflow v1 run projection, ignoring invalid snapshots. */
function parseRun(value: unknown): RelayflowRun | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.run)) return null;
  const run = value.run;
  if (typeof run.runId !== 'string' || typeof run.flow !== 'string' || typeof run.status !== 'string'
    || !Array.isArray(run.steps)) return null;
  return {
    runId: run.runId,
    flow: run.flow,
    status: run.status,
    ...(typeof run.completionReason === 'string' ? { completionReason: run.completionReason } : {}),
    steps: run.steps.flatMap(parseStep),
  };
}

/** Parse one relayflow v1 step, returning no value for a malformed step. */
function parseStep(value: unknown): RelayflowStep[] {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.state !== 'string'
    || !STATES.has(value.state)) return [];
  return [{
    id: value.id,
    type: typeof value.type === 'string' ? value.type : 'step',
    dependsOn: Array.isArray(value.dependsOn) ? value.dependsOn.filter((id): id is string => typeof id === 'string') : [],
    state: value.state as RelayflowStepState,
    ...(typeof value.attempt === 'number' ? { attempt: value.attempt } : {}),
    ...(typeof value.elapsedMs === 'number' ? { elapsedMs: value.elapsedMs } : {}),
    ...(typeof value.completionReason === 'string' ? { completionReason: value.completionReason } : {}),
  }];
}

/**
 * Group steps into columns by dependency depth, preserving declaration order
 * within a column. A dependency that names no known step, or a cycle, counts
 * as depth 0 rather than hiding the step.
 */
export function stepColumns(steps: readonly RelayflowStep[]): RelayflowStep[][] {
  const byId = new Map(steps.map(step => [step.id, step]));
  const cyclic = findCyclicSteps(byId);
  const depth = new Map<string, number>();
  const visit = (step: RelayflowStep): number => {
    if (cyclic.has(step.id)) return 0;
    const known = depth.get(step.id);
    if (known !== undefined) return known;
    const parents = step.dependsOn.map(id => byId.get(id)).filter((parent): parent is RelayflowStep => parent !== undefined);
    const value = parents.length === 0 ? 0 : 1 + Math.max(...parents.map(visit));
    depth.set(step.id, value);
    return value;
  };
  const columns: RelayflowStep[][] = [];
  for (const step of steps) (columns[visit(step)] ??= []).push(step);
  return columns.filter(column => column !== undefined);
}

/** Find every step participating in a dependency cycle. */
function findCyclicSteps(byId: ReadonlyMap<string, RelayflowStep>): Set<string> {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];
  const cyclic = new Set<string>();

  const visit = (step: RelayflowStep): void => {
    if (visited.has(step.id)) return;
    if (visiting.has(step.id)) {
      const start = path.lastIndexOf(step.id);
      for (const id of path.slice(start)) cyclic.add(id);
      return;
    }
    visiting.add(step.id);
    path.push(step.id);
    for (const dependencyId of step.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (dependency) visit(dependency);
    }
    path.pop();
    visiting.delete(step.id);
    visited.add(step.id);
  };

  for (const step of byId.values()) visit(step);
  return cyclic;
}

/** Narrow unknown metadata containers to plain records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
