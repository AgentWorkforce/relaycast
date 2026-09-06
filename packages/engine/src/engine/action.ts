import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { actions, actionInvocations, agents, agentNodeBindings, channelMembers, dmParticipants, nodes } from '../db/schema.js';
import { generateId } from './snowflake.js';
import { RELEASED_AGENT_STATUS, releasedAgentName } from './agent.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';
import { D1_SAFE_IN_QUERY_CHUNK_SIZE } from '../lib/queryChunks.js';
import { toFleetWireJson } from './deliveryWire.js';
import {
  emitAgentExitedEffects,
  emitInvocationCompletionEffects,
  fleetInvocationId,
  type InvocationCompletionDeps,
} from './invocationCompletion.js';
import type { NodeConnectionRegistry, NodeDrainOptions } from '../ports/realtime.js';
import { runAtomic, runAtomicWrites, type AtomicWrite } from '../ports/database.js';
import { claimSpawnNode, chooseNodeForAction, isNodeLive, releaseNodeCapacity, reserveNodeCapacity } from './placement.js';
import { DEFAULT_PROVIDER_NAME, capacityProviderName, getProvider, isProviderLive } from './nodeProvider.js';
import { AGENT_TOKEN_HASH_PATTERN } from '@relaycast/types';

type Db = ReturnType<typeof getDb>;
type ActionRow = typeof actions.$inferSelect;
type InvocationRow = typeof actionInvocations.$inferSelect;
type RetryableInvocationRow = Pick<
  InvocationRow,
  'id' | 'workspaceId' | 'actionId' | 'actionName' | 'invocationOrigin' | 'callerId' | 'input' | 'status' | 'dispatchedNodeId' | 'spawnReservedAt' | 'attemptedNodeIds' | 'dispatchAttempts'
>;

const OPEN_INVOCATION_STATUSES = ['pending', 'dispatched', 'invoked'];
const REPLAYED_INVOCATION = Symbol('replayed-action-invocation');
export const ACTION_DISPATCH_TIMEOUT_MS = 30_000;
/**
 * How long an agent handler's connection must be CONTINUOUSLY unreachable
 * before its open invocations are failed with `handler_unavailable`. The clock
 * starts at the sweep's first unreachable observation and resets when
 * connectivity recovers — generous enough to ride out a handler restart at any
 * invocation age, bounded enough that a caller blocked on the invocation gets
 * a signal instead of an unbounded hang.
 */
export const ACTION_HANDLER_UNREACHABLE_TTL_MS = 120_000;
/**
 * Absolute age bound for a `pending` invocation that was NEVER dispatched to a
 * node (`dispatch_attempts = 0`). The handler-unreachable TTL only fires once a
 * dispatched handler connection has been observed offline; an invocation that
 * never left the queue has no handler to observe, so the clock never starts
 * and the row can sit `pending` forever. When the queue eventually drains
 * (e.g. a node returns after a long outage), week-old spawn briefs come back
 * to life as fresh agents that can evict the live resident under the same
 * name — a delayed-action identity hazard, not inert backlog. Sized deliberately:
 * long enough to ride out a weekend-scale node outage plus a day of buffer,
 * far shorter than the observed multi-month backlog that motivated it.
 */
export const PENDING_INVOCATION_MAX_AGE_MS = 72 * 60 * 60 * 1000;
/**
 * Sleep between the never-dispatched sweep's candidate SELECT and its atomic
 * UPDATE. `dispatchNodeInvocation` sends the frame before recording
 * `dispatchAttempts += 1`, so a sweep landing between those two dispatcher
 * calls could otherwise mark an in-flight dispatch `never_dispatched_expired`
 * while the handler already has the frame. The atomic UPDATE re-checks
 * `dispatch_attempts = 0`, so once the dispatcher's UPDATE lands, the sweep's
 * WHERE excludes the row. This grace window (default 5s) covers the send→record
 * gap by a wide margin — the dispatcher's UPDATE is one D1 round-trip — while
 * still bounding sweep latency. Set to 0 in tests to keep them fast.
 */
export const NEVER_DISPATCHED_SWEEP_GRACE_MS = 5_000;
const ACTION_RETRY_BACKOFF_MS = 5_000;
const NODE_DRAIN_REQUEUE_RETRY_MS = 5_000;

export interface SweepTimedOutInvocationsOptions {
  timeoutMs?: number;
  /** Override for {@link ACTION_HANDLER_UNREACHABLE_TTL_MS}. */
  handlerUnreachableTtlMs?: number;
  /** Override for {@link PENDING_INVOCATION_MAX_AGE_MS}. */
  pendingInvocationMaxAgeMs?: number;
  /** Override for {@link NEVER_DISPATCHED_SWEEP_GRACE_MS}. */
  neverDispatchedSweepGraceMs?: number;
  /** When provided, TTL failures emit `action.failed` back to the caller. */
  completionDeps?: InvocationCompletionDeps;
}

function capabilityName(capability: string | { name?: string } | null | undefined): string | null {
  if (typeof capability === 'string') return capability;
  if (capability && typeof capability.name === 'string') return capability.name;
  return null;
}

function isSpawnInvocation(actionName: string): boolean {
  return actionName === 'spawn' || actionName.startsWith('spawn:');
}

function isReleaseInvocation(actionName: string): boolean {
  return actionName === 'release';
}

function isBuiltinReleaseInvocation(
  invocation: Pick<InvocationRow, 'actionName' | 'invocationOrigin'>,
): boolean {
  return invocation.invocationOrigin === 'builtin' && isReleaseInvocation(invocation.actionName);
}

function isDeletedRegisteredActionInvocation(
  invocation: Pick<InvocationRow, 'actionId' | 'invocationOrigin'>,
): boolean {
  // For a registered-action origin, actionId is cleared only by the FK when its
  // exact action row is deleted. The immutable origin prevents that orphan
  // from being mistaken for a built-in, and this predicate prevents it from
  // being rebound by name during drain/retry/reconciliation.
  return invocation.invocationOrigin === 'registered_action' && invocation.actionId === null;
}

const RELEASE_GENERATION_CONFLICT_CODE = 'agent_release_generation_conflict';

function releaseExpectedTokenHash(input: Record<string, unknown>): string | null {
  const value = input.expected_token_hash;
  if (value === undefined) return null;
  if (typeof value !== 'string' || !AGENT_TOKEN_HASH_PATTERN.test(value)) {
    throw codedError(
      'release action input.expected_token_hash must be a lowercase SHA-256 hash',
      'invalid_release_request',
      400,
    );
  }
  return value;
}

function releaseGenerationStillCurrent(
  workspaceId: string,
  agentId: string,
  expectedTokenHash: string | null,
) {
  return sql`EXISTS (
    SELECT 1 FROM ${agents}
    WHERE ${agents.workspaceId} = ${workspaceId}
      AND ${agents.id} = ${agentId}
      ${expectedTokenHash ? sql`AND ${agents.tokenHash} = ${expectedTokenHash}` : sql``}
  )`;
}

function dispatchActionNameForInvocation(actionName: string, input: Record<string, unknown>): string {
  if (!isSpawnInvocation(actionName)) return actionName;
  const raw = input.capability ?? input.cli;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return actionName.startsWith('spawn:') ? actionName : 'spawn';
  }
  const value = raw.trim();
  return value.startsWith('spawn:') ? value : `spawn:${value}`;
}

function normalizeAttemptedNodeIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function nextRetryAfter(attempts: number): Date {
  const backoff = Math.min(ACTION_RETRY_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), 60_000);
  return new Date(Date.now() + backoff);
}

/**
 * Field set that moves an invocation into the live `dispatched` state once its
 * `action.invoke` frame has actually been delivered to the node. Shared by the
 * live dispatch path (`dispatchNodeAttempt`) and exported offline-queue drain
 * path (`drainNodeInvocations`) so the dispatch-timeout sweep — which keys off
 * `dispatchedAt` — and the reschedule path cover drained invocations too.
 */
function dispatchedStateFields(opts: { retryAfterAt?: Date | null } = {}): {
  status: 'dispatched';
  dispatchedAt: Date;
  retryAfterAt: Date | null;
} {
  return {
    status: 'dispatched',
    dispatchedAt: new Date(),
    retryAfterAt: opts.retryAfterAt ?? null,
  };
}

function isActionVisibleToCaller(availableTo: string[] | null, callerName?: string): boolean {
  if (!availableTo || availableTo.length === 0) return true;
  return !!callerName && availableTo.includes(callerName);
}

function requireOneHandler(data: { handler_agent?: string; handler_node?: string }) {
  const hasAgent = !!data.handler_agent;
  const hasNode = !!data.handler_node;
  if (hasAgent === hasNode) {
    throw codedError('Exactly one of handler_agent or handler_node is required', 'invalid_action_handler', 400);
  }
}

function recordInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function publicAction(row: {
  id: string;
  name: string;
  description: string;
  handlerAgentName: string | null;
  handlerNodeName: string | null;
  handlerNodeId: string | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  availableTo: string[] | null;
  isActive: boolean;
  createdAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    handler_agent: row.handlerAgentName,
    handler_node: row.handlerNodeName,
    handler_node_id: row.handlerNodeId,
    input_schema: row.inputSchema ?? {},
    output_schema: row.outputSchema ?? {},
    available_to: row.availableTo ?? null,
    is_active: row.isActive,
    created_at: row.createdAt.toISOString(),
  };
}

/** Resolution priority when a name has several handlers: agent-hosted, then a
 * node action with a workspace-global alias, then a plain node-scoped action. */
function actionResolutionRank(row: ActionRow): number {
  if (row.handlerNodeId === null) return 0;
  if (row.isGlobal) return 1;
  return 2;
}

/**
 * Resolve an action by name for invocation. The workspace-scoped invoke
 * (`POST /v1/actions/:name/invoke`) reaches only agent-hosted actions and node
 * actions that claimed a workspace-global alias — plain node-scoped actions are
 * node-addressed there. `includeNodeScoped` lifts that filter for callers that
 * bind to a name without a node (message triggers), so a trigger can fire a
 * fleet-provider action; the resolved node-scoped row is then dispatched
 * node-addressed by {@link invokeAction}. `(workspaceId, name)` is not unique
 * across nodes, so a stable id tiebreak keeps resolution deterministic.
 */
async function fetchAction(
  db: Db,
  workspaceId: string,
  actionName: string,
  includeNodeScoped = false,
): Promise<ActionRow | null> {
  const rows = await db
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.workspaceId, workspaceId),
        eq(actions.name, actionName),
        eq(actions.isActive, true),
        ...(includeNodeScoped ? [] : [or(isNull(actions.handlerNodeId), eq(actions.isGlobal, true))]),
      ),
    );
  return rows.sort(
    (a, b) =>
      actionResolutionRank(a) - actionResolutionRank(b) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0] ?? null;
}

/** Resolve a node-addressed action by its unique `(node, name)` key. */
async function fetchNodeAction(db: Db, workspaceId: string, nodeId: string, actionName: string): Promise<ActionRow | null> {
  const [action] = await db
    .select()
    .from(actions)
    .where(and(
      eq(actions.workspaceId, workspaceId),
      eq(actions.handlerNodeId, nodeId),
      eq(actions.name, actionName),
      eq(actions.isActive, true),
    ));
  return action ?? null;
}

export async function registerAction(
  db: Db,
  workspaceId: string,
  data: {
    name: string;
    description: string;
    handler_agent?: string;
    handler_node?: string;
    input_schema?: Record<string, unknown>;
    output_schema?: Record<string, unknown>;
    available_to?: string[];
  },
  options: { completionDeps?: InvocationCompletionDeps } = {},
) {
  requireOneHandler(data);

  let handlerAgentId: string | null = null;
  let handlerAgentName: string | null = null;
  let handlerNodeId: string | null = null;
  let handlerNodeName: string | null = null;

  if (data.handler_agent) {
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, data.handler_agent)));

    if (!agent) {
      throw codedError(`Agent "${data.handler_agent}" not found`, 'agent_not_found', 404);
    }
    handlerAgentId = agent.id;
    handlerAgentName = agent.name;
  }

  if (data.handler_node) {
    const [node] = await db
      .select()
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.name, data.handler_node)));

    if (!node) {
      throw codedError(`Node "${data.handler_node}" not found`, 'node_not_found', 404);
    }
    const nodeCapabilities = Array.isArray(node.capabilities)
      ? node.capabilities.map(capabilityName).filter((value): value is string => !!value)
      : [];
    if (!nodeCapabilities.includes(data.name)) {
      throw codedError(`Node "${data.handler_node}" does not provide ${data.name}`, 'capability_mismatch', 409);
    }
    handlerNodeId = node.id;
    handlerNodeName = node.name;
  }

  const id = `act_${generateId()}`;
  // Registration is an idempotent assertion (PUT semantics): re-registering an
  // existing name refreshes the handler pointer, schemas, and visibility so a
  // reconnecting publisher heals a stale handler instead of surfacing the
  // unique index as a 500. Provider-owned fields (handlerProvider, isGlobal,
  // queue) are deliberately not touched — they belong to node-control
  // registration (materializeProviderActions).
  const refresh = {
    description: data.description,
    handlerAgentId,
    inputSchema: data.input_schema ?? {},
    outputSchema: data.output_schema ?? {},
    availableTo: data.available_to ?? null,
    isActive: true,
  };
  let action: ActionRow;
  let stranded: InvocationRow[];
  try {
    // The read-upsert-strand sequence runs atomically so a concurrent invoke
    // cannot land between the handler move and the stranded-invocation snapshot
    // (it either targets the old handler and is swept, or the new handler and
    // is untouched).
    ({ action, stranded } = await runAtomic(db, async (tx) => {
      // Read the row the upsert may refresh so a handler move can be detected.
      // The agent branch conflicts on the agent-hosted partial index, the node
      // branch on the per-node index.
      const [previous] = await tx
        .select({ id: actions.id, handlerAgentId: actions.handlerAgentId })
        .from(actions)
        .where(and(
          eq(actions.workspaceId, workspaceId),
          eq(actions.name, data.name),
          handlerNodeId ? eq(actions.handlerNodeId, handlerNodeId) : isNull(actions.handlerNodeId),
        ));
      const [row] = await tx
        .insert(actions)
        .values({
          id,
          workspaceId,
          name: data.name,
          description: data.description,
          handlerAgentId,
          handlerNodeId,
          inputSchema: data.input_schema ?? {},
          outputSchema: data.output_schema ?? {},
          availableTo: data.available_to ?? null,
        })
        .onConflictDoUpdate(
          handlerNodeId
            ? { target: [actions.workspaceId, actions.handlerNodeId, actions.name], set: refresh }
            // Agent-hosted uniqueness is a partial index, so the conflict target
            // must carry its WHERE clause to match it.
            : { target: [actions.workspaceId, actions.name], targetWhere: isNull(actions.handlerNodeId), set: refresh },
        )
        .returning();

      // A refresh that moves the handler to a DIFFERENT agent strands
      // invocations already in flight toward the previous handler: completion
      // authorization follows actions.handlerAgentId (the old handler's
      // completion would 403) and the timeout sweep would redeliver them to the
      // new handler, which never received the original dispatch. Terminally
      // fail them; the callers are told after commit.
      let strandedRows: InvocationRow[] = [];
      if (previous && previous.handlerAgentId && previous.handlerAgentId !== handlerAgentId) {
        const strandedIds = await openInvocationIdsForActions(tx, workspaceId, [previous.id]);
        strandedRows = await failOpenInvocationRows(tx, workspaceId, strandedIds, 'handler_unavailable');
      }
      return { action: row, stranded: strandedRows };
    }));
  } catch (err) {
    // A residual uniqueness race must surface as a conflict, never as a 500
    // internal_error (which reads as a server outage and invites retries).
    if (err instanceof Error && /unique constraint failed/i.test(err.message)) {
      throw codedError(`Action "${data.name}" conflicts with an existing action`, 'action_name_conflict', 409);
    }
    throw err;
  }
  if (options.completionDeps) {
    await emitFailedInvocationEffects(options.completionDeps, workspaceId, stranded);
  }

  return {
    created: action.id === id,
    action: {
      id: action.id,
      name: action.name,
      description: action.description,
      handler_agent: handlerAgentName,
      handler_node: handlerNodeName,
      handler_node_id: handlerNodeId,
      input_schema: action.inputSchema,
      output_schema: action.outputSchema,
      available_to: action.availableTo ?? null,
      is_active: action.isActive,
      created_at: action.createdAt.toISOString(),
    },
  };
}

