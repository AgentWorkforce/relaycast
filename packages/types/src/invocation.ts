import { z } from 'zod';

/**
 * Lifecycle event types recorded on an action invocation's timeline. Readers
 * must tolerate types they do not know: the list grows additively.
 */
export const ACTION_INVOCATION_EVENT_TYPES = [
  /** The invocation was accepted from its caller. */
  'created',
  /** Placement chose a node (spawns). */
  'placed',
  /** Assigned to a node whose provider was not connected; sent when it is. */
  'queued',
  /** The `action.invoke` frame was delivered to a node. */
  'dispatched',
  /** The `action.invoke` frame could not be sent to the placed node. */
  'send_failed',
  /** The node acknowledged ownership (`action.accept`). */
  'acknowledged',
  /** An agent registered through a node naming this invocation. */
  'agent_registered',
  /** A node reported a result that was applied. */
  'result_received',
  /** A node reported a result that was not applied; `reason` says why. */
  'result_rejected',
  /** The invocation left its node and went back to placement; `reason` says why. */
  'requeued',
  /**
   * A spawn about to be requeued already had a registered agent, so it was
   * settled as started by that agent instead of being launched again.
   */
  'started',
  'completed',
  'failed',
  /** The agent this spawn started has exited or was released. */
  'agent_exited',
] as const;
export type ActionInvocationEventType = (typeof ACTION_INVOCATION_EVENT_TYPES)[number];

/** Why a node's `action.result` was not applied. */
export const ACTION_RESULT_REJECTION_REASONS = [
  /** No invocation with that id exists in the workspace. */
  'unknown_invocation',
  /** The invocation had already completed or failed. */
  'already_settled',
  /** The invocation is currently dispatched to a different node. */
  'dispatched_to_other_node',
  /** The result came from a provider connection that did not receive the work. */
  'wrong_provider',
  /** The invocation was requeued and is not dispatched to any node. */
  'not_dispatched',
  /** The invocation changed state while the result was being applied. */
  'state_changed',
  /** The frame failed schema validation. */
  'invalid_payload',
] as const;
export type ActionResultRejectionReason = (typeof ACTION_RESULT_REJECTION_REASONS)[number];

/** Why an invocation was taken off its node and returned to placement. */
export const ACTION_INVOCATION_REQUEUE_REASONS = [
  /** No result arrived within the dispatch timeout. */
  'dispatch_timeout',
  /** The node went offline; `detail` is liveness_timeout, disconnected or deregistered. */
  'node_lost',
  /** The node's inventory.sync did not list the invocation's agent. */
  'inventory_missing',
  /** The node reported handler_unavailable. */
  'handler_unavailable',
  /** A queued or deferred attempt became due for placement again. */
  'retry_due',
] as const;
export type ActionInvocationRequeueReason = (typeof ACTION_INVOCATION_REQUEUE_REASONS)[number];

export const ActionInvocationEventSchema = z.object({
  /** ISO-8601 time the engine recorded the event. */
  at: z.string(),
  type: z.string(),
  node_id: z.string().nullable().optional(),
  provider: z.string().optional(),
  /** Dispatch attempt number for queued/dispatched events. */
  attempt: z.number().int().optional(),
  capability: z.string().optional(),
  /** Structured reason code (rejection, requeue, completion source). */
  reason: z.string().optional(),
  /** Further detail for `reason`, e.g. the node-offline cause. */
  detail: z.string().optional(),
  /** Error code reported by a node or set by the engine. */
  error: z.string().optional(),
  /** Whether a received/rejected result reported success. */
  ok: z.boolean().optional(),
  agent_id: z.string().optional(),
  agent_name: z.string().optional(),
}).passthrough();
export type ActionInvocationEvent = z.infer<typeof ActionInvocationEventSchema>;

/** The live agent that registered through a node naming this invocation. */
export const ActionInvocationRegisteredAgentSchema = z.object({
  agent_id: z.string(),
  name: z.string(),
  status: z.string(),
  node_id: z.string().nullable(),
  registered_at: z.string().nullable(),
});
export type ActionInvocationRegisteredAgent = z.infer<typeof ActionInvocationRegisteredAgentSchema>;

/** `GET /v1/actions/{name}/invocations/{id}` response data. */
export const ActionInvocationSchema = z.object({
  invocation_id: z.string(),
  action_name: z.string(),
  caller_id: z.string().nullable(),
  caller_name: z.string().nullable(),
  input: z.unknown(),
  output: z.unknown(),
  status: z.string(),
  error: z.string().nullable(),
  duration_ms: z.number().nullable(),
  dispatched_node_id: z.string().nullable(),
  dispatched_at: z.string().nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
  task_execution: z.record(z.string(), z.unknown()).optional(),
  /** Bounded lifecycle timeline, oldest first; the first event is always kept. */
  events: z.array(ActionInvocationEventSchema).optional(),
  /** One sentence describing what happened, derived from the row and timeline. */
  explanation: z.string().optional(),
  registered_agent: ActionInvocationRegisteredAgentSchema.nullable().optional(),
});
export type ActionInvocation = z.infer<typeof ActionInvocationSchema>;
