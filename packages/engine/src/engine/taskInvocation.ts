import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { FleetTaskContextSchema, type FleetActionAcceptMessage, type FleetActionResultMessage } from '@relaycast/types';
import { actionInvocations, type TaskInvocationState } from '../db/schema.js';
import type { EngineDb } from '../ports/database.js';
import { codedError } from '../lib/httpError.js';

type Invocation = typeof actionInvocations.$inferSelect;
const liveStates = ['pending', 'dispatched', 'running'];

/** Stored in the same insert as the idempotent invocation claim. */
export function createTaskState(input: Record<string, unknown>): TaskInvocationState {
  const parsed = FleetTaskContextSchema.safeParse(input.task_context);
  if (!parsed.success) throw codedError('Task actions require valid input.task_context', 'invalid_task_context', 400);
  return { ...parsed.data, deadline: new Date(Date.now() + parsed.data.timeout_ms).toISOString() };
}

export function taskExecution(row: Pick<Invocation, 'id' | 'dispatchAttempts' | 'taskState'>) {
  const task = row.taskState;
  if (!task) return undefined;
  return {
    execution_id: task.execution_id ?? `${row.id}/${row.dispatchAttempts}`,
    run_id: task.run_id,
    step_id: task.step_id,
    dispatch_id: task.dispatch_id,
    deadline: task.deadline,
    ...(task.worker_generation ? { worker_generation: task.worker_generation } : {}),
    ...(task.accepted_at ? { accepted_at: task.accepted_at } : {}),
    ...(task.accounting ? { accounting: task.accounting } : {}),
  };
}

function receipt(row: Invocation) {
  return {
    invocation_id: row.id,
    action_name: row.actionName,
    status: row.status,
    task_execution: taskExecution(row),
    output: row.output,
    error: row.error,
    completed_at: row.completedAt?.toISOString() ?? null,
  };
}

async function read(db: EngineDb, workspaceId: string, invocationId: string) {
  const [row] = await db.select().from(actionInvocations).where(and(
    eq(actionInvocations.workspaceId, workspaceId), eq(actionInvocations.id, invocationId),
  ));
  return row;
}

function owner(row: Invocation | undefined, nodeId: string, provider: string) {
  if (!row?.taskState || row.dispatchedNodeId !== nodeId || row.dispatchedProvider !== provider) {
    throw codedError('Task execution is not owned by this provider', 'task_not_found', 404);
  }
  return row;
}

function fence(row: Invocation, executionId: string, generation: string) {
  if (taskExecution(row)!.execution_id !== executionId
    || (row.taskState!.worker_generation !== undefined && row.taskState!.worker_generation !== generation)) {
    throw codedError('Task execution fence or worker generation changed', 'stale_task_execution', 409);
  }
}

export async function expireTaskInvocation(db: EngineDb, row: Invocation): Promise<Invocation> {
  if (!row.taskState || !liveStates.includes(row.status) || row.taskState.deadline > new Date().toISOString()) return row;
  const [updated] = await db.update(actionInvocations).set({
    status: 'failed', error: 'task_deadline_exceeded', completedAt: new Date(),
  }).where(and(
    eq(actionInvocations.id, row.id), eq(actionInvocations.workspaceId, row.workspaceId),
    inArray(actionInvocations.status, liveStates),
    sql`json_extract(${actionInvocations.taskState}, '$.deadline') <= ${new Date().toISOString()}`,
  )).returning();
  return updated ?? (await read(db, row.workspaceId, row.id))!;
}