export async function listActions(db: Db, workspaceId: string, callerName?: string) {
  const rows = await db
    .select({
      id: actions.id,
      name: actions.name,
      description: actions.description,
      handlerAgentName: agents.name,
      handlerNodeName: nodes.name,
      handlerNodeId: actions.handlerNodeId,
      inputSchema: actions.inputSchema,
      outputSchema: actions.outputSchema,
      availableTo: actions.availableTo,
      isActive: actions.isActive,
      createdAt: actions.createdAt,
    })
    .from(actions)
    .leftJoin(agents, eq(actions.handlerAgentId, agents.id))
    .leftJoin(nodes, eq(actions.handlerNodeId, nodes.id))
    .where(eq(actions.workspaceId, workspaceId));

  return rows
    .filter((r) => isActionVisibleToCaller(r.availableTo ?? null, callerName))
    .map(publicAction);
}

export async function getAction(db: Db, workspaceId: string, name: string, callerName?: string) {
  const [row] = await db
    .select({
      id: actions.id,
      name: actions.name,
      description: actions.description,
      handlerAgentName: agents.name,
      handlerNodeName: nodes.name,
      handlerNodeId: actions.handlerNodeId,
      inputSchema: actions.inputSchema,
      outputSchema: actions.outputSchema,
      availableTo: actions.availableTo,
      isActive: actions.isActive,
      createdAt: actions.createdAt,
    })
    .from(actions)
    .leftJoin(agents, eq(actions.handlerAgentId, agents.id))
    .leftJoin(nodes, eq(actions.handlerNodeId, nodes.id))
    .where(and(eq(actions.workspaceId, workspaceId), eq(actions.name, name)));

  if (!row || !isActionVisibleToCaller(row.availableTo ?? null, callerName)) return null;
  return publicAction(row);
}

export async function deleteAction(
  db: Db,
  workspaceId: string,
  name: string,
  options: { completionDeps?: InvocationCompletionDeps } = {},
) {
  // Fail open invocations WITH the delete in one atomic step: actionId is set
  // null on action delete, which would orphan them outside every
  // handler-resolution join (the TTL sweep included) so they retry forever and
  // the caller never hears back. Atomicity closes the window where an invoke
  // lands between the stranded snapshot and the delete.
  const { deleted, stranded } = await runAtomic(db, async (tx) => {
    const rows = await tx
      .select({ id: actions.id })
      .from(actions)
      .where(and(eq(actions.workspaceId, workspaceId), eq(actions.name, name)));
    const strandedIds = await openInvocationIdsForActions(tx, workspaceId, rows.map((row) => row.id));
    const strandedRows = await failOpenInvocationRows(tx, workspaceId, strandedIds, 'action_deleted');
    const result = await tx
      .delete(actions)
      .where(and(eq(actions.workspaceId, workspaceId), eq(actions.name, name)))
      .returning();
    return { deleted: result.length > 0, stranded: strandedRows };
  });
  if (options.completionDeps) {
    await emitFailedInvocationEffects(options.completionDeps, workspaceId, stranded);
  }

  return deleted;
}

async function createInvocation(
  db: Db,
  workspaceId: string,
  action: Pick<ActionRow, 'id' | 'name' | 'handlerAgentId' | 'handlerNodeId'> | null,
  data: {
    input?: Record<string, unknown>;
    caller_id?: string | null;
    caller_name?: string | null;
    handler_agent_id?: string | null;
    handler_node_id?: string | null;
    action_name?: string;
    status?: string;
    invocation_id?: string;
  },
) {
  const invocationId = data.invocation_id ?? `inv_${generateId()}`;
  const expectedActionName = action?.name ?? data.action_name ?? 'spawn';
  const [created] = await db
    .insert(actionInvocations)
    .values({
      id: invocationId,
      workspaceId,
      actionId: action?.id ?? null,
      actionName: expectedActionName,
      invocationOrigin: action ? 'registered_action' : 'builtin',
      callerId: data.caller_id ?? null,
      callerName: data.caller_name ?? null,
      handlerAgentId: data.handler_agent_id ?? action?.handlerAgentId ?? null,
      handlerNodeId: data.handler_node_id ?? action?.handlerNodeId ?? null,
      input: data.input ?? {},
      status: data.status ?? 'pending',
    })
    .onConflictDoNothing()
    .returning();
  if (created) return { invocation: created, replayed: false };

  // Only a deterministic idempotency claim is expected to conflict. Its row
  // is the durable pre-dispatch claim: a concurrent request or later retry
  // observes the same invocation instead of sending another provider frame.
  if (!data.invocation_id) {
    throw new Error(`Action invocation id collision: ${invocationId}`);
  }
  const [existing] = await db
    .select()
    .from(actionInvocations)
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.id, invocationId),
    ));
  if (!existing) {
    throw codedError('Idempotency claim could not be read after conflict', 'idempotency_unavailable', 503);
  }
  assertInvocationClaimMatches(existing, expectedActionName, data);
  return { invocation: existing, replayed: true };
}

function assertInvocationClaimMatches(
  existing: InvocationRow,
  expectedActionName: string,
  data: { input?: Record<string, unknown>; caller_id?: string | null },
): void {
  const samePayload = existing.actionName === expectedActionName
    && existing.callerId === (data.caller_id ?? null)
    && canonicalJson(recordInput(existing.input)) === canonicalJson(recordInput(data.input));
  if (!samePayload) {
    throw codedError(
      'Idempotency-Key was reused with a different request payload',
      'idempotency_key_reused',
      409,
    );
  }
}

async function idempotentInvocationId(
  workspaceId: string,
  callerId: string,
  actionName: string,
  key: string,
): Promise<string> {
  const digest = await sha256Hex(['action-invoke-v1', workspaceId, callerId, actionName, key].join('\0'));
  return `inv_idem_${digest}`;
}

/**
 * Poll a durable idempotency claim until the winning request's dispatch is
 * visible, for up to 500ms.
 *
 * Resolves as soon as the row leaves the pre-dispatch state: it returns the row
 * once `dispatchedNodeId` is set (or, with `acceptDispatchStarted`, once an
 * attempt has been recorded), returns a settled non-open row, and throws the
 * row's own failure for one that failed before dispatch.
 *
 * `onDeadline` picks what a still-open row does when the 500ms deadline passes:
 * `'throw'` (the default) raises a retryable 503 `idempotency_unavailable`,
 * which is what a replay observing someone else's claim wants; `'return'` hands
 * the still-open row back so a caller that owns the claim itself — the
 * post-send takeover re-read below — can classify it.
 *
 * @param options.acceptDispatchStarted - treat a recorded attempt as dispatch.
 * @param options.onDeadline - deadline behavior for a still-open row.
 * @returns the invocation row as last read.
 */
async function waitForInvocationReplayOutcome(
  db: Db,
  workspaceId: string,
  invocation: InvocationRow,
  options: { acceptDispatchStarted?: boolean; onDeadline?: 'throw' | 'return' } = {},
): Promise<InvocationRow> {
  let current = invocation;
  const deadline = Date.now() + 500;
  while (true) {
    // A guarded release can lose its generation CAS after provider dispatch.
    // Surface that durable terminal conflict before the generic dispatched-row
    // replay shortcut, otherwise the same idempotency key changes 409 into 201.
    if (
      isBuiltinReleaseInvocation(current)
      && current.status === 'failed'
      && current.error === RELEASE_GENERATION_CONFLICT_CODE
    ) {
      throw codedError(
        'Action invocation failed because the release generation changed',
        RELEASE_GENERATION_CONFLICT_CODE,
        409,
      );
    }
    if (
      current.dispatchedNodeId
      || (options.acceptDispatchStarted && current.dispatchAttempts > 0)
    ) {
      return current;
    }
    if (!OPEN_INVOCATION_STATUSES.some((status) => status === current.status)) {
      if (current.status === 'failed') {
        const errorCode = current.error ?? 'handler_unavailable';
        throw codedError(
          'Action invocation failed before provider dispatch completed',
          errorCode,
          isBuiltinReleaseInvocation(current) && errorCode === RELEASE_GENERATION_CONFLICT_CODE ? 409 : 503,
        );
      }
      return current;
    }
    if (Date.now() >= deadline) {
      // The winning request may have died after its durable claim but before
      // provider dispatch started or completed. Fail retryably without
      // releasing the key for another execution. Callers that own the claim
      // themselves (the post-send takeover re-read) opt out and classify the
      // still-open row instead.
      if (options.onDeadline === 'return') return current;
      throw codedError('Idempotent action dispatch is still pending', 'idempotency_unavailable', 503);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [updated] = await db
      .select()
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocation.id),
      ));
    if (!updated) {
      throw codedError('Idempotency claim disappeared during dispatch', 'idempotency_unavailable', 503);
    }
    current = updated;
  }
}

/**
 * Resolve a losing durable claim from the immutable invocation snapshots.
 *
 * This is shared by the optimistic pre-read and every branch-local insert
 * conflict. The action row resolved by the losing request may have changed
 * scope or handler after the winning claim was created, so it is never a safe
 * source for replay classification.
 */
async function replayInvocationClaim(
  db: Db,
  workspaceId: string,
  invocation: InvocationRow,
): Promise<InvocationRow> {
  if (
    isSpawnInvocation(invocation.actionName)
    || isBuiltinReleaseInvocation(invocation)
    || (!!invocation.handlerNodeId && !invocation.handlerAgentId)
  ) {
    return waitForInvocationReplayOutcome(db, workspaceId, invocation);
  }
  if (invocation.handlerAgentId) {
    // A handler takeover can win after the durable claim insert but before the
    // winner revalidates the handler and starts provider dispatch. Do not
    // acknowledge that pre-send claim. Once the durable attempt marker exists,
    // preserve the accepted post-send replay contract even if a later takeover
    // terminally fails the row.
    return waitForInvocationReplayOutcome(
      db,
      workspaceId,
      invocation,
      { acceptDispatchStarted: true },
    );
  }
  return invocation;
}

function invocationAck(
  invocation: InvocationRow,
  {
    actionName = invocation.actionName,
    handlerAgentId = invocation.handlerAgentId,
    handlerNodeId = invocation.handlerNodeId,
  }: {
    actionName?: string;
    handlerAgentId?: string | null;
    handlerNodeId?: string | null;
  } = {},
) {
  return {
    invocation_id: invocation.id,
    action_name: actionName,
    handler_agent_id: handlerAgentId,
    // The snapshot is the handler returned by the original 201. The mutable
    // dispatched node remains available separately for current lifecycle state.
    handler_node_id: handlerNodeId ?? invocation.dispatchedNodeId,
    dispatched_node_id: invocation.dispatchedNodeId,
    input: recordInput(invocation.input),
    status: invocation.status,
    created_at: invocation.createdAt.toISOString(),
  };
}

function markInvocationReplay<T extends object>(result: T): T {
  Object.defineProperty(result, REPLAYED_INVOCATION, { value: true });
  return result;
}

export function wasInvocationReplayed(result: object): boolean {
  return REPLAYED_INVOCATION in result;
}

/**
 * Liveness rule for the connection that hosts an agent handler, mirroring the
 * drain-time rule: the provider socket must be connected, and when a provider
 * row exists and is explicitly attached its heartbeat must say handlers are
 * live. A missing provider row (direct node, legacy single-socket broker)
 * keeps connection state as the available liveness signal.
 */
async function isHandlerConnectionLive(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
  providerName: string,
): Promise<boolean> {
  if (!registry.isProviderConnected(workspaceId, nodeId, providerName)) return false;
  const provider = await getProvider(db, workspaceId, nodeId, providerName);
  if (!provider) return true;
  const explicitlyAttached = registry.isProviderAttached?.(workspaceId, nodeId, providerName) ?? true;
  return !explicitlyAttached || isProviderLive(provider);
}

/** Is a node provider currently invokable — connection up AND heartbeat handlers_live. */
async function isNodeProviderLive(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
  providerName: string,
): Promise<boolean> {
  if (!registry.isProviderConnected(workspaceId, nodeId, providerName)) return false;
  const provider = await getProvider(db, workspaceId, nodeId, providerName);
  return !!provider && isProviderLive(provider);
}

async function failInvocationForUnavailableProvider(
  db: Db,
  workspaceId: string,
  invocationId: string,
): Promise<void> {
  await db
    .update(actionInvocations)
    .set({ status: 'failed', error: 'handler_unavailable', completedAt: new Date(), spawnReservedAt: null })
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.id, invocationId),
      inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
    ));
}

/**
 * Terminally fail one invocation ONLY while it is still open AND was never
 * dispatched — no recorded attempt and no dispatched node. The predicates make
 * the failure atomic against a concurrent dispatcher (`drainNodeInvocations`
 * on a handler reconnect): once that dispatcher's attempt lands, this update
 * matches nothing and the live dispatch is left alone. Sets the same columns as
 * {@link failInvocationForUnavailableProvider}; no spawn reservation can be
 * held by a row with no dispatched node, so there is no capacity to release.
 *
 * @returns true when this call is the one that failed the row.
 */
async function failNeverDispatchedInvocation(
  db: Db,
  workspaceId: string,
  invocationId: string,
  error: string,
): Promise<boolean> {
  const failed = await db
    .update(actionInvocations)
    .set({ status: 'failed', error, completedAt: new Date(), spawnReservedAt: null })
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.id, invocationId),
      inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
      eq(actionInvocations.dispatchAttempts, 0),
      isNull(actionInvocations.dispatchedNodeId),
    ))
    .returning({ id: actionInvocations.id });
  return failed.length > 0;
}

/**
 * Terminally fail the given open invocations (no completion emission — call
 * {@link emitFailedInvocationEffects} with the returned rows after the
 * enclosing transaction commits). A spawn invocation holding a native node
 * reservation releases that capacity, mirroring `completeNodeInvocation`.
 */
