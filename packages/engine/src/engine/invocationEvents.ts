import { and, eq, inArray, ne, or, sql, SQL } from 'drizzle-orm';
import type {
  ActionInvocationEvent,
  ActionInvocationRegisteredAgent,
  ActionInvocationRequeueReason,
  ActionResultRejectionReason,
} from '@relaycast/types';
import type { EngineDb } from '../ports/database.js';
import { actionInvocations, agents, nodes } from '../db/schema.js';

/** Mirrors agent.ts RELEASED_AGENT_STATUS without importing the agent engine. */
const RELEASED_AGENT_STATUS = 'released';

/**
 * Per-invocation lifecycle timeline.
 *
 * Every event lives in `action_invocations.events`, a JSON array capped at
 * {@link INVOCATION_EVENT_LIMIT} entries. State transitions append their event
 * in the same UPDATE that makes the transition, so the timeline cannot claim a
 * transition the row did not take. Observations that change no state (an
 * agent registering, a rejected result) append on their own, best-effort.
 *
 * When the array is full the oldest event after the first is dropped: the
 * first event (normally `created`) is kept so the timeline always shows where
 * the invocation started.
 */
export const INVOCATION_EVENT_LIMIT = 50;
const MAX_EVENT_TEXT = 200;

type InvocationEventFields = Omit<ActionInvocationEvent, 'at' | 'type'>;

export function invocationEvent(type: string, fields: InvocationEventFields = {}): ActionInvocationEvent {
  const event: ActionInvocationEvent = { at: new Date().toISOString(), type };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    event[key] = typeof value === 'string' ? value.slice(0, MAX_EVENT_TEXT) : value;
  }
  return event;
}

/**
 * The `events` value that appends to the row's own timeline, for use inside
 * an UPDATE's SET. An SQL element must evaluate to a JSON object (for example
 * `json_set(json(?), '$.attempt', <expr>)`), which lets an event carry a value
 * only the row knows, such as the dispatch attempt number.
 */
export function appendInvocationEvents(...events: Array<ActionInvocationEvent | SQL>): SQL {
  // Trim before appending so each event is bound exactly once: statements that
  // already carry a D1-sized IN list cannot afford repeated parameters. The
  // stored array never exceeds the limit, so appending k events overflows it
  // by at most k; drop that many from index 1 (the first event is kept).
  const current = sql`COALESCE(${actionInvocations.events}, '[]')`;
  let trimmed: SQL = current;
  for (let overflow = 1; overflow <= events.length; overflow++) {
    const threshold = sql.raw(String(INVOCATION_EVENT_LIMIT - events.length + overflow));
    const removals = sql.raw(Array.from({ length: overflow }, () => "'$[1]'").join(', '));
    trimmed = sql`CASE WHEN json_array_length(${current}) >= ${threshold}
      THEN json_remove(${current}, ${removals}) ELSE ${trimmed} END`;
  }
  let appended = trimmed;
  for (const event of events) {
    const value = event instanceof SQL ? event : sql`json(${JSON.stringify(event)})`;
    appended = sql`json_insert(${appended}, '$[#]', ${value})`;
  }
  return appended;
}

/** A queued/dispatched event whose `attempt` is the row's attempt after this update. */
export function dispatchAttemptEvent(event: ActionInvocationEvent, incrementsAttempt: boolean): SQL {
  return sql`json_set(json(${JSON.stringify(event)}), '$.attempt',
    COALESCE(${actionInvocations.dispatchAttempts}, 0) + ${sql.raw(incrementsAttempt ? '1' : '0')})`;
}

/**
 * Append one event without changing state. Best-effort: a timeline write must
 * never fail the protocol step that observed it. `where` narrows which rows a
 * caller may annotate (e.g. only invocations dispatched to the calling node).
 */