/** Replaying accept reconciles the same generation, including its terminal receipt. */
export async function acceptTaskInvocation(
  db: EngineDb, workspaceId: string, nodeId: string, provider: string, message: FleetActionAcceptMessage,
) {
  let row = owner(await read(db, workspaceId, message.invocation_id), nodeId, provider);
  fence(row, message.execution_id, message.worker_generation);
  row = await expireTaskInvocation(db, row);
  if (row.status === 'completed' || row.status === 'failed' || row.status === 'running') {
    return { ...receipt(row), newly_accepted: false };
  }
  const state: TaskInvocationState = {
    ...row.taskState!, execution_id: message.execution_id,
    worker_generation: message.worker_generation, accepted_at: new Date().toISOString(),
  };
  const [accepted] = await db.update(actionInvocations).set({ status: 'running', taskState: state }).where(and(
    eq(actionInvocations.id, row.id), eq(actionInvocations.workspaceId, workspaceId),
    eq(actionInvocations.status, 'dispatched'), eq(actionInvocations.dispatchedNodeId, nodeId),
    eq(actionInvocations.dispatchedProvider, provider), eq(actionInvocations.dispatchAttempts, row.dispatchAttempts),
    sql`json_extract(${actionInvocations.taskState}, '$.worker_generation') IS NULL`,
    sql`json_extract(${actionInvocations.taskState}, '$.deadline') > ${new Date().toISOString()}`,
  )).returning();
  if (accepted) return { ...receipt(accepted), newly_accepted: true };
  row = owner(await read(db, workspaceId, row.id), nodeId, provider);
  fence(row, message.execution_id, message.worker_generation);
  if (['running', 'completed', 'failed'].includes(row.status)) return { ...receipt(row), newly_accepted: false };
  throw codedError('Task is not in the dispatched execution', 'task_not_dispatched', 409);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(
    key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
  ).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Returns undefined only for a legacy short action. A task always needs a durable reply. */
export async function completeTaskInvocation(
  db: EngineDb, workspaceId: string, nodeId: string, provider: string, message: FleetActionResultMessage,
) {
  const candidate = await read(db, workspaceId, message.invocation_id);
  if (!candidate?.taskState) {
    if (message.execution_id || message.worker_generation || message.final !== undefined || message.accounting) {
      throw codedError('Task result fields require a task invocation', 'task_not_found', 404);
    }
    return undefined;
  }
  if (!message.id || !message.execution_id || !message.worker_generation || message.final === undefined) {
    throw codedError('Task results require id, execution_id, worker_generation and final', 'invalid_task_result', 400);
  }
  let row = owner(candidate, nodeId, provider);
  fence(row, message.execution_id, message.worker_generation);
  row = await expireTaskInvocation(db, row);
  if (!row.taskState!.accepted_at) throw codedError('Task must be accepted before reporting results', 'task_not_accepted', 409);
  if (!message.final) return { receipt: receipt(row), completed: undefined };
  if (message.error !== undefined && !message.error.trim()) throw codedError('Task failure must name a reason', 'invalid_task_result', 400);
  const output = message.output ?? null;
  const error = message.error ?? null;
  const status = error === null ? 'completed' : 'failed';
  const matches = (value: Invocation) => value.status === status
    && canonical(value.output) === canonical(output) && value.error === error
    && canonical(value.taskState?.accounting) === canonical(message.accounting);
  if (row.status === 'completed' || row.status === 'failed') {
    if (!matches(row)) throw codedError('Task already has a different terminal result', 'task_result_conflict', 409);
    return { receipt: receipt(row), completed: undefined };
  }
  const [completed] = await db.update(actionInvocations).set({
    status, output, error, completedAt: new Date(),
    taskState: { ...row.taskState!, ...(message.accounting ? { accounting: message.accounting } : {}) },
  }).where(and(
    eq(actionInvocations.id, row.id), eq(actionInvocations.workspaceId, workspaceId),
    eq(actionInvocations.status, 'running'), eq(actionInvocations.dispatchedNodeId, nodeId),
    eq(actionInvocations.dispatchedProvider, provider), eq(actionInvocations.dispatchAttempts, row.dispatchAttempts),
    sql`json_extract(${actionInvocations.taskState}, '$.execution_id') = ${message.execution_id}`,
    sql`json_extract(${actionInvocations.taskState}, '$.worker_generation') = ${message.worker_generation}`,
    sql`json_extract(${actionInvocations.taskState}, '$.deadline') > ${new Date().toISOString()}`,
  )).returning();
  if (completed) return { receipt: receipt(completed), completed };
  row = owner(await read(db, workspaceId, row.id), nodeId, provider);
  fence(row, message.execution_id, message.worker_generation);
  if (matches(row)) return { receipt: receipt(row), completed: undefined };
  throw codedError('Task completion lost its state transition', 'task_result_conflict', 409);
}

/** Absolute deadline bounds both never-accepted dispatches and accepted tasks with no final result. */
export async function expireTaskInvocations(db: EngineDb): Promise<void> {
  await db.update(actionInvocations).set({
    status: 'failed', error: 'task_deadline_exceeded', completedAt: new Date(),
  }).where(and(
    isNotNull(actionInvocations.taskState), inArray(actionInvocations.status, liveStates),
    sql`json_extract(${actionInvocations.taskState}, '$.deadline') <= ${new Date().toISOString()}`,
  ));
}