async function failOpenInvocationRows(
  db: Db,
  workspaceId: string,
  invocationIds: string[],
  error: string,
): Promise<InvocationRow[]> {
  if (invocationIds.length === 0) return [];
  // Capture reservation state before the update clears spawnReservedAt.
  const held = await db
    .select({
      id: actionInvocations.id,
      actionName: actionInvocations.actionName,
      dispatchedNodeId: actionInvocations.dispatchedNodeId,
      spawnReservedAt: actionInvocations.spawnReservedAt,
    })
    .from(actionInvocations)
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      inArray(actionInvocations.id, invocationIds),
      inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
    ));
  const failed = await db
    .update(actionInvocations)
    .set({ status: 'failed', error, completedAt: new Date(), spawnReservedAt: null })
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      inArray(actionInvocations.id, invocationIds),
      inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
    ))
    .returning();
  const failedIds = new Set(failed.map((row) => row.id));
  for (const row of held) {
    if (failedIds.has(row.id) && isSpawnInvocation(row.actionName) && row.dispatchedNodeId && row.spawnReservedAt) {
      await releaseNodeCapacity(db, workspaceId, row.dispatchedNodeId);
    }
  }
  return failed;
}

/** Emit `action.failed` to each failed invocation's caller. Best-effort per row. */
async function emitFailedInvocationEffects(
  completionDeps: InvocationCompletionDeps,
  workspaceId: string,
  failed: InvocationRow[],
): Promise<void> {
  for (const invocation of failed) {
    try {
      await emitInvocationCompletionEffects(completionDeps, workspaceId, {
        invocation_id: invocation.id,
        action_name: invocation.actionName,
        caller_id: invocation.callerId,
        status: 'failed',
        output: invocation.output,
        error: invocation.error,
      });
    } catch {
      // Notification is best-effort; the invocation is already terminally failed.
    }
  }
}

/**
 * Terminally fail the given open invocations, emitting `action.failed` to each
 * caller when completion deps are provided. Used when an invocation can no
 * longer reach a handler that will answer: the handler pointer moved to a
 * different agent (re-register takeover), the action was deleted, or the
 * handler connection stayed unreachable past the TTL.
 */
async function failOpenInvocations(
  db: Db,
  workspaceId: string,
  invocationIds: string[],
  error: string,
  completionDeps?: InvocationCompletionDeps,
): Promise<void> {
  const failed = await failOpenInvocationRows(db, workspaceId, invocationIds, error);
  if (completionDeps) await emitFailedInvocationEffects(completionDeps, workspaceId, failed);
}

/** Ids of open invocations pointing at any of the given action rows. */
async function openInvocationIdsForActions(db: Db, workspaceId: string, actionIds: string[]): Promise<string[]> {
  if (actionIds.length === 0) return [];
  const rows = await db
    .select({ id: actionInvocations.id })
    .from(actionInvocations)
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      inArray(actionInvocations.actionId, actionIds),
      inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
    ));
  return rows.map((row) => row.id);
}

/**
 * Dispatch an invoke to a specific provider on a node. When the provider is
 * offline the invoke fails fast (the invocation is failed) unless it opted into
 * the per-provider offline queue. Retry placement can request a non-terminal
 * unavailable result so it can try another node before failing the invocation.
 */
async function dispatchNodeProviderInvocation(args: {
  db: Db;
  registry: NodeConnectionRegistry;
  workspaceId: string;
  invocationId: string;
  nodeId: string;
  providerName: string;
  action: string;
  input: Record<string, unknown>;
  agent?: { id: string; name: string } | null;
  queue: boolean;
  /** Durable registered-action identity; null is reserved for built-in protocols. */
  actionId: string | null;
  /** Immutable provenance; unlike actionId, this survives action-row pruning. */
  invocationOrigin: InvocationRow['invocationOrigin'];
  reservationHeld?: boolean;
}, options: {
  failIfUnavailable?: boolean;
} = {}): Promise<{ accepted: boolean; pending: boolean; providerUnavailable?: boolean }> {
  const live = await isNodeProviderLive(args.db, args.registry, args.workspaceId, args.nodeId, args.providerName);
  if (!live) {
    if (!args.queue) {
      // Release any capacity reserved for this fail-fast spawn so the node's
      // reserved-agent count doesn't stay inflated.
      if (args.reservationHeld) {
        await releaseNodeCapacity(args.db, args.workspaceId, args.nodeId);
      }
      if (options.failIfUnavailable === false) {
        return { accepted: false, pending: false, providerUnavailable: true };
      }
      await failInvocationForUnavailableProvider(args.db, args.workspaceId, args.invocationId);
      throw codedError(`Provider "${args.providerName}" is offline for action "${args.action}"`, 'handler_unavailable', 503);
    }
    // The DB is the authoritative offline queue. Do not call sendToProvider
    // here: a connected provider whose heartbeat says handlers_live=false still
    // has a socket, and sendToProvider would deliver the frame immediately.
    const accepted = await dispatchNodeAttempt(args.db, args.workspaceId, args.invocationId, args.nodeId, {
      providerName: args.providerName,
      pending: true,
      reservationHeld: args.reservationHeld,
      actionId: args.actionId ?? undefined,
    });
    return { accepted, pending: true };
  }
  return dispatchNodeInvocation({ ...args });
}

async function dispatchRelease(args: {
  db: Db;
  registry?: NodeConnectionRegistry;
  completionDeps?: InvocationCompletionDeps;
  workspaceId: string;
  invocationId?: string;
  data: {
    input?: Record<string, unknown>;
    caller_id?: string;
    caller_name?: string;
  };
}) {
  const input = recordInput(args.data.input);
  const name = typeof input.name === 'string' ? input.name : null;
  if (!name) {
    throw codedError('release action input.name is required', 'invalid_release_request', 400);
  }
  const expectedTokenHash = releaseExpectedTokenHash(input);

  const [agent] = await args.db
    .select()
    .from(agents)
    .where(and(
      eq(agents.workspaceId, args.workspaceId),
      eq(agents.name, name),
      ...(expectedTokenHash ? [eq(agents.tokenHash, expectedTokenHash)] : []),
    ));
  if (!agent) {
    if (expectedTokenHash) {
      const [sameName] = await args.db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.workspaceId, args.workspaceId), eq(agents.name, name)));
      if (sameName) {
        throw codedError(
          `Agent "${name}" no longer matches the expected token generation`,
          RELEASE_GENERATION_CONFLICT_CODE,
          409,
        );
      }
    }
    throw codedError(`Agent "${name}" not found`, 'agent_not_found', 404);
  }
  const { invocation, replayed } = await createInvocation(args.db, args.workspaceId, null, {
    input,
    caller_id: args.data.caller_id,
    caller_name: args.data.caller_name,
    action_name: 'release',
    invocation_id: args.invocationId,
  });
  if (replayed) {
    const settled = await waitForInvocationReplayOutcome(args.db, args.workspaceId, invocation);
    return markInvocationReplay(invocationAck(settled, { actionName: 'release' }));
  }
  const completeLocally = async () => {
    const completedAt = new Date();
    const exitNodeId = nodeId ?? agent.locationNodeId;
    // Keyed on the agent id, not on the clock: the id is already unique per
    // workspace, so the tombstone can never collide with an existing row (a
    // second release of the same row is idempotent). A timestamped name would
    // reintroduce a unique-constraint abort into the very path this is fixing.
    // The release time is preserved in `metadata.release.releasedAt`.
    const releasedName = releasedAgentName(agent.name, agent.id);
    const releasedTokenHash = await sha256Hex(`released:${agent.id}:${randomHex(16)}`);
    const invocationIsOpen = sql`EXISTS (
      SELECT 1 FROM ${actionInvocations}
      WHERE ${actionInvocations.workspaceId} = ${args.workspaceId}
        AND ${actionInvocations.id} = ${invocation.id}
        AND ${actionInvocations.status} IN ('pending', 'dispatched', 'invoked')
    )`;
    const invocationCompleted = sql`EXISTS (
      SELECT 1 FROM ${actionInvocations}
      WHERE ${actionInvocations.workspaceId} = ${args.workspaceId}
        AND ${actionInvocations.id} = ${invocation.id}
        AND ${actionInvocations.status} = 'completed'
    )`;
    const generationStillCurrent = releaseGenerationStillCurrent(
      args.workspaceId,
      agent.id,
      expectedTokenHash,
    );

    const results = await runAtomicWrites(args.db, (writeDb) => {
      const writes: AtomicWrite[] = [];

      // If the optional generation lease no longer matches, settle the
      // invocation as a durable conflict in the same atomic unit in which all
      // lifecycle mutations are conditioned to no-op.
      writes.push(writeDb
        .update(actionInvocations)
        .set({
          status: 'failed',
          error: RELEASE_GENERATION_CONFLICT_CODE,
          completedAt,
        })
        .where(and(
          eq(actionInvocations.workspaceId, args.workspaceId),
          eq(actionInvocations.id, invocation.id),
          inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
          expectedTokenHash ? sql`NOT (${generationStillCurrent})` : sql`0`,
        ))
        .returning({ id: actionInvocations.id }));

      // Resolve the active binding in this atomic unit instead of from a
      // pre-transaction snapshot. A concurrent rebind therefore decrements
      // the node that is actually deactivated below.
      writes.push(writeDb
        .update(nodes)
        .set({
          activeAgents: sql`CASE WHEN ${nodes.activeAgents} > 0 THEN ${nodes.activeAgents} - 1 ELSE 0 END`,
        })
        .where(and(
          eq(nodes.workspaceId, args.workspaceId),
          invocationIsOpen,
          generationStillCurrent,
          sql`EXISTS (
            SELECT 1 FROM ${agentNodeBindings}
            WHERE ${agentNodeBindings.workspaceId} = ${args.workspaceId}
              AND ${agentNodeBindings.agentId} = ${agent.id}
              AND ${agentNodeBindings.nodeId} = ${nodes.id}
              AND ${agentNodeBindings.status} = 'active'
          )`,
        )));

      writes.push(writeDb
        .update(agentNodeBindings)
        .set({ status: 'inactive', updatedAt: completedAt })
        .where(and(
          eq(agentNodeBindings.workspaceId, args.workspaceId),
          eq(agentNodeBindings.agentId, agent.id),
          eq(agentNodeBindings.status, 'active'),
          invocationIsOpen,
          generationStillCurrent,
        )));
      // `channel_members` and `dm_participants` cascade on DELETE; the
      // tombstone's UPDATE does not fire that cascade, so drop the memberships
      // in the SAME atomic unit or the released agent stays a delivery target.
      writes.push(writeDb
        .delete(channelMembers)
        .where(and(
          eq(channelMembers.agentId, agent.id),
          invocationIsOpen,
          generationStillCurrent,
        )));
      writes.push(writeDb
        .delete(dmParticipants)
        .where(and(
          eq(dmParticipants.agentId, agent.id),
          invocationIsOpen,
          generationStillCurrent,
        )));
      writes.push(writeDb
        .delete(nodes)
        .where(and(
          eq(nodes.workspaceId, args.workspaceId),
          eq(nodes.id, `node_direct_${agent.id}`),
          invocationIsOpen,
          generationStillCurrent,
        )));

      writes.push(writeDb
        .update(actionInvocations)
        .set({
          status: 'completed',
          // This is part of the same atomic unit as completion so a lost 201
          // replays the exact handler node returned below.
          handlerNodeId: sql`COALESCE(${actionInvocations.handlerNodeId}, ${exitNodeId})`,
          output: {
            released: true,
            // The roster row is retained as a tombstone so the agent's history
            // keeps its author; the name is what the caller gets back.
            deleted: false,
            reaped_locally: true,
            released_name: releasedName,
          },
          completedAt,
        })
        .where(and(
          eq(actionInvocations.workspaceId, args.workspaceId),
          eq(actionInvocations.id, invocation.id),
          inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
          generationStillCurrent,
        ))
        .returning({ id: actionInvocations.id }));

      // Tombstone after the invocation has won its completion CAS. The whole
      // batch/transaction rolls back together, while this ordering lets the
      // success predicate inspect the still-current token hash before we rotate
      // it to an unusable released credential.
      writes.push(writeDb
        .update(agents)
        .set({
          name: releasedName,
          handle: `@${releasedName}`,
          status: RELEASED_AGENT_STATUS,
          tokenHash: releasedTokenHash,
          previousTokenHash: null,
          previousTokenExpiresAt: null,
          metadata: sql`json_patch(COALESCE(${agents.metadata}, '{}'), ${JSON.stringify({
            release: {
              reason: typeof input.reason === 'string' ? input.reason : null,
              released_at: completedAt.toISOString(),
              previous_name: agent.name,
            },
          })})`,
        })
        .where(and(
          eq(agents.workspaceId, args.workspaceId),
          eq(agents.id, agent.id),
          ...(expectedTokenHash ? [eq(agents.tokenHash, expectedTokenHash)] : []),
          invocationCompleted,
        )));

      return writes;
    }, expectedTokenHash ? { requireAtomic: true } : undefined);
    const generationConflict = results[0] as Array<{ id: string }>;
    const completed = results.at(-2) as Array<{ id: string }>;

    if (expectedTokenHash && (generationConflict.length > 0 || completed.length === 0)) {
      throw codedError(
        `Agent "${name}" no longer matches the expected token generation`,
        RELEASE_GENERATION_CONFLICT_CODE,
        409,
      );
    }

    // External completion effects belong after the durable atomic unit: an
    // aborted local reap must never publish agent.exited.
    if (completed.length > 0 && args.completionDeps && exitNodeId) {
      await emitAgentExitedEffects(args.completionDeps, args.workspaceId, {
        agentId: agent.id,
        agentName: agent.name,
        nodeId: exitNodeId,
        invocationId: fleetInvocationId(agent.metadata),
        reason: 'released',
      });
    }
    return {
      invocation_id: invocation.id,
      action_name: 'release',
      handler_agent_id: null,
      handler_node_id: exitNodeId,
      dispatched_node_id: null,
      input,
      status: 'completed',
      created_at: invocation.createdAt.toISOString(),
    };
  };
  const failClosed = async (): Promise<never> => {
    const completedAt = new Date();
    if (expectedTokenHash) {
      const generationStillCurrent = releaseGenerationStillCurrent(
        args.workspaceId,
        agent.id,
        expectedTokenHash,
      );
      const results = await runAtomicWrites(args.db, (writeDb) => [
        writeDb
          .update(actionInvocations)
          .set({
            status: 'failed',
            error: RELEASE_GENERATION_CONFLICT_CODE,
            completedAt,
          })
          .where(and(
            eq(actionInvocations.workspaceId, args.workspaceId),
            eq(actionInvocations.id, invocation.id),
            inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
            sql`NOT (${generationStillCurrent})`,
          ))
          .returning({ id: actionInvocations.id }),
        writeDb
          .update(actionInvocations)
          .set({ status: 'failed', error: 'agent_host_unavailable', completedAt })
          .where(and(
            eq(actionInvocations.workspaceId, args.workspaceId),
            eq(actionInvocations.id, invocation.id),
            inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
            generationStillCurrent,
          ))
          .returning({ id: actionInvocations.id }),
      ], { requireAtomic: true });
      const generationConflict = results[0] as Array<{ id: string }>;
      if (generationConflict.length > 0) {
        throw codedError(
          `Agent "${name}" no longer matches the expected token generation`,
          RELEASE_GENERATION_CONFLICT_CODE,
          409,
        );
      }
    } else {
      await args.db
        .update(actionInvocations)
        .set({ status: 'failed', error: 'agent_host_unavailable', completedAt })
        .where(and(
          eq(actionInvocations.workspaceId, args.workspaceId),
          eq(actionInvocations.id, invocation.id),
          inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
        ));
    }
    throw codedError(
      `Agent "${name}" has no live host node; cannot dispatch release`,
      'agent_host_unavailable',
      503,
    );
  };

  const registry = args.registry;
  const activeBindings = await args.db
    .select({ nodeId: agentNodeBindings.nodeId })
    .from(agentNodeBindings)
    .where(and(
      eq(agentNodeBindings.workspaceId, args.workspaceId),
      eq(agentNodeBindings.agentId, agent.id),
      eq(agentNodeBindings.status, 'active'),
    ));
  const implicitDirectNodeId = `node_direct_${agent.id}`;
  const nodeId = activeBindings.find((binding) => binding.nodeId === agent.locationNodeId)?.nodeId
    ?? activeBindings.find((binding) => binding.nodeId === implicitDirectNodeId)?.nodeId
    ?? activeBindings[0]?.nodeId
    ?? (agent.locationType === 'via_node' ? agent.locationNodeId : null);
  const hostLive = !!registry
    && !!nodeId
    && await isHandlerConnectionLive(
      args.db,
      registry,
      args.workspaceId,
      nodeId,
      agent.providerName,
    );

  if (!hostLive) {
    return input.delete_agent === true ? completeLocally() : failClosed();
  }

  // Release is a capacity operation handled by the provider hosting the agent.
  const dispatched = await dispatchNodeInvocation({
    db: args.db,
    registry,
    workspaceId: args.workspaceId,
    invocationId: invocation.id,
    nodeId,
    providerName: agent.providerName,
    action: 'release',
    input,
    actionId: null,
    invocationOrigin: 'builtin',
  });

  // Some socket owners durably record or complete an accepted frame before
  // this process resumes to stamp its own dispatch attempt. Return that
  // terminal winner instead of treating the failed post-send stamp as a
  // rejected send and entering local fallback.
  if (dispatched.settled) {
    if (dispatched.settled.status === 'failed') {
      const errorCode = dispatched.settled.error ?? 'handler_unavailable';
      throw codedError(
        'Release invocation failed after provider dispatch',
        errorCode,
        errorCode === RELEASE_GENERATION_CONFLICT_CODE ? 409 : 503,
      );
    }
    return invocationAck(dispatched.settled, { actionName: 'release' });
  }

  // The provider can disconnect between the liveness check and send. Complete
  // the DB lifecycle locally instead of creating an ownerless pending request.
  if (!dispatched.accepted) {
    if (expectedTokenHash) {
      const [settled] = await args.db
        .select({ error: actionInvocations.error })
        .from(actionInvocations)
        .where(and(
          eq(actionInvocations.workspaceId, args.workspaceId),
          eq(actionInvocations.id, invocation.id),
        ));
      if (settled?.error === RELEASE_GENERATION_CONFLICT_CODE) {
        throw codedError(
          `Agent "${name}" no longer matches the expected token generation`,
          RELEASE_GENERATION_CONFLICT_CODE,
          409,
        );
      }
      if (settled?.error === 'node_dispatch_unavailable') {
        throw codedError(
          'Node adapter does not support generation-authorized release dispatch',
          'node_dispatch_unavailable',
          503,
        );
      }
    }
    return input.delete_agent === true ? completeLocally() : failClosed();
  }

  return {
    invocation_id: invocation.id,
    action_name: 'release',
    handler_agent_id: null,
    handler_node_id: nodeId,
    dispatched_node_id: dispatched.accepted ? nodeId : null,
    input: recordInput(invocation.input),
    status: dispatched.accepted ? (dispatched.pending ? 'pending' : 'dispatched') : 'pending',
    created_at: invocation.createdAt.toISOString(),
  };
}