export async function recordInvocationEvent(
  db: EngineDb,
  workspaceId: string,
  invocationId: string,
  event: ActionInvocationEvent | ActionInvocationEvent[],
  where: SQL[] = [],
): Promise<boolean> {
  const events = Array.isArray(event) ? event : [event];
  if (events.length === 0) return false;
  try {
    const updated = await db
      .update(actionInvocations)
      .set({ events: appendInvocationEvents(...events) })
      .where(and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocationId),
        ...where,
      ))
      .returning({ id: actionInvocations.id });
    return updated.length > 0;
  } catch {
    return false;
  }
}

/** Predicate: the invocation was placed on or dispatched to `nodeId` at some point. */
export function invocationTouchedNode(nodeId: string): SQL {
  return or(
    eq(actionInvocations.dispatchedNodeId, nodeId),
    eq(actionInvocations.handlerNodeId, nodeId),
    sql`EXISTS (SELECT 1 FROM json_each(COALESCE(${actionInvocations.attemptedNodeIds}, '[]')) WHERE value = ${nodeId})`,
  )!;
}

export interface InvocationRegisteredAgent extends ActionInvocationRegisteredAgent {
  session_ref: string | null;
}

/**
 * The non-released agent whose node registration named this invocation
 * (`metadata.fleet.invocation_id`). Looked up by the spawn's requested name and
 * by any agent ids the timeline recorded, so both lookups use an index.
 */
export async function registeredAgentForInvocation(
  db: EngineDb,
  workspaceId: string,
  invocationId: string,
  options: { agentName?: string | null; agentIds?: string[] } = {},
): Promise<InvocationRegisteredAgent | null> {
  const keys = [
    ...(options.agentName ? [eq(agents.name, options.agentName)] : []),
    ...(options.agentIds && options.agentIds.length > 0 ? [inArray(agents.id, options.agentIds)] : []),
  ];
  if (keys.length === 0) return null;
  const [row] = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      locationNodeId: agents.locationNodeId,
      sessionRef: agents.sessionRef,
      nodeId: sql<string | null>`json_extract(${agents.metadata}, '$.fleet.node_id')`,
      registeredAt: sql<string | null>`json_extract(${agents.metadata}, '$.fleet.registered_at')`,
    })
    .from(agents)
    .where(and(
      eq(agents.workspaceId, workspaceId),
      or(...keys),
      ne(agents.status, RELEASED_AGENT_STATUS),
      sql`json_extract(${agents.metadata}, '$.fleet.invocation_id') = ${invocationId}`,
    ))
    .limit(1);
  if (!row) return null;
  return {
    agent_id: row.id,
    name: row.name,
    status: row.status,
    // The node whose registration named this invocation, i.e. the node that launched it.
    node_id: row.nodeId ?? row.locationNodeId ?? null,
    registered_at: row.registeredAt ?? null,
    session_ref: row.sessionRef ?? null,
  };
}

export async function nodeNamesFor(db: EngineDb, workspaceId: string, nodeIds: Iterable<string>): Promise<Map<string, string>> {
  const ids = Array.from(new Set(nodeIds)).slice(0, 50);
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: nodes.id, name: nodes.name })
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), inArray(nodes.id, ids)));
  return new Map(rows.map((row) => [row.id, row.name]));
}

function clock(iso: string | null | undefined): string {
  if (!iso) return 'an unknown time';
  const time = /T(\d{2}:\d{2}:\d{2})/.exec(iso)?.[1];
  return time ? `${time} UTC` : iso;
}

export function requeueText(event: Pick<ActionInvocationEvent, 'reason' | 'detail'>): string {
  switch (event.reason as ActionInvocationRequeueReason | undefined) {
    case 'dispatch_timeout':
      return 'after no result arrived within the dispatch timeout';
    case 'node_lost':
      switch (event.detail) {
        case 'liveness_timeout': return "after the node's heartbeat went stale";
        case 'disconnected': return 'after the node disconnected';
        case 'deregistered': return 'after the node deregistered';
        default: return 'after the node was lost';
      }
    case 'inventory_missing':
      return "after the node's inventory did not list its agent";
    case 'handler_unavailable':
      return 'after the node reported handler_unavailable';
    case 'retry_due':
      return 'for another placement attempt';
    default:
      return event.reason ? `(${event.reason})` : '';
  }
}