/**
 * Agent-lifecycle release used by `POST /v1/agents/release`. Unlike the
 * generic action endpoint, this path must always enforce the built-in release
 * lifecycle and its optional generation guard; a user-defined `release`
 * action must not be able to shadow it.
 */
export async function dispatchAgentRelease(
  db: Db,
  workspaceId: string,
  data: {
    input?: Record<string, unknown>;
    caller_id?: string;
    caller_name?: string;
  },
  options: {
    nodeConnections?: NodeConnectionRegistry;
    completionDeps?: InvocationCompletionDeps;
  } = {},
) {
  return dispatchRelease({
    db,
    registry: options.nodeConnections,
    completionDeps: options.completionDeps,
    workspaceId,
    data,
  });
}

function spawnResult(
  invocation: InvocationRow,
  nodeId: string,
  dispatched: { accepted: boolean; pending: boolean },
) {
  return {
    invocation_id: invocation.id,
    action_name: 'spawn',
    handler_agent_id: null,
    handler_node_id: nodeId,
    dispatched_node_id: dispatched.accepted ? nodeId : null,
    input: recordInput(invocation.input),
    status: dispatched.accepted ? (dispatched.pending ? 'pending' : 'dispatched') : 'pending',
    created_at: invocation.createdAt.toISOString(),
  };
}

async function dispatchSpawn(args: {
  db: Db;
  registry?: NodeConnectionRegistry;
  workspaceId: string;
  invocationId?: string;
  data: {
    input?: Record<string, unknown>;
    caller_id?: string;
    caller_name?: string;
  };
  /** Node-address the spawn instead of placing by capacity. */
  targetNodeId?: string;
  /** Capacity-direct delegation (`ctx.spawnAgent`) — never re-enters a shadow. */
  bypassShadow?: boolean;
}) {
  if (!args.registry) {
    throw codedError('Node dispatch is not available', 'node_dispatch_unavailable', 503);
  }

  const input = recordInput(args.data.input);
  const capability = dispatchActionNameForInvocation('spawn', input);

  const { invocation, replayed } = await createInvocation(args.db, args.workspaceId, null, {
    input: args.data.input,
    caller_id: args.data.caller_id,
    caller_name: args.data.caller_name,
    invocation_id: args.invocationId,
  });
  if (replayed) {
    const dispatched = await waitForInvocationReplayOutcome(args.db, args.workspaceId, invocation);
    return markInvocationReplay(invocationAck(dispatched, { actionName: 'spawn' }));
  }

  let placement;
  try {
    placement = await claimSpawnNode(args.db, args.workspaceId, {
      actionName: 'spawn',
      input,
      callerId: args.data.caller_id,
      preferredNodeId: args.targetNodeId,
    });
  } catch (error) {
    // Placement is transactional and no provider frame can exist yet. Release
    // only this untouched pre-placement claim so a keyed retry can try again
    // after capacity recovers. Once any target/attempt state exists, the claim
    // remains immutable and the normal replay path owns it.
    await args.db
      .delete(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, args.workspaceId),
        eq(actionInvocations.id, invocation.id),
        eq(actionInvocations.status, 'pending'),
        isNull(actionInvocations.handlerNodeId),
        isNull(actionInvocations.dispatchedNodeId),
        isNull(actionInvocations.spawnReservedAt),
        eq(actionInvocations.dispatchAttempts, 0),
      ));
    throw error;
  }
  const nodeId = placement.node.id;
  // Placement and the durable idempotency claim are separate writes on D1.
  // Publish the selected response target immediately; a concurrent replay in
  // this narrow interval waits for this snapshot instead of returning null.
  if (!await snapshotInvocationHandlerNode(args.db, args.workspaceId, invocation.id, nodeId)) {
    if (!placement.queued) await releaseNodeCapacity(args.db, args.workspaceId, nodeId);
    throw codedError('Spawn invocation is no longer available for placement', 'idempotency_unavailable', 503);
  }

  // A registered `spawn:<harness>` action shadows native capacity on this node.
  // Capacity-direct delegation (ctx.spawnAgent) bypasses the shadow so a handler
  // that delegates cannot re-enter itself.
  if (!args.bypassShadow) {
    const shadow = await fetchNodeAction(args.db, args.workspaceId, nodeId, capability);
    if (shadow && shadow.handlerProvider) {
      if (!placement.queued) await releaseNodeCapacity(args.db, args.workspaceId, nodeId);
      const dispatched = await dispatchNodeProviderInvocation({
        db: args.db,
        registry: args.registry,
        workspaceId: args.workspaceId,
        invocationId: invocation.id,
        nodeId,
        providerName: shadow.handlerProvider,
        action: capability,
        input,
        queue: shadow.queue,
        actionId: shadow.id,
        invocationOrigin: 'registered_action',
      });
      return spawnResult(invocation, nodeId, dispatched);
    }
  }

  const capProvider = (await capacityProviderName(args.db, args.workspaceId, nodeId, capability)) ?? DEFAULT_PROVIDER_NAME;
  const dispatched = await dispatchNodeInvocation({
    db: args.db,
    registry: args.registry,
    workspaceId: args.workspaceId,
    invocationId: invocation.id,
    nodeId,
    providerName: capProvider,
    action: capability,
    input,
    actionId: null,
    invocationOrigin: 'builtin',
    pending: placement.queued,
    reservationHeld: !placement.queued,
  });
  return spawnResult(invocation, nodeId, dispatched);
}

/**
 * Capacity-direct spawn used by handler-context `ctx.spawnAgent`: it targets a
 * node's capacity executor and never re-enters action dispatch, so a
 * `spawn:<harness>` shadow handler that delegates cannot recurse into itself.
 */
export async function dispatchCapacitySpawn(
  db: Db,
  workspaceId: string,
  data: { input?: Record<string, unknown>; caller_id?: string; caller_name?: string; target_node_id?: string },
  options: { nodeConnections?: NodeConnectionRegistry } = {},
) {
  return dispatchSpawn({
    db,
    registry: options.nodeConnections,
    workspaceId,
    data,
    targetNodeId: data.target_node_id,
    bypassShadow: true,
  });
}

/**
 * Invoke a node-addressed action: `POST /v1/nodes/:node/actions/:name/invoke`.
 * Resolves capability -> provider -> socket on the given node. A `spawn:*` name
 * with no shadow action falls through to native capacity on that node.
 */
export async function invokeNodeAction(
  db: Db,
  workspaceId: string,
  nodeId: string,
  actionName: string,
  data: {
    input?: Record<string, unknown>;
    caller_id?: string;
    caller_name?: string;
  },
  options: { nodeConnections?: NodeConnectionRegistry } = {},
) {
  if (!options.nodeConnections) {
    throw codedError('Node dispatch is not available', 'node_dispatch_unavailable', 503);
  }
  const action = await fetchNodeAction(db, workspaceId, nodeId, actionName);
  if (!action) {
    if (isSpawnInvocation(actionName)) {
      // Carry the harness from the URL (`spawn:<harness>`) into placement so the
      // native fallback targets the right capacity even when the body omits it.
      const harness = actionName.startsWith('spawn:') ? actionName.slice('spawn:'.length) : undefined;
      const spawnInput = harness ? { ...(data.input ?? {}), capability: harness } : data.input;
      return dispatchSpawn({ db, registry: options.nodeConnections, workspaceId, data: { ...data, input: spawnInput }, targetNodeId: nodeId });
    }
    if (isReleaseInvocation(actionName)) {
      return dispatchRelease({ db, registry: options.nodeConnections, workspaceId, data });
    }
    throw codedError(`Action "${actionName}" not found on node`, 'action_not_found', 404);
  }

  if (action.availableTo && action.availableTo.length > 0) {
    if (!data.caller_name || !action.availableTo.includes(data.caller_name)) {
      const who = data.caller_name ? `Agent "${data.caller_name}"` : 'Caller';
      throw codedError(`${who} is not authorized to invoke action "${actionName}"`, 'action_denied', 403);
    }
  }

  const { invocation } = await createInvocation(db, workspaceId, action, {
    input: data.input,
    caller_id: data.caller_id,
    caller_name: data.caller_name,
  });
  const providerName = action.handlerProvider ?? DEFAULT_PROVIDER_NAME;
  const reservedNode = isSpawnInvocation(action.name)
    ? await reserveNodeCapacity(db, workspaceId, nodeId)
    : null;
  const dispatched = await dispatchNodeProviderInvocation({
    db,
    registry: options.nodeConnections,
    workspaceId,
    invocationId: invocation.id,
    nodeId,
    providerName,
    action: action.name,
    input: recordInput(invocation.input),
    queue: action.queue,
    actionId: action.id,
    invocationOrigin: 'registered_action',
    reservationHeld: !!reservedNode,
  });
  return {
    invocation_id: invocation.id,
    action_name: actionName,
    handler_agent_id: null,
    handler_node_id: nodeId,
    dispatched_node_id: dispatched.accepted ? nodeId : null,
    input: recordInput(invocation.input),
    status: dispatched.accepted ? (dispatched.pending ? 'pending' : 'dispatched') : 'pending',
    created_at: invocation.createdAt.toISOString(),
  };
}

export async function invokeAction(
  db: Db,
  workspaceId: string,
  actionName: string,
  data: {
    input?: Record<string, unknown>;
    caller_id?: string;
    caller_name?: string;
  },
  options: {
    nodeConnections?: NodeConnectionRegistry;
    completionDeps?: InvocationCompletionDeps;
    /** A validated caller-supplied key for an atomic durable invocation claim. */
    idempotencyKey?: string;
    /** Resolve plain node-scoped actions too (message triggers bind by name
     * without a node); the resolved row is dispatched node-addressed. */
    includeNodeScoped?: boolean;
  } = {},
) {
  const action = await fetchAction(db, workspaceId, actionName, options.includeNodeScoped);
  let invocationId: string | undefined;
  if (options.idempotencyKey !== undefined) {
    if (!data.caller_id) {
      throw codedError('Authenticated caller is required for idempotent action invocation', 'idempotency_actor_required', 400);
    }
    invocationId = await idempotentInvocationId(
      workspaceId,
      data.caller_id,
      actionName,
      options.idempotencyKey,
    );
    const [existing] = await db
      .select()
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocationId),
    ));
    if (existing) {
      assertInvocationClaimMatches(existing, actionName, data);
      const replay = await replayInvocationClaim(db, workspaceId, existing);
      return markInvocationReplay(invocationAck(replay, { actionName }));
    }
  }

  if (!action && actionName === 'spawn') {
    return dispatchSpawn({
      db,
      registry: options.nodeConnections,
      workspaceId,
      data,
      invocationId,
    });
  }

  if (!action && actionName === 'release') {
    return dispatchRelease({
      db,
      registry: options.nodeConnections,
      completionDeps: options.completionDeps,
      workspaceId,
      data,
      invocationId,
    });
  }

  if (!action) {
    throw codedError(`Action "${actionName}" not found`, 'action_not_found', 404);
  }

  // Check availableTo access control — deny if caller is absent OR not in the list
  if (action.availableTo && action.availableTo.length > 0) {
    if (!data.caller_name || !action.availableTo.includes(data.caller_name)) {
      const who = data.caller_name ? `Agent "${data.caller_name}"` : 'Caller';
      throw codedError(`${who} is not authorized to invoke action "${actionName}"`, 'action_denied', 403);
    }
  }

  if (action.handlerNodeId) {
    if (!options.nodeConnections) {
      throw codedError('Node dispatch is not available', 'node_dispatch_unavailable', 503);
    }
    const { invocation, replayed } = await createInvocation(db, workspaceId, action, {
      input: data.input,
      caller_id: data.caller_id,
      caller_name: data.caller_name,
      invocation_id: invocationId,
    });
    if (replayed) {
      const settled = await replayInvocationClaim(db, workspaceId, invocation);
      return markInvocationReplay(invocationAck(settled, { actionName }));
    }
    // Only mark the reservation held when we actually incremented the node's
    // reserved-capacity counter, so completion/reschedule release stays balanced.
    // If the reservation can't be taken (node offline / at capacity) the queued
    // frame reserves later on drain via the spawnReservedAt check.
    const reservedNode = isSpawnInvocation(action.name)
      ? await reserveNodeCapacity(db, workspaceId, action.handlerNodeId)
      : null;
    const providerName = action.handlerProvider ?? DEFAULT_PROVIDER_NAME;
    // Route through the per-provider liveness gate so an offline provider fails
    // fast unless the capability opted into queue. The synthetic `default`
    // provider keeps the legacy queue-on-offline behavior (broker reconnect
    // resilience), so its aliases queue and drain on reconnect as before.
    const dispatched = await dispatchNodeProviderInvocation({
      db,
      registry: options.nodeConnections,
      workspaceId,
      invocationId: invocation.id,
      nodeId: action.handlerNodeId,
      providerName,
      action: action.name,
      input: recordInput(invocation.input),
      queue: action.queue || providerName === DEFAULT_PROVIDER_NAME,
      actionId: action.id,
      invocationOrigin: 'registered_action',
      reservationHeld: !!reservedNode,
    });
    return {
      invocation_id: invocation.id,
      action_name: actionName,
      handler_agent_id: null,
      handler_node_id: action.handlerNodeId,
      dispatched_node_id: dispatched.accepted ? action.handlerNodeId : null,
      input: recordInput(invocation.input),
      status: dispatched.accepted ? (dispatched.pending ? 'pending' : 'dispatched') : 'pending',
      created_at: invocation.createdAt.toISOString(),
    };
  }

  if (!action.handlerAgentId) {
    throw codedError(`Action "${actionName}" has no handler`, 'handler_unavailable', 503);
  }

  if (!options.nodeConnections) {
    throw codedError('Node dispatch is not available', 'node_dispatch_unavailable', 503);
  }
  const [handlerAgent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      locationType: agents.locationType,
      locationNodeId: agents.locationNodeId,
      providerName: agents.providerName,
    })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, action.handlerAgentId)));
  if (!handlerAgent || handlerAgent.locationType !== 'via_node' || !handlerAgent.locationNodeId) {
    throw codedError(`Action "${actionName}" handler is not bound to a node`, 'handler_unavailable', 503);
  }

  // Fail fast when the handler agent's connection is not live: an invocation
  // queued toward a dead handler never completes and the caller gets no signal
  // — it just hangs on the tool call. An action that opted into `queue` keeps
  // the queue-and-drain semantics (the TTL sweep still bounds it).
  if (!action.queue) {
    const live = await isHandlerConnectionLive(
      db,
      options.nodeConnections,
      workspaceId,
      handlerAgent.locationNodeId,
      handlerAgent.providerName,
    );
    if (!live) {
      throw codedError(
        `Action "${actionName}" handler "${handlerAgent.name}" has no live connection`,
        'handler_unavailable',
        503,
      );
    }
  }

  const { invocation, replayed } = await createInvocation(db, workspaceId, action, {
    input: data.input,
    caller_id: data.caller_id,
    caller_name: data.caller_name,
    handler_node_id: handlerAgent.locationNodeId,
    invocation_id: invocationId,
  });
  if (replayed) {
    const settled = await replayInvocationClaim(db, workspaceId, invocation);
    return markInvocationReplay(invocationAck(settled, { actionName }));
  }
  if (!options.nodeConnections.sendAuthorizedActionToProvider) {
    await failOpenInvocationRows(db, workspaceId, [invocation.id], 'node_dispatch_unavailable');
    throw codedError(
      'Node adapter does not support owner-authorized agent action dispatch',
      'node_dispatch_unavailable',
      503,
    );
  }
  // Re-validate the handler pointer AFTER the insert. A takeover committing
  // between action resolution above and the insert misses this invocation in
  // its stranded snapshot (the row was not visible yet), which would leave it
  // dispatched toward the old handler whose completions no longer authorize.
  // The two orderings are now both covered: a takeover before the insert is
  // caught here; a takeover after the insert sees the row and sweeps it.
  // (A concurrent DELETE needs no equivalent check — the actionId foreign key
  // rejects an insert that lands after the delete commits.)
  const [currentHandler] = await db
    .select({ handlerAgentId: actions.handlerAgentId })
    .from(actions)
    .where(and(eq(actions.workspaceId, workspaceId), eq(actions.id, action.id)));
  if (!currentHandler || currentHandler.handlerAgentId !== handlerAgent.id) {
    await failOpenInvocationRows(db, workspaceId, [invocation.id], 'handler_unavailable');
    throw codedError(
      `Action "${actionName}" handler changed during invoke`,
      'handler_unavailable',
      503,
    );
  }
  const dispatched = await dispatchNodeInvocation({
    db,
    registry: options.nodeConnections,
    workspaceId,
    invocationId: invocation.id,
    nodeId: handlerAgent.locationNodeId,
    providerName: handlerAgent.providerName,
    action: action.name,
    input: recordInput(invocation.input),
    agent: { id: handlerAgent.id, name: handlerAgent.name },
    actionId: action.id,
    invocationOrigin: 'registered_action',
  });

  if (dispatched.sent && !dispatched.accepted) {
    // The provider owns the frame once the send returns true. A fast completion
    // can make the following open-row dispatch UPDATE lose legitimately; in
    // that case acknowledge the durable terminal state instead of reporting a
    // retryable send failure for work the handler already executed.
    const [settled] = await db
      .select()
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocation.id),
      ));
    if (settled) {
      return invocationAck(settled, {
        actionName,
        handlerAgentId: action.handlerAgentId,
        handlerNodeId: handlerAgent.locationNodeId,
      });
    }
  }

  if (!dispatched.sent) {
    if (invocationId !== undefined) {
      // A keyed claim must stay consistent with its replays. Re-read it so a
      // takeover that raced the last-moment adapter gate is observed here (a
      // row it already failed throws its own error) instead of this request
      // and its replay disagreeing on the pre-send outcome. A row still open
      // at the deadline is handed back for classification below rather than
      // reported as a retryable idempotency stall.
      await waitForInvocationReplayOutcome(
        db,
        workspaceId,
        invocation,
        { acceptDispatchStarted: true, onDeadline: 'return' },
      );
    }
    // The host adapter could not deliver to the handler. A hosted adapter can
    // only learn that from the send itself, so the pre-dispatch liveness gate
    // above could not catch it. Resolve it the same way that gate would. The
    // failure is conditional on the row still being open AND never dispatched:
    // a handler that reconnected in the meantime may have had this very row
    // dispatched by `drainNodeInvocations`, and overwriting a live dispatch
    // with `handler_unavailable` would fail the caller while the handler runs
    // the action.
    const failed = await failNeverDispatchedInvocation(
      db,
      workspaceId,
      invocation.id,
      'handler_unavailable',
    );
    if (failed) {
      throw codedError(
        `Action "${actionName}" handler "${handlerAgent.name}" has no live connection`,
        'handler_unavailable',
        503,
      );
    }
    // Someone else owns the row now: a dispatcher on handler reconnect, or a
    // takeover that already failed it. Report that outcome rather than this
    // request's failed send.
    const [current] = await db
      .select()
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocation.id),
      ));
    if (!current || current.status === 'failed') {
      throw codedError(
        'Action invocation failed before provider dispatch completed',
        current?.error ?? 'handler_unavailable',
        503,
      );
    }
    return invocationAck(current, {
      actionName,
      handlerAgentId: action.handlerAgentId,
      handlerNodeId: handlerAgent.locationNodeId,
    });
  }

  return {
    invocation_id: invocation.id,
    action_name: actionName,
    handler_agent_id: action.handlerAgentId,
    handler_node_id: handlerAgent.locationNodeId,
    dispatched_node_id: dispatched.accepted ? handlerAgent.locationNodeId : null,
    input: recordInput(invocation.input),
    status: dispatched.accepted ? (dispatched.pending ? 'pending' : 'dispatched') : 'pending',
    created_at: invocation.createdAt.toISOString(),
  };
}

function publicInvocation(row: InvocationRow) {
  return {
    invocation_id: row.id,
    action_name: row.actionName,
    caller_id: row.callerId,
    caller_name: row.callerName,
    input: row.input,
    output: row.output,
    status: row.status,
    error: row.error,
    duration_ms: row.durationMs,
    dispatched_node_id: row.dispatchedNodeId,
    dispatched_at: row.dispatchedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    completed_at: row.completedAt?.toISOString() ?? null,
  };
}

async function completeGuardedReleaseNodeInvocation(
  db: Db,
  workspaceId: string,
  nodeId: string,
  providerName: string,
  invocation: Pick<InvocationRow, 'id' | 'actionName' | 'input'>,
  data: { output?: unknown },
  deps?: InvocationCompletionDeps,
): Promise<ReturnType<typeof publicInvocation> | null> {
  const input = recordInput(invocation.input);
  const name = typeof input.name === 'string' ? input.name : null;
  const expectedTokenHash = releaseExpectedTokenHash(input);
  if (!name || !expectedTokenHash) return null;

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, name)));
  if (!agent) {
    const [failed] = await db
      .update(actionInvocations)
      .set({
        status: 'failed',
        error: RELEASE_GENERATION_CONFLICT_CODE,
        completedAt: new Date(),
        spawnReservedAt: null,
      })
      .where(and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocation.id),
        eq(actionInvocations.dispatchedNodeId, nodeId),
        eq(actionInvocations.dispatchedProvider, providerName),
        inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
      ))
      .returning();
    return failed ? publicInvocation(failed) : null;
  }

  const completedAt = new Date();
  const generationStillCurrent = releaseGenerationStillCurrent(
    workspaceId,
    agent.id,
    expectedTokenHash,
  );
  const activeBindingStillCurrent = sql`EXISTS (
    SELECT 1 FROM ${agentNodeBindings}
    WHERE ${agentNodeBindings.workspaceId} = ${workspaceId}
      AND ${agentNodeBindings.agentId} = ${agent.id}
      AND ${agentNodeBindings.nodeId} = ${nodeId}
      AND ${agentNodeBindings.status} = 'active'
  )`;
  const invocationIsOpen = sql`EXISTS (
    SELECT 1 FROM ${actionInvocations}
    WHERE ${actionInvocations.workspaceId} = ${workspaceId}
      AND ${actionInvocations.id} = ${invocation.id}
      AND ${actionInvocations.dispatchedNodeId} = ${nodeId}
      AND ${actionInvocations.dispatchedProvider} = ${providerName}
      AND ${actionInvocations.status} IN ('pending', 'dispatched', 'invoked')
  )`;
  const invocationCompleted = sql`EXISTS (
    SELECT 1 FROM ${actionInvocations}
    WHERE ${actionInvocations.workspaceId} = ${workspaceId}
      AND ${actionInvocations.id} = ${invocation.id}
      AND ${actionInvocations.dispatchedNodeId} = ${nodeId}
      AND ${actionInvocations.dispatchedProvider} = ${providerName}
      AND ${actionInvocations.status} = 'completed'
  )`;
  const releaseCanApply = sql`(${generationStillCurrent}) AND (${activeBindingStillCurrent})`;
  const releasedName = releasedAgentName(agent.name, agent.id);
  const releasedTokenHash = await sha256Hex(`released:${agent.id}:${randomHex(16)}`);
  let successIndex = -1;

  const results = await runAtomicWrites(db, (writeDb) => {
    const writes: AtomicWrite[] = [];

    // The conflict settlement comes first. In a sequential SQLite batch it
    // closes the invocation before every mutation below if either the token
    // generation or node binding changed; on transactional adapters the same
    // statement ordering and rollback guarantee apply.
    writes.push(writeDb
      .update(actionInvocations)
      .set({
        status: 'failed',
        error: RELEASE_GENERATION_CONFLICT_CODE,
        completedAt,
        spawnReservedAt: null,
      })
      .where(and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocation.id),
        eq(actionInvocations.dispatchedNodeId, nodeId),
        eq(actionInvocations.dispatchedProvider, providerName),
        inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
        sql`NOT (${releaseCanApply})`,
      ))
      .returning());

    writes.push(writeDb
      .update(nodes)
      .set({
        activeAgents: sql`CASE WHEN ${nodes.activeAgents} > 0 THEN ${nodes.activeAgents} - 1 ELSE 0 END`,
      })
      .where(and(
        eq(nodes.workspaceId, workspaceId),
        eq(nodes.id, nodeId),
        invocationIsOpen,
        generationStillCurrent,
        activeBindingStillCurrent,
      )));

    writes.push(writeDb
      .update(agentNodeBindings)
      .set({ status: 'inactive', updatedAt: completedAt })
      .where(and(
        eq(agentNodeBindings.workspaceId, workspaceId),
        eq(agentNodeBindings.agentId, agent.id),
        eq(agentNodeBindings.nodeId, nodeId),
        eq(agentNodeBindings.status, 'active'),
        invocationIsOpen,
        generationStillCurrent,
      )));

    if (input.delete_agent === true) {
      writes.push(writeDb
        .delete(channelMembers)
        .where(and(
          eq(channelMembers.agentId, agent.id),
          invocationIsOpen,
          generationStillCurrent,
        )));
      writes.push(writeDb
        .delete(dmParticipants)
        .where(and(
          eq(dmParticipants.agentId, agent.id),
          invocationIsOpen,
          generationStillCurrent,
        )));
    }

    successIndex = writes.length;
    writes.push(writeDb
      .update(actionInvocations)
      .set({
        output: data.output ?? null,
        error: null,
        status: 'completed',
        completedAt,
        spawnReservedAt: null,
      })
      .where(and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocation.id),
        eq(actionInvocations.dispatchedNodeId, nodeId),
        eq(actionInvocations.dispatchedProvider, providerName),
        inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
        generationStillCurrent,
      ))
      .returning());

    const currentAgent = and(
      eq(agents.workspaceId, workspaceId),
      eq(agents.id, agent.id),
      eq(agents.name, name),
      eq(agents.tokenHash, expectedTokenHash),
      invocationCompleted,
    );
    if (input.delete_agent === true) {
      writes.push(writeDb
        .update(agents)
        .set({
          name: releasedName,
          handle: `@${releasedName}`,
          status: RELEASED_AGENT_STATUS,
          tokenHash: releasedTokenHash,
          previousTokenHash: null,
          previousTokenExpiresAt: null,
          locationType: 'self_connected',
          locationNodeId: null,
          lastSeen: completedAt,
          metadata: sql`json_patch(COALESCE(${agents.metadata}, '{}'), ${JSON.stringify({
            release: {
              reason: typeof input.reason === 'string' ? input.reason : null,
              released_at: completedAt.toISOString(),
              previous_name: agent.name,
            },
          })})`,
        })
        .where(currentAgent));
    } else {
      const existingMetadata = agent.metadata ?? {};
      const { spawn: _spawn, cli: _cli, ...restMetadata } = existingMetadata;
      writes.push(writeDb
        .update(agents)
        .set({
          status: 'offline',
          locationType: 'self_connected',
          locationNodeId: null,
          lastSeen: completedAt,
          metadata: {
            ...restMetadata,
            release: {
              reason: typeof input.reason === 'string' ? input.reason : null,
              released_at: completedAt.toISOString(),
            },
          },
        })
        .where(currentAgent));
    }

    if (input.delete_agent === true) {
      // Deleting the implicit node clears action_invocations.dispatched_node_id
      // via its FK. Do this only after the owned completion and agent CAS have
      // both succeeded, or their node predicates could no longer match.
      writes.push(writeDb
        .delete(nodes)
        .where(and(
          eq(nodes.workspaceId, workspaceId),
          eq(nodes.id, `node_direct_${agent.id}`),
          sql`EXISTS (
            SELECT 1 FROM ${actionInvocations}
            WHERE ${actionInvocations.workspaceId} = ${workspaceId}
              AND ${actionInvocations.id} = ${invocation.id}
              AND ${actionInvocations.status} = 'completed'
          )`,
        )));
    }

    return writes;
  }, { requireAtomic: true });

  const completed = results[successIndex] as InvocationRow[];
  const generationConflict = results[0] as InvocationRow[];
  const settled = completed[0] ?? generationConflict[0];
  if (!settled) return null;

  if (completed[0] && deps) {
    await emitAgentExitedEffects(deps, workspaceId, {
      agentId: agent.id,
      agentName: agent.name,
      nodeId,
      invocationId: fleetInvocationId(agent.metadata),
      reason: 'released',
    });
  }
  return publicInvocation(settled);
}