export function rejectionText(
  event: ActionInvocationEvent,
  context: { lastRequeue?: ActionInvocationEvent; nodeName: (id: string | null | undefined) => string; currentNodeId?: string | null },
): string {
  switch (event.reason as ActionResultRejectionReason | undefined) {
    case 'not_dispatched':
      return context.lastRequeue
        ? `invocation was requeued at ${clock(context.lastRequeue.at)} ${requeueText(context.lastRequeue)}`.trimEnd()
        : 'invocation was not dispatched to any node when the result arrived';
    case 'dispatched_to_other_node':
      return context.currentNodeId
        ? `invocation had been dispatched to node ${context.nodeName(context.currentNodeId)} instead`
        : 'invocation had been dispatched to another node';
    case 'already_settled':
      return 'invocation had already finished';
    case 'wrong_provider':
      return 'it came from a different provider connection than the one that received the work';
    case 'state_changed':
      return 'invocation changed state while the result was being applied';
    case 'invalid_payload':
      return `the result frame was malformed${event.error ? ` (${event.error})` : ''}`;
    default:
      return event.reason ?? 'unknown reason';
  }
}

export interface ExplainInvocationInput {
  status: string;
  error: string | null;
  actionName: string;
  dispatchedNodeId: string | null;
  dispatchedAt: string | null;
  completedAt: string | null;
  retryAfterAt: string | null;
  events: ActionInvocationEvent[];
  nodeNames: Map<string, string>;
  registeredAgent: ActionInvocationRegisteredAgent | null;
}

function lastIndexOf(events: ActionInvocationEvent[], predicate: (event: ActionInvocationEvent) => boolean) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (predicate(events[index]!)) return index;
  }
  return -1;
}

function lastOf(events: ActionInvocationEvent[], predicate: (event: ActionInvocationEvent) => boolean) {
  const index = lastIndexOf(events, predicate);
  return index >= 0 ? events[index] : undefined;
}

/** One human sentence describing what happened to an invocation. */
export function explainInvocation(input: ExplainInvocationInput): string {
  const { events } = input;
  const nodeName = (id: string | null | undefined) => (id ? input.nodeNames.get(id) ?? id : 'unknown');
  const registration = lastOf(events, (event) => event.type === 'agent_registered');
  const agentName = registration?.agent_name ?? input.registeredAgent?.name;
  const agentNode = registration?.node_id ?? input.registeredAgent?.node_id ?? null;
  const registeredAt = registration?.at ?? input.registeredAgent?.registered_at ?? null;
  const launched = agentName
    ? `Node ${nodeName(agentNode)} launched agent ${agentName} (registered ${clock(registeredAt)})`
    : null;
  const lastRequeue = lastOf(events, (event) => event.type === 'requeued');
  const lastRejection = lastOf(events, (event) => event.type === 'result_rejected' && event.reason !== 'already_settled');
  const lastDispatch = lastOf(events, (event) => event.type === 'dispatched' || event.type === 'queued');
  const started = lastOf(events, (event) => event.type === 'started' && event.reason !== 'awaiting_readiness');
  // A readiness hold describes the current dispatch only if no later dispatch
  // or requeue superseded it.
  const holdIndex = lastIndexOf(events, (event) => event.type === 'started' && event.reason === 'awaiting_readiness');
  const dispatchIndex = lastIndexOf(events, (event) => (
    event.type === 'dispatched' || event.type === 'queued' || event.type === 'requeued'
  ));
  const awaitingReadiness = input.status === 'dispatched' && holdIndex > dispatchIndex;
  const refusalIndex = lastIndexOf(events, (event) => event.type === 'result_refused');
  const laterResultIndex = lastIndexOf(events, (event) => event.type === 'result_received' || event.type === 'result_rejected');
  const refusal = refusalIndex > laterResultIndex ? events[refusalIndex] : undefined;
  const refusalText = refusal
    ? `its result was refused ${refusal.reason === 'd1_pressure' ? 'under database pressure' : `(${refusal.reason ?? 'unknown reason'})`}`
      + ` at ${clock(refusal.at)}; waiting for the node to resend it`
    : null;
  const rejection = lastRejection
    ? rejectionText(lastRejection, { lastRequeue, nodeName, currentNodeId: input.dispatchedNodeId })
    : null;

  switch (input.status) {
    case 'completed': {
      if (started) {
        return `Node ${nodeName(started.node_id)} launched agent ${started.agent_name ?? agentName ?? 'unknown'}`
          + ` (registered ${clock(registeredAt)}); the invocation was marked completed from that registration`
          + ` instead of launching it again when it would have been requeued ${requeueText(started)}.`.replace(/ \./, '.');
      }
      const completion = lastOf(events, (event) => event.type === 'completed');
      const via = completion?.reason === 'inventory_sync' ? "the node's inventory confirmed it" : 'it reported success';
      if (launched) return `${launched} and ${via} at ${clock(input.completedAt)}.`;
      const node = completion?.node_id ?? input.dispatchedNodeId;
      return node
        ? `Completed by node ${nodeName(node)} at ${clock(input.completedAt)}.`
        : `Completed at ${clock(input.completedAt)}.`;
    }
    case 'failed': {
      const base = `Failed at ${clock(input.completedAt)} with ${input.error ?? 'an unknown error'}`;
      const parts = [base];
      if (launched) parts.push(`after ${launched.charAt(0).toLowerCase()}${launched.slice(1)}`);
      if (rejection) parts.push(`an earlier result from node ${nodeName(lastRejection!.node_id)} was rejected: ${rejection}`);
      return `${parts.join('; ')}.`;
    }
    default: {
      if (refusalText) {
        return launched
          ? `${launched} but ${refusalText}.`
          : `Node ${nodeName(refusal!.node_id)} reported a result but ${refusalText}.`;
      }
      if (launched && rejection) return `${launched} but its result was rejected: ${rejection}.`;
      if (launched && input.status === 'pending' && lastRequeue) {
        return `${launched}, but the invocation was requeued at ${clock(lastRequeue.at)} ${requeueText(lastRequeue)}`
          + ' and no result has been accepted since.';
      }
      if (launched && awaitingReadiness) {
        return `${launched}; the dispatch is held past the dispatch timeout while the node waits for the harness to report ready.`;
      }
      if (launched) return `${launched}; waiting for the node to report its result.`;
      if (rejection) {
        return `A result from node ${nodeName(lastRejection!.node_id)} was rejected at ${clock(lastRejection!.at)}: ${rejection}.`;
      }
      if (input.status === 'dispatched' || input.status === 'invoked' || input.status === 'running') {
        const attempt = typeof lastDispatch?.attempt === 'number' ? ` (attempt ${lastDispatch.attempt})` : '';
        return `Dispatched to node ${nodeName(input.dispatchedNodeId)} at ${clock(input.dispatchedAt ?? lastDispatch?.at)}${attempt};`
          + ' waiting for the node to report a result.';
      }
      if (input.dispatchedNodeId) {
        return `Queued for node ${nodeName(input.dispatchedNodeId)}; it is sent when that node's provider is connected and has capacity.`;
      }
      if (lastRequeue) {
        const next = input.retryAfterAt ? ` (next attempt after ${clock(input.retryAfterAt)})` : '';
        return `Requeued at ${clock(lastRequeue.at)} ${requeueText(lastRequeue)}; waiting to be dispatched again${next}.`;
      }
      return 'Waiting for a node that can run it; not dispatched yet.';
    }
  }
}