async function applyReleaseCompletionEffect(
  db: Db,
  workspaceId: string,
  nodeId: string | null,
  invocation: Pick<InvocationRow, 'actionName' | 'invocationOrigin' | 'input'>,
  data: { error?: string },
  deps?: InvocationCompletionDeps,
  options: { allowMissingBinding?: boolean; expectedAgentId?: string } = {},
): Promise<boolean> {
  if (!isBuiltinReleaseInvocation(invocation) || data.error) return false;

  const input = recordInput(invocation.input);
  const name = typeof input.name === 'string' ? input.name : null;
  if (!name) return false;

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(
      eq(agents.workspaceId, workspaceId),
      eq(agents.name, name),
      ...(options.expectedAgentId ? [eq(agents.id, options.expectedAgentId)] : []),
      ...(!options.allowMissingBinding && nodeId ? [
        eq(agents.locationType, 'via_node'),
        eq(agents.locationNodeId, nodeId),
      ] : []),
    ));
  if (!agent) return false;

  // Only proceed if an active binding actually flipped to inactive. This guards
  // against a second release (e.g. a retry) double-decrementing activeAgents for
  // an agent that was already released from this node.
  const deactivatedBindings = await db
    .update(agentNodeBindings)
    .set({ status: 'inactive', updatedAt: new Date() })
    .where(and(
      eq(agentNodeBindings.workspaceId, workspaceId),
      eq(agentNodeBindings.agentId, agent.id),
      eq(agentNodeBindings.status, 'active'),
      ...(nodeId ? [eq(agentNodeBindings.nodeId, nodeId)] : []),
    ))
    .returning({ nodeId: agentNodeBindings.nodeId });
  if (deactivatedBindings.length === 0 && !options.allowMissingBinding) return false;

  // Capture exit correlation BEFORE the mutation deletes the row or strips the
  // spawn/cli metadata, so a durable agent.exited can still be emitted.
  const exited = { agentId: agent.id, agentName: agent.name, invocationId: fleetInvocationId(agent.metadata) };

  const deactivatedNodeIds = Array.from(new Set(deactivatedBindings.map((binding) => binding.nodeId)));
  if (deactivatedNodeIds.length > 0) {
    await db
      .update(nodes)
      .set({
        activeAgents: sql`CASE WHEN ${nodes.activeAgents} > 0 THEN ${nodes.activeAgents} - 1 ELSE 0 END`,
      })
      .where(and(eq(nodes.workspaceId, workspaceId), inArray(nodes.id, deactivatedNodeIds)));
  }

  if (input.delete_agent === true) {
    // Tombstone rather than DELETE, matching `dispatchRelease`'s
    // `completeLocally`. Four FKs reference `agents.id` without an ON DELETE
    // action (`messages.agent_id`, `channels.created_by`, `files.uploaded_by`,
    // `webhooks.created_by`), so a bare delete is refused for any agent that
    // has ever spoken — and this runs inside the completion's atomic unit, so
    // that refusal aborts the invocation completion too. The seat and the name
    // then stay claimed forever and the caller only ever sees `dispatched`.
    // Renaming frees the unique `(workspace_id, name)` immediately while every
    // FK target stays valid and every message keeps its sender.
    const releasedName = releasedAgentName(agent.name, agent.id);
    // The row survives, so its credential must not. `token_hash` is NOT NULL
    // UNIQUE and cannot be cleared, so rotate it to a value nobody holds.
    const releasedTokenHash = await sha256Hex(`released:${agent.id}:${randomHex(16)}`);
    await db
      .update(agents)
      .set({
        name: releasedName,
        handle: `@${releasedName}`,
        status: RELEASED_AGENT_STATUS,
        tokenHash: releasedTokenHash,
        // Same reason as the other release paths — the grace slot survives
        // `token_hash` rewrites unless we clear it. See 0035_agent_token_grace.
        previousTokenHash: null,
        previousTokenExpiresAt: null,
        locationType: 'self_connected',
        locationNodeId: null,
        lastSeen: new Date(),
      })
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agent.id)));
    // `channel_members` and `dm_participants` reference `agents.id` ON DELETE
    // CASCADE; an UPDATE does not fire that cascade, so drop the memberships
    // explicitly or the released agent stays a delivery target.
    await db.delete(channelMembers).where(eq(channelMembers.agentId, agent.id));
    await db.delete(dmParticipants).where(eq(dmParticipants.agentId, agent.id));
    const implicitNodeId = `node_direct_${agent.id}`;
    await db.delete(nodes).where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, implicitNodeId)));
  } else {
    const existingMetadata = agent.metadata ?? {};
    const { spawn: _spawn, cli: _cli, ...restMetadata } = existingMetadata;
    await db
      .update(agents)
      .set({
        status: 'offline',
        // Clear the node location so the agent is no longer routable to the released
        // node and a repeat release can't re-decrement the node's active count.
        locationType: 'self_connected',
        locationNodeId: null,
        lastSeen: new Date(),
        metadata: {
          ...restMetadata,
          release: {
            reason: typeof input.reason === 'string' ? input.reason : null,
            released_at: new Date().toISOString(),
          },
        },
      })
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agent.id)));
  }

  if (deps && nodeId) {
    await emitAgentExitedEffects(deps, workspaceId, {
      agentId: exited.agentId,
      agentName: exited.agentName,
      nodeId,
      invocationId: exited.invocationId,
      reason: 'released',
    });
  }
  return true;
}

async function dispatchNodeAttempt(
  db: Db,
  workspaceId: string,
  invocationId: string,
  nodeId: string,
  opts: {
    providerName: string;
    pending?: boolean;
    retryAfterAt?: Date | null;
    reservationHeld?: boolean;
    skipIncrementAttempts?: boolean;
    actionId?: string;
  },
) {
  const stateFields = opts.pending
    ? { status: 'pending' as const, dispatchedAt: null, retryAfterAt: opts.retryAfterAt ?? null }
    : dispatchedStateFields({ retryAfterAt: opts.retryAfterAt });
  const attemptFields = opts.skipIncrementAttempts
    ? {}
    : {
      attemptedNodeIds: sql`json_insert(COALESCE(${actionInvocations.attemptedNodeIds}, '[]'), '$[#]', ${nodeId})`,
      dispatchAttempts: sql`COALESCE(${actionInvocations.dispatchAttempts}, 0) + 1`,
    };
  const [updated] = await db
    .update(actionInvocations)
    .set({
      ...stateFields,
      // The first selected target is part of the immutable 201 response. Keep
      // it even when this invocation is later rescheduled to a different node.
      handlerNodeId: sql`COALESCE(${actionInvocations.handlerNodeId}, ${nodeId})`,
      dispatchedNodeId: nodeId,
      dispatchedProvider: opts.providerName,
      spawnReservedAt: opts.reservationHeld ? new Date() : null,
      ...(opts.actionId ? { actionId: opts.actionId } : {}),
      ...attemptFields,
    })
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.id, invocationId),
      inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
    ))
    .returning();
  return !!updated;
}

async function snapshotInvocationHandlerNode(
  db: Db,
  workspaceId: string,
  invocationId: string,
  nodeId: string,
): Promise<boolean> {
  const [updated] = await db
    .update(actionInvocations)
    .set({
      handlerNodeId: sql`COALESCE(${actionInvocations.handlerNodeId}, ${nodeId})`,
    })
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.id, invocationId),
      inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
    ))
    .returning({ id: actionInvocations.id });
  return !!updated;
}

/**
 * Transition a drained offline-queue invocation into the live `dispatched` state
 * once its queued `action.invoke` frame is actually delivered on node
 * reconnect/drain. Reuses the same dispatched-state fields as the live dispatch
 * path (stamping `dispatchedAt` and `retryAfterAt`) so the dispatch-timeout sweep
 * and reschedule cover drained invocations. This is the SAME attempt that was
 * queued, so `dispatchAttempts`/`attemptedNodeIds` are intentionally left intact.
 * Guarded on the invocation still being `pending` on this node so a completion or
 * reschedule that raced the drain is never clobbered.
 */
export async function markDrainedInvocationDispatched(
  db: Db,
  workspaceId: string,
  invocationId: string,
  nodeId: string,
): Promise<boolean> {
  const [updated] = await db
    .update(actionInvocations)
    .set(dispatchedStateFields({ retryAfterAt: new Date(Date.now() + ACTION_DISPATCH_TIMEOUT_MS) }))
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.id, invocationId),
      eq(actionInvocations.dispatchedNodeId, nodeId),
      eq(actionInvocations.status, 'pending'),
    ))
    .returning({ id: actionInvocations.id });
  return !!updated;
}

async function dispatchNodeInvocation(args: {
  db: Db;
  registry: NodeConnectionRegistry;
  workspaceId: string;
  invocationId: string;
  nodeId: string;
  /** Provider connection that owns this dispatch attempt. */
  providerName: string;
  action: string;
  input: Record<string, unknown>;
  agent?: { id: string; name: string } | null;
  /** Durable registered-action identity; null is reserved for built-in protocols. */
  actionId: string | null;
  /** Immutable provenance; unlike actionId, this survives action-row pruning. */
  invocationOrigin: InvocationRow['invocationOrigin'];
  pending?: boolean;
  retryAfterAt?: Date | null;
  reservationHeld?: boolean;
  skipIncrementAttempts?: boolean;
}): Promise<{
  accepted: boolean;
  pending: boolean;
  sent: boolean;
  settled?: InvocationRow;
}> {
  const guardedReleaseHash = args.invocationOrigin === 'builtin' && isReleaseInvocation(args.action)
    ? releaseExpectedTokenHash(args.input)
    : null;
  if (guardedReleaseHash) {
    const name = typeof args.input.name === 'string' ? args.input.name : '';
    const [current] = await args.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(
        eq(agents.workspaceId, args.workspaceId),
        eq(agents.name, name),
        eq(agents.tokenHash, guardedReleaseHash),
        sql`EXISTS (
            SELECT 1 FROM ${agentNodeBindings}
            WHERE ${agentNodeBindings.workspaceId} = ${args.workspaceId}
              AND ${agentNodeBindings.agentId} = ${agents.id}
              AND ${agentNodeBindings.nodeId} = ${args.nodeId}
              AND ${agentNodeBindings.status} = 'active'
          )`,
      ));
    if (!current) {
      await args.db
        .update(actionInvocations)
        .set({
          status: 'failed',
          error: RELEASE_GENERATION_CONFLICT_CODE,
          completedAt: new Date(),
        })
        .where(and(
          eq(actionInvocations.workspaceId, args.workspaceId),
          eq(actionInvocations.id, args.invocationId),
          inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
        ));
      return { accepted: false, pending: false, sent: false };
    }
    if (!args.registry.sendAuthorizedActionToProvider) {
      await args.db
        .update(actionInvocations)
        .set({
          status: 'failed',
          error: 'node_dispatch_unavailable',
          completedAt: new Date(),
        })
        .where(and(
          eq(actionInvocations.workspaceId, args.workspaceId),
          eq(actionInvocations.id, args.invocationId),
          inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
        ));
      return { accepted: false, pending: false, sent: false };
    }
  }

  const frame = {
    v: 1 as const,
    type: 'action.invoke' as const,
    invocation_id: args.invocationId,
    action: args.action,
    ...(args.agent ? { agent_id: args.agent.id, agent_name: args.agent.name } : {}),
    input: toFleetWireJson(args.input),
  };
  // Agent-hosted createInvocation() already persisted the immutable handler
  // node. Avoid another awaited DB write after handler revalidation; the socket
  // owner performs the last-moment gate below immediately before the send.
  const snapshotted = args.agent
    ? true
    : await snapshotInvocationHandlerNode(
        args.db,
        args.workspaceId,
        args.invocationId,
        args.nodeId,
      );
  if (!snapshotted) return { accepted: false, pending: false, sent: false };
  const connectedBefore = args.registry.isProviderConnected(args.workspaceId, args.nodeId, args.providerName);
  const sent = args.agent && args.actionId
    ? await (args.registry.sendAuthorizedActionToProvider?.(
        args.workspaceId,
        args.nodeId,
        args.providerName,
        frame,
        {
          kind: 'agent-action-v1',
          invocationId: args.invocationId,
          actionId: args.actionId,
          handlerAgentId: args.agent.id,
          recordAttempt: !args.skipIncrementAttempts,
        },
      ) ?? false)
    : guardedReleaseHash
      ? await (args.registry.sendAuthorizedActionToProvider?.(
          args.workspaceId,
          args.nodeId,
          args.providerName,
          frame,
          {
            kind: 'release-generation-v1',
            invocationId: args.invocationId,
            agentName: typeof args.input.name === 'string' ? args.input.name : '',
            expectedTokenHash: guardedReleaseHash,
          },
        ) ?? false)
    : await args.registry.sendToProvider(
        args.workspaceId,
        args.nodeId,
        args.providerName,
        frame,
      );

  if (!sent && guardedReleaseHash) {
    // An adapter compiled against the older owner-authorization contract may
    // expose the method but reject the new proof kind. Settle any still-open
    // row before the caller considers local fallback, so a guarded delete can
    // never degrade to an unguarded lifecycle mutation.
    await args.db
      .update(actionInvocations)
      .set({
        status: 'failed',
        error: 'node_dispatch_unavailable',
        completedAt: new Date(),
      })
      .where(and(
        eq(actionInvocations.workspaceId, args.workspaceId),
        eq(actionInvocations.id, args.invocationId),
        inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
      ));
  }
  if (!sent) return { accepted: false, pending: false, sent: false };

  const pending = !!args.pending || !connectedBefore;
  const accepted = await dispatchNodeAttempt(
    args.db,
    args.workspaceId,
    args.invocationId,
    args.nodeId,
    {
      pending,
      providerName: args.providerName,
      retryAfterAt: args.retryAfterAt,
      reservationHeld: args.reservationHeld,
      skipIncrementAttempts: args.skipIncrementAttempts || !!args.agent,
      actionId: args.actionId ?? undefined,
    },
  );
  if (!accepted && guardedReleaseHash) {
    const [settled] = await args.db
      .select()
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, args.workspaceId),
        eq(actionInvocations.id, args.invocationId),
      ));
    if (settled && !OPEN_INVOCATION_STATUSES.some((status) => status === settled.status)) {
      return { accepted: false, pending: false, sent: true, settled };
    }
  }
  return { accepted, pending, sent: true };
}

function attemptedNodeSet(invocation: Pick<InvocationRow, 'attemptedNodeIds' | 'dispatchedNodeId'>): string[] {
  return Array.from(new Set([
    ...normalizeAttemptedNodeIds(invocation.attemptedNodeIds),
    invocation.dispatchedNodeId,
  ].filter((nodeId): nodeId is string => !!nodeId)));
}

async function selectRetryPlacement(
  db: Db,
  invocation: RetryableInvocationRow,
  excludeNodeIds: string[],
) {
  const input = recordInput(invocation.input);
  if (isSpawnInvocation(invocation.actionName)) {
    return claimSpawnNode(db, invocation.workspaceId, {
      actionName: 'spawn',
      input,
      callerId: invocation.callerId,
      excludeNodeIds,
    });
  }
  return chooseNodeForAction(db, invocation.workspaceId, {
    actionName: invocation.actionName,
    input,
    callerId: invocation.callerId,
    excludeNodeIds,
  });
}

async function targetAgentForInvocation(
  db: Db,
  invocation: Pick<InvocationRow, 'id' | 'workspaceId'>,
): Promise<{ actionId: string; agentId: string; agentName: string; nodeId: string; providerName: string } | null> {
  const [row] = await db
    .select({
      actionId: actions.id,
      agentId: agents.id,
      agentName: agents.name,
      locationType: agents.locationType,
      nodeId: agents.locationNodeId,
      providerName: agents.providerName,
    })
    .from(actionInvocations)
    .innerJoin(actions, eq(actionInvocations.actionId, actions.id))
    .innerJoin(agents, eq(actions.handlerAgentId, agents.id))
    .where(and(
      eq(actionInvocations.workspaceId, invocation.workspaceId),
      eq(actionInvocations.id, invocation.id),
    ));
  if (!row || row.locationType !== 'via_node' || !row.nodeId) return null;
  return {
    actionId: row.actionId,
    agentId: row.agentId,
    agentName: row.agentName,
    nodeId: row.nodeId,
    providerName: row.providerName,
  };
}

export async function drainNodeInvocations(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
  options: NodeDrainOptions = {},
): Promise<number> {
  const now = new Date();
  const rows = await db
    .select({
      id: actionInvocations.id,
      actionId: actionInvocations.actionId,
      invocationOrigin: actionInvocations.invocationOrigin,
      workspaceId: actionInvocations.workspaceId,
      actionName: actionInvocations.actionName,
      input: actionInvocations.input,
      spawnReservedAt: actionInvocations.spawnReservedAt,
      dispatchedNodeId: actionInvocations.dispatchedNodeId,
      dispatchedProvider: actionInvocations.dispatchedProvider,
      handlerNodeId: actions.handlerNodeId,
      handlerProvider: actions.handlerProvider,
      handlerAgentId: agents.id,
      handlerAgentName: agents.name,
      handlerAgentLocationType: agents.locationType,
      handlerAgentNodeId: agents.locationNodeId,
      handlerAgentProvider: agents.providerName,
    })
    .from(actionInvocations)
    .leftJoin(actions, eq(actionInvocations.actionId, actions.id))
    .leftJoin(agents, eq(actions.handlerAgentId, agents.id))
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.status, 'pending'),
      options.includeDeferred
        ? undefined
        : or(isNull(actionInvocations.retryAfterAt), lte(actionInvocations.retryAfterAt, now)),
      or(
        eq(actionInvocations.dispatchedNodeId, nodeId),
        eq(actions.handlerNodeId, nodeId),
        and(eq(agents.locationType, 'via_node'), eq(agents.locationNodeId, nodeId)),
      ),
    ))
    .orderBy(asc(actionInvocations.createdAt));

  let drained = 0;
  for (const row of rows) {
    if (isDeletedRegisteredActionInvocation(row)) {
      await failOpenInvocationRows(db, workspaceId, [row.id], 'action_deleted');
      continue;
    }
    const targetAgent = row.handlerAgentId
      && row.handlerAgentName
      && row.handlerAgentLocationType === 'via_node'
      && row.handlerAgentNodeId
      ? { id: row.handlerAgentId, name: row.handlerAgentName, nodeId: row.handlerAgentNodeId }
      : null;
    const targetNodeId = targetAgent?.nodeId ?? row.handlerNodeId ?? row.dispatchedNodeId;
    if (targetNodeId !== nodeId) continue;

    const input = recordInput(row.input);
    // Resolve the target provider so the offline queue drains per provider. A
    // spawn with a registered shadow re-dispatches to the shadow (no capacity
    // reservation); otherwise native capacity handles it.
    let shadowProvider: string | null = null;
    if (isSpawnInvocation(row.actionName)) {
      const shadow = await fetchNodeAction(db, workspaceId, nodeId, dispatchActionNameForInvocation(row.actionName, input));
      shadowProvider = shadow?.handlerProvider ?? null;
    }
    const providerName = targetAgent
      ? row.handlerAgentProvider ?? DEFAULT_PROVIDER_NAME
      : row.handlerNodeId
        ? row.handlerProvider ?? DEFAULT_PROVIDER_NAME
        : isBuiltinReleaseInvocation(row)
          ? row.dispatchedProvider ?? DEFAULT_PROVIDER_NAME
          : shadowProvider
            ?? (isSpawnInvocation(row.actionName)
              ? (await capacityProviderName(db, workspaceId, nodeId, dispatchActionNameForInvocation(row.actionName, input))) ?? DEFAULT_PROVIDER_NAME
              : DEFAULT_PROVIDER_NAME);
    const nativeSpawn = isSpawnInvocation(row.actionName) && !shadowProvider;

    // Skip draining to a provider that is disconnected or whose heartbeat says
    // handlers are not live. A missing provider row is a legacy single-socket
    // node, for which connection state remains the available liveness signal.
    if (!(await isHandlerConnectionLive(db, registry, workspaceId, nodeId, providerName))) continue;

    let reservedForDrain = false;
    try {
      let reservationHeld = nativeSpawn && !!row.spawnReservedAt;
      if (nativeSpawn && !reservationHeld) {
        const reserved = await reserveNodeCapacity(db, workspaceId, nodeId);
        if (!reserved) {
          const [node] = await db
            .select({
              status: nodes.status,
              handlersLive: nodes.handlersLive,
              lastHeartbeatAt: nodes.lastHeartbeatAt,
            })
            .from(nodes)
            .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
          if (node && isNodeLive(node) && node.handlersLive) {
            await db
              .update(actionInvocations)
              .set({ retryAfterAt: new Date(Date.now() + NODE_DRAIN_REQUEUE_RETRY_MS) })
              .where(and(
                eq(actionInvocations.workspaceId, workspaceId),
                eq(actionInvocations.id, row.id),
                eq(actionInvocations.status, 'pending'),
              ));
          }
          continue;
        }
        reservationHeld = true;
        reservedForDrain = true;
      }

      const dispatched = await dispatchNodeInvocation({
        db,
        registry,
        workspaceId,
        invocationId: row.id,
        nodeId,
        providerName,
        action: dispatchActionNameForInvocation(row.actionName, input),
        input,
        agent: targetAgent ? { id: targetAgent.id, name: targetAgent.name } : null,
        actionId: row.actionId,
        invocationOrigin: row.invocationOrigin,
        retryAfterAt: new Date(Date.now() + ACTION_DISPATCH_TIMEOUT_MS),
        reservationHeld,
        skipIncrementAttempts: row.dispatchedNodeId === nodeId,
      });
      if (dispatched.accepted) {
        drained++;
      } else if (reservedForDrain) {
        await releaseNodeCapacity(db, workspaceId, nodeId);
      }
    } catch {
      if (reservedForDrain) {
        await releaseNodeCapacity(db, workspaceId, nodeId).catch(() => {});
      }
      // Leave the invocation pending; a later drain or timeout sweep can retry.
    }
  }
  return drained;
}

export async function rescheduleNodeInvocation(
  db: Db,
  registry: NodeConnectionRegistry,
  invocation: RetryableInvocationRow,
  opts: { allowAttemptedFallback?: boolean; retryAfterAt?: Date | null } = {},
) {
  if (isDeletedRegisteredActionInvocation(invocation)) {
    await failOpenInvocationRows(db, invocation.workspaceId, [invocation.id], 'action_deleted');
    return false;
  }
  // Only release capacity the invocation actually holds. A shadowed spawn
  // dropped its native reservation at dispatch (spawnReservedAt is null), so it
  // must not release capacity that now belongs to another spawn.
  if (invocation.dispatchedNodeId && isSpawnInvocation(invocation.actionName) && invocation.spawnReservedAt) {
    await releaseNodeCapacity(db, invocation.workspaceId, invocation.dispatchedNodeId);
  }
  // A shadowed spawn stays pinned to its node: while a `spawn:<harness>` shadow
  // is registered there, native capacity for that harness is unreachable — even
  // across a node loss — so it never falls through to generic placement (which
  // would silently bypass the shadow). It re-drains when the provider returns.
  if (invocation.dispatchedNodeId && isSpawnInvocation(invocation.actionName)) {
    const capability = dispatchActionNameForInvocation(invocation.actionName, recordInput(invocation.input));
    const shadow = await fetchNodeAction(db, invocation.workspaceId, invocation.dispatchedNodeId, capability);
    if (shadow) {
      await db
        .update(actionInvocations)
        .set({ status: 'pending', dispatchedAt: null, spawnReservedAt: null, retryAfterAt: null })
        .where(and(
          eq(actionInvocations.workspaceId, invocation.workspaceId),
          eq(actionInvocations.id, invocation.id),
          inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
        ));
      return false;
    }
  }
  const targetAgent = await targetAgentForInvocation(db, invocation);
  if (targetAgent) {
    const dispatched = await dispatchNodeInvocation({
      db,
      registry,
      workspaceId: invocation.workspaceId,
      invocationId: invocation.id,
      nodeId: targetAgent.nodeId,
      providerName: targetAgent.providerName,
      action: invocation.actionName,
      input: recordInput(invocation.input),
      agent: { id: targetAgent.agentId, name: targetAgent.agentName },
      actionId: targetAgent.actionId,
      invocationOrigin: invocation.invocationOrigin,
      retryAfterAt: opts.retryAfterAt ?? null,
    });
    return dispatched.accepted;
  }
  // Release invocations carry no actionId, so targetAgentForInvocation() returns
  // null. They must never fall through to generic node placement, which could
  // route a release to an unrelated node that doesn't own the agent.
  if (isBuiltinReleaseInvocation(invocation)) {
    return false;
  }
  const attempted = attemptedNodeSet(invocation);
  const current = invocation.dispatchedNodeId ? [invocation.dispatchedNodeId] : [];
  const input = recordInput(invocation.input);
  const actionToSend = dispatchActionNameForInvocation(invocation.actionName, input);
  const baseExclude = Array.from(new Set([...attempted, ...current]));
  const candidates = opts.allowAttemptedFallback ? [baseExclude, []] : [baseExclude];
  const providerRejectedNodeIds = new Set<string>();

  for (const candidateExcludes of candidates) {
    const excludeNodeIds = new Set([...candidateExcludes, ...providerRejectedNodeIds]);
    while (true) {
      try {
        const placement = await selectRetryPlacement(db, invocation, Array.from(excludeNodeIds));
        // Resolve the owning provider before accepting node-level queued
        // placement. A node can be live through its broker while the named
        // provider for this action is offline, and provider queue policy must
        // decide whether that retry may wait.
        const target = await fetchNodeAction(db, invocation.workspaceId, placement.node.id, actionToSend);
        const reservationHeld = isSpawnInvocation(invocation.actionName) && !placement.queued;
        if (target?.handlerProvider) {
          // A spawn shadow is an action, not native capacity. claimSpawnNode
          // reserved capacity before discovering the shadow, so release it just
          // like the initial dispatch path does before provider dispatch.
          if (reservationHeld) {
            await releaseNodeCapacity(db, invocation.workspaceId, placement.node.id);
          }
          const dispatched = await dispatchNodeProviderInvocation({
            db,
            registry,
            workspaceId: invocation.workspaceId,
            invocationId: invocation.id,
            nodeId: placement.node.id,
            providerName: target.handlerProvider,
            action: actionToSend,
            actionId: target.id,
            invocationOrigin: invocation.invocationOrigin,
            input,
            queue: target.queue,
            reservationHeld: false,
          }, { failIfUnavailable: false });
          if (dispatched.providerUnavailable) {
            providerRejectedNodeIds.add(placement.node.id);
            excludeNodeIds.add(placement.node.id);
            continue;
          }
          return dispatched.accepted;
        }

        // No named action owner means native spawn/capacity or a legacy
        // single-socket node; retain the node-level pending/default behavior.
        const providerName = isSpawnInvocation(invocation.actionName)
          ? (await capacityProviderName(db, invocation.workspaceId, placement.node.id, actionToSend)) ?? DEFAULT_PROVIDER_NAME
          : DEFAULT_PROVIDER_NAME;
        if (placement.queued) {
          await dispatchNodeAttempt(db, invocation.workspaceId, invocation.id, placement.node.id, {
            providerName,
            pending: true,
            retryAfterAt: opts.retryAfterAt ?? null,
            reservationHeld: false,
            actionId: target?.id,
          });
          return true;
        }
        const dispatched = await dispatchNodeInvocation({
          db,
          registry,
          workspaceId: invocation.workspaceId,
          invocationId: invocation.id,
          nodeId: placement.node.id,
          providerName,
          action: actionToSend,
          actionId: target?.id ?? null,
          invocationOrigin: invocation.invocationOrigin,
          input,
          reservationHeld,
        });
        return dispatched.accepted;
      } catch {
        // This candidate phase is exhausted; optionally retry attempted nodes.
        break;
      }
    }
  }

  if (providerRejectedNodeIds.size > 0) {
    await failInvocationForUnavailableProvider(db, invocation.workspaceId, invocation.id);
    return false;
  }

  await db
    .update(actionInvocations)
    .set({
      status: 'pending',
      dispatchedNodeId: null,
      dispatchedProvider: null,
      dispatchedAt: null,
      spawnReservedAt: null,
      retryAfterAt: opts.retryAfterAt ?? nextRetryAfter(invocation.dispatchAttempts + 1),
    })
    .where(and(
      eq(actionInvocations.workspaceId, invocation.workspaceId),
      eq(actionInvocations.id, invocation.id),
      inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
    ));
  return false;
}

export async function rescheduleInvocationsForLostNode(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
) {
  const rows = await db
    .select()
    .from(actionInvocations)
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.dispatchedNodeId, nodeId),
      inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
    ));

  let rescheduled = 0;
  for (const invocation of rows) {
    try {
      if (await rescheduleNodeInvocation(db, registry, invocation, { retryAfterAt: nextRetryAfter(invocation.dispatchAttempts + 1) })) {
        rescheduled++;
      }
    } catch {
      // Keep the invocation pending; another heartbeat/sweep can retry.
      await db
        .update(actionInvocations)
        .set({
          status: 'pending',
          dispatchedNodeId: null,
          dispatchedProvider: null,
          dispatchedAt: null,
          spawnReservedAt: null,
          retryAfterAt: nextRetryAfter(invocation.dispatchAttempts + 1),
        })
        .where(eq(actionInvocations.id, invocation.id));
    }
  }
  return rescheduled;
}

export async function completeInvocation(
  db: Db,
  workspaceId: string,
  actionName: string,
  invocationId: string,
  data: {
    output?: unknown;
    error?: string;
    duration_ms?: number;
    caller_agent_id?: string;
  },
) {
  // Fetch the invocation joined with its action — verify action name matches URL param
  const [existing] = await db
    .select({
      id: actionInvocations.id,
      status: actionInvocations.status,
      actionName: actionInvocations.actionName,
      attemptedNodeIds: actionInvocations.attemptedNodeIds,
      dispatchAttempts: actionInvocations.dispatchAttempts,
      dispatchedNodeId: actionInvocations.dispatchedNodeId,
      handlerAgentId: actions.handlerAgentId,
      handlerNodeId: actions.handlerNodeId,
    })
    .from(actionInvocations)
    .leftJoin(actions, eq(actionInvocations.actionId, actions.id))
    .where(
      and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocationId),
        eq(actionInvocations.actionName, actionName),
      ),
    );

  if (!existing) return null;

  if (existing.handlerNodeId || (!existing.handlerAgentId && existing.dispatchedNodeId)) {
    throw codedError('Node-owned invocations must be completed over the node control channel', 'node_owned_invocation', 403);
  }

  // Agent tokens must belong to the handler agent
  if (data.caller_agent_id && existing.handlerAgentId && data.caller_agent_id !== existing.handlerAgentId) {
    throw codedError('Only the handler agent can complete this invocation', 'forbidden', 403);
  }

  const status = data.error ? 'failed' : 'completed';

  const [updated] = await db
    .update(actionInvocations)
    .set({
      output: data.output ?? null,
      error: data.error ?? null,
      status,
      durationMs: data.duration_ms ?? null,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocationId),
        eq(actionInvocations.actionName, actionName),
        inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
      ),
    )
    .returning();

  if (!updated) return null;

  return publicInvocation(updated);
}

export async function completeNodeInvocation(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
  providerName: string,
  invocationId: string,
  data: {
    output?: unknown;
    error?: string;
  },
  deps?: InvocationCompletionDeps,
) {
  const [existing] = await db
    .select({
      id: actionInvocations.id,
      workspaceId: actionInvocations.workspaceId,
      actionId: actionInvocations.actionId,
      invocationOrigin: actionInvocations.invocationOrigin,
      actionName: actionInvocations.actionName,
      callerId: actionInvocations.callerId,
      input: actionInvocations.input,
      output: actionInvocations.output,
      status: actionInvocations.status,
      error: actionInvocations.error,
      durationMs: actionInvocations.durationMs,
      dispatchedNodeId: actionInvocations.dispatchedNodeId,
      dispatchedAt: actionInvocations.dispatchedAt,
      spawnReservedAt: actionInvocations.spawnReservedAt,
      attemptedNodeIds: actionInvocations.attemptedNodeIds,
      dispatchAttempts: actionInvocations.dispatchAttempts,
      createdAt: actionInvocations.createdAt,
      completedAt: actionInvocations.completedAt,
    })
    .from(actionInvocations)
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.id, invocationId),
      eq(actionInvocations.dispatchedProvider, providerName),
    ));

  if (!existing) return null;

  if (existing.dispatchedNodeId && existing.dispatchedNodeId !== nodeId) {
    return null;
  }

  if (existing.status === 'completed' || existing.status === 'failed') {
    return null;
  }

  if (data.error === 'handler_unavailable') {
    await db
      .update(nodes)
      .set({ handlersLive: false })
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
    try {
      if (await rescheduleNodeInvocation(db, registry, existing, { retryAfterAt: nextRetryAfter(existing.dispatchAttempts + 1) })) {
        return null;
      }
    } catch {
      // Fall through and fail the invocation if no eligible node exists.
    }
  }

  if (
    !data.error
    && isBuiltinReleaseInvocation(existing)
    && releaseExpectedTokenHash(recordInput(existing.input))
  ) {
    return completeGuardedReleaseNodeInvocation(
      db,
      workspaceId,
      nodeId,
      providerName,
      existing,
      data,
      deps,
    );
  }

  const [updated] = await db
    .update(actionInvocations)
    .set({
      output: data.output ?? null,
      error: data.error ?? null,
      status: data.error ? 'failed' : 'completed',
      completedAt: new Date(),
      spawnReservedAt: null,
    })
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.id, invocationId),
      eq(actionInvocations.dispatchedNodeId, nodeId),
      eq(actionInvocations.dispatchedProvider, providerName),
      inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
    ))
    .returning();

  // Release only capacity this invocation actually reserved. A shadowed spawn
  // holds no native reservation (spawnReservedAt is null), so releasing here
  // would decrement capacity owned by another spawn.
  if (updated && isSpawnInvocation(updated.actionName) && updated.dispatchedNodeId && existing.spawnReservedAt) {
    await releaseNodeCapacity(db, workspaceId, updated.dispatchedNodeId);
  }

  if (updated) {
    await applyReleaseCompletionEffect(db, workspaceId, nodeId, existing, data, deps);
  }

  return updated ? publicInvocation(updated) : null;
}

/**
 * Bound the wait on agent-handled invocations: an open invocation whose handler
 * agent's connection has been CONTINUOUSLY unreachable for the TTL is failed
 * with `handler_unavailable` — emitting `action.failed` to the caller when
 * completion deps are provided — instead of staying `pending`/`dispatched`
 * forever. The first unreachable observation stamps
 * `handler_unreachable_since`; a recovered connection clears it, so a brief
 * handler restart never kills an invocation regardless of its age.
 */
async function failUnreachableAgentInvocations(
  db: Db,
  registry: NodeConnectionRegistry,
  ttlMs: number,
  completionDeps?: InvocationCompletionDeps,
): Promise<void> {
  const rows = await db
    .select({
      id: actionInvocations.id,
      workspaceId: actionInvocations.workspaceId,
      handlerUnreachableSince: actionInvocations.handlerUnreachableSince,
    })
    .from(actionInvocations)
    .innerJoin(actions, eq(actionInvocations.actionId, actions.id))
    .where(and(
      inArray(actionInvocations.status, ['pending', 'dispatched']),
      isNull(actions.handlerNodeId),
      isNotNull(actions.handlerAgentId),
    ));

  for (const row of rows) {
    try {
      // targetAgentForInvocation returns null when the handler agent is gone or
      // no longer node-bound — both count as unreachable.
      const target = await targetAgentForInvocation(db, row);
      const reachable = !!target
        && await isHandlerConnectionLive(db, registry, row.workspaceId, target.nodeId, target.providerName);
      if (reachable) {
        if (row.handlerUnreachableSince) {
          await db
            .update(actionInvocations)
            .set({ handlerUnreachableSince: null })
            .where(and(eq(actionInvocations.workspaceId, row.workspaceId), eq(actionInvocations.id, row.id)));
        }
        continue;
      }
      const since = row.handlerUnreachableSince ?? new Date();
      if (!row.handlerUnreachableSince) {
        await db
          .update(actionInvocations)
          .set({ handlerUnreachableSince: since })
          .where(and(
            eq(actionInvocations.workspaceId, row.workspaceId),
            eq(actionInvocations.id, row.id),
            inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
          ));
      }
      if (Date.now() - since.getTime() >= ttlMs) {
        await failOpenInvocations(db, row.workspaceId, [row.id], 'handler_unavailable', completionDeps);
      }
    } catch {
      // Leave the invocation for the next sweep.
    }
  }
}

/**
 * Absolute-age bound for never-dispatched pending invocations. The
 * handler-unreachable TTL keys off a dispatched connection going quiet; an
 * invocation that never left the queue has no handler to observe, so it needs
 * its own bound. Fails rows that are `pending`, have `dispatch_attempts = 0`,
 * and are older than `maxAgeMs` with a distinguishing error so operators can
 * tell a never-dispatched expiry from a handler-that-went-quiet expiry.
 */
async function failNeverDispatchedExpiredInvocations(
  db: Db,
  maxAgeMs: number,
  graceMs: number,
  completionDeps?: InvocationCompletionDeps,
): Promise<void> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const rows = await db
    .select({ id: actionInvocations.id, workspaceId: actionInvocations.workspaceId })
    .from(actionInvocations)
    .where(and(
      eq(actionInvocations.status, 'pending'),
      eq(actionInvocations.dispatchAttempts, 0),
      lte(actionInvocations.createdAt, cutoff),
    ));

  if (rows.length === 0) return;

  // Give any concurrent dispatcher's send→record window (`dispatchNodeAttempt`
  // UPDATE, one D1 round-trip) time to close before the atomic UPDATE fires.
  // Combined with the UPDATE's `dispatch_attempts = 0` re-check, this makes an
  // in-flight dispatch reliably invisible to the age sweep instead of racing
  // with it. See `NEVER_DISPATCHED_SWEEP_GRACE_MS`.
  if (graceMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, graceMs));
  }

  const byWorkspace = new Map<string, string[]>();
  for (const row of rows) {
    const list = byWorkspace.get(row.workspaceId) ?? [];
    list.push(row.id);
    byWorkspace.set(row.workspaceId, list);
  }
  for (const [workspaceId, ids] of byWorkspace) {
    // Chunk ids so the IN clause stays under D1's 100-bound-parameter cap. A per-
    // chunk try/catch keeps one bad chunk from stalling the whole workspace, so a
    // large stale backlog can actually drain across sweeps.
    for (let i = 0; i < ids.length; i += D1_SAFE_IN_QUERY_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + D1_SAFE_IN_QUERY_CHUNK_SIZE);
      try {
        const failed = await failNeverDispatchedInvocationRows(
          db,
          workspaceId,
          chunk,
          cutoff,
          'never_dispatched_expired',
        );
        if (completionDeps && failed.length > 0) {
          await emitFailedInvocationEffects(completionDeps, workspaceId, failed);
        }
      } catch {
        // Leave this chunk for the next sweep; other chunks still get their shot.
      }
    }
  }
}

/**
 * Terminally fail never-dispatched rows atomically: the UPDATE re-checks the
 * SELECT predicates (`status = 'pending'`, `dispatch_attempts = 0`, `created_at
 * <= cutoff`), so a row that was concurrently dispatched between the sweep's
 * SELECT and this UPDATE is skipped instead of being killed mid-flight. Never-
 * dispatched rows carry no spawn reservation (dispatch_attempts = 0 means no
 * node was ever chosen), so no capacity release is needed.
 */
async function failNeverDispatchedInvocationRows(
  db: Db,
  workspaceId: string,
  invocationIds: string[],
  cutoff: Date,
  error: string,
): Promise<InvocationRow[]> {
  if (invocationIds.length === 0) return [];
  return await db
    .update(actionInvocations)
    .set({ status: 'failed', error, completedAt: new Date(), spawnReservedAt: null })
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      inArray(actionInvocations.id, invocationIds),
      eq(actionInvocations.status, 'pending'),
      eq(actionInvocations.dispatchAttempts, 0),
      lte(actionInvocations.createdAt, cutoff),
    ))
    .returning();
}

export async function sweepTimedOutInvocations(
  db: Db,
  registry: NodeConnectionRegistry,
  opts: SweepTimedOutInvocationsOptions | number | null = {},
) {
  const sweepOpts = typeof opts === 'number' || opts === null ? {} : opts;
  const timeoutMs = typeof opts === 'number' ? opts : sweepOpts.timeoutMs ?? ACTION_DISPATCH_TIMEOUT_MS;
  await failUnreachableAgentInvocations(
    db,
    registry,
    sweepOpts.handlerUnreachableTtlMs ?? ACTION_HANDLER_UNREACHABLE_TTL_MS,
    sweepOpts.completionDeps,
  );
  await failNeverDispatchedExpiredInvocations(
    db,
    sweepOpts.pendingInvocationMaxAgeMs ?? PENDING_INVOCATION_MAX_AGE_MS,
    sweepOpts.neverDispatchedSweepGraceMs ?? NEVER_DISPATCHED_SWEEP_GRACE_MS,
    sweepOpts.completionDeps,
  );
  const now = new Date();
  const cutoff = new Date(Date.now() - timeoutMs);
  const rows = await db
    .select()
    .from(actionInvocations)
    .where(and(
      inArray(actionInvocations.status, ['dispatched']),
      lte(actionInvocations.dispatchedAt, cutoff),
    ));

  const pendingRows = await db
    .select()
    .from(actionInvocations)
    .where(and(
      eq(actionInvocations.status, 'pending'),
      lte(actionInvocations.retryAfterAt, now),
    ));

  let rescheduled = 0;
  for (const invocation of [...rows, ...pendingRows]) {
    try {
      const allowFallback = invocation.status === 'pending';
      if (await rescheduleNodeInvocation(db, registry, invocation, {
        allowAttemptedFallback: allowFallback,
        retryAfterAt: allowFallback ? null : nextRetryAfter(invocation.dispatchAttempts + 1),
      })) {
        rescheduled++;
      }
    } catch {
      // Leave the invocation for the next sweep.
    }
  }
  return rescheduled;
}

export async function getInvocation(db: Db, workspaceId: string, actionName: string, invocationId: string) {
  const [row] = await db
    .select()
    .from(actionInvocations)
    .where(
      and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocationId),
        eq(actionInvocations.actionName, actionName),
      ),
    );

  if (!row) return null;
  return publicInvocation(row);
}
