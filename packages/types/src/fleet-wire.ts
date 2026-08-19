import { z } from 'zod';

export type FleetWireJsonValue =
  | string
  | number
  | boolean
  | null
  | FleetWireJsonValue[]
  | { [key: string]: FleetWireJsonValue };

export const FleetWireJsonValueSchema: z.ZodType<FleetWireJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(FleetWireJsonValueSchema),
    z.record(z.string(), FleetWireJsonValueSchema),
  ]),
);

export const FleetWireVersionSchema = z.literal(1);
export type FleetWireVersion = z.infer<typeof FleetWireVersionSchema>;

export const FleetDeliveryModeSchema = z.enum(['wait', 'steer']);
export type FleetDeliveryMode = z.infer<typeof FleetDeliveryModeSchema>;

/**
 * Negotiates an authoritative delivery cursor in `agent.register` replies.
 * It is a capacity capability so older engines never materialize it as an
 * invokable action.
 */
export const FLEET_DELIVERY_CURSOR_CAPABILITY = 'relay:delivery-cursor-v1';

const FleetWireEnvelopeFields = {
  v: FleetWireVersionSchema,
} as const;

const FleetRequestEnvelopeFields = {
  ...FleetWireEnvelopeFields,
  id: z.string().optional(),
} as const;

const FleetResponseEnvelopeFields = {
  ...FleetWireEnvelopeFields,
  id: z.string(),
} as const;

/**
 * Canonical capability kinds. `action` capabilities are invokable handlers the
 * engine materializes and dispatches to the registering provider; `capacity`
 * capabilities (`spawn:<harness>`, `release`) describe what a node can run and
 * feed placement and `ctx.spawnAgent` delegation without being materialized.
 * Registrations that omit `kind` (or carry a legacy value) are classified by
 * name: `spawn:*` and `release` are capacity, everything else is an action.
 */
export const FleetCapabilityKindSchema = z.enum(['action', 'capacity']);
export type FleetCapabilityKind = z.infer<typeof FleetCapabilityKindSchema>;

export const FleetCapabilitySchema = z
  .object({
    name: z.string(),
    kind: z.string().optional(),
    /** `action` capability opts into a workspace-global alias claiming this name. */
    global: z.boolean().optional(),
    /** `action` capability opts into the offline queue when its provider is down. */
    queue: z.boolean().optional(),
    metadata: z.record(z.string(), FleetWireJsonValueSchema).optional(),
  })
  .strict();
export type FleetCapability = z.infer<typeof FleetCapabilitySchema>;

/**
 * Provider identity carried on connection-scoped node frames. `name` is the
 * provider's stable identity — persistence, capability-conflict checks, and
 * routing key on it. `instance_id` is the connection epoch: re-registering the
 * same name with a new instance replaces the previous attachment (reconnect),
 * while a name whose current instance is still connected is rejected.
 */
export const FleetProviderIdentitySchema = z
  .object({
    name: z.string(),
    instance_id: z.string(),
  })
  .strict();
export type FleetProviderIdentity = z.infer<typeof FleetProviderIdentitySchema>;

/** Per-capability outcome reported in a `node.register` reply. */
export const FleetCapabilityAcceptanceSchema = z
  .object({
    name: z.string(),
    kind: FleetCapabilityKindSchema,
    accepted: z.boolean(),
    reason: z.string().optional(),
  })
  .strict();
export type FleetCapabilityAcceptance = z.infer<typeof FleetCapabilityAcceptanceSchema>;

/**
 * A placement-safe repository identifier. Repository worktree paths are local
 * node configuration and must never cross the fleet control wire.
 */
export const FleetRepoKeySchema = z
  .string()
  .max(201)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
    'repo key must be an <owner>/<repo> identifier',
  );
export type FleetRepoKey = z.infer<typeof FleetRepoKeySchema>;

// `repo:<key>` is the persisted roster representation. Validate the legacy
// form too, so a path cannot bypass `repo_keys` through the generic tag list.
const FleetNodeTagSchema = z.string().refine(
  (tag) => !tag.startsWith('repo:') || FleetRepoKeySchema.safeParse(tag.slice('repo:'.length)).success,
  'repo tags must use the placement-safe repo:<owner>/<repo> form',
);

function forbidOwnProperty(property: string) {
  return (message: object, ctx: z.RefinementCtx): void => {
    if (Object.prototype.hasOwnProperty.call(message, property)) {
      ctx.addIssue({
        code: 'custom',
        path: [property],
        message: `action.result must omit ${property} for this variant`,
      });
    }
  };
}

export const FleetNodeRegisterMessageSchema = z
  .object({
    ...FleetRequestEnvelopeFields,
    type: z.literal('node.register'),
    name: z.string(),
    node_id: z.string(),
    // Absent means the synthetic `default` provider (the current broker), keyed
    // to the connection epoch — additive migration for pre-provider clients.
    provider: FleetProviderIdentitySchema.optional(),
    // The registering provider's own capabilities (fully replaces its prior set).
    capabilities: z.array(FleetCapabilitySchema),
    // Provider-level capacity; the node figure is the aggregate across providers.
    max_agents: z.number().int().nonnegative(),
    tags: z.array(FleetNodeTagSchema),
    // Repository identities are placement metadata only. Local repository paths
    // remain private to the registering node and are deliberately not accepted.
    repo_keys: z.array(FleetRepoKeySchema).optional(),
    version: z.string(),
    machine_id: z.string().optional(),
    // Absent and null both mean a fresh node with no resume cursor.
    resume_cursor: z.string().nullable().optional(),
  })
  .strict();
export type FleetNodeRegisterMessage = z.infer<typeof FleetNodeRegisterMessageSchema>;

export const FleetNodeHeartbeatMessageSchema = z
  .object({
    ...FleetRequestEnvelopeFields,
    type: z.literal('node.heartbeat'),
    // Heartbeats are provider-scoped by connection; absent provider means the
    // synthetic `default` provider. Load/active_agents/handlers_live describe
    // the sending provider, and the node figures aggregate across providers.
    provider: FleetProviderIdentitySchema.optional(),
    // Capacity utilization is absent/null until the provider has a genuine
    // measurement. Numeric values from legacy clients remain accepted for wire
    // compatibility but are only trusted when load_reported is explicitly true.
    load: z.number().finite().min(0).max(1).nullable().optional(),
    load_reported: z.boolean().optional(),
    active_agents: z.number().int().nonnegative(),
    handlers_live: z.boolean(),
    // Roster snapshot carried for liveness: lets the engine refresh a node's
    // descriptor (name/capabilities/max_agents/version) from the steady-state
    // heartbeat without waiting for a fresh node.register — important after an
    // engine restart where the broker keeps heartbeating an already-registered
    // node. All optional and backward-compatible: a minimal heartbeat
    // (load/active_agents/handlers_live only) is still valid.
    //
    // NOTE: the broker does NOT send last_heartbeat_at — receipt time is stamped
    // server-side by the engine as the single source of truth for liveness.
    name: z.string().optional(),
    node_id: z.string().optional(),
    capabilities: z.array(FleetCapabilitySchema).optional(),
    max_agents: z.number().int().nonnegative().optional(),
    version: z.string().optional(),
  })
  .superRefine((message, ctx) => {
    if (message.load_reported === true && typeof message.load !== 'number') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['load'],
        message: 'load must be numeric when load_reported is true',
      });
    }
  })
  .strict();
export type FleetNodeHeartbeatMessage = z.infer<typeof FleetNodeHeartbeatMessageSchema>;

export const FleetNodeDeregisterMessageSchema = z
  .object({
    ...FleetRequestEnvelopeFields,
    type: z.literal('node.deregister'),
    // Removes this provider's attachment and persisted capability set; absent
    // provider means the synthetic `default` provider.
    provider: FleetProviderIdentitySchema.optional(),
  })
  .strict();
export type FleetNodeDeregisterMessage = z.infer<typeof FleetNodeDeregisterMessageSchema>;

/**
 * `node.spawn` — a provider's handler context delegating a spawn to its own
 * node's capacity executor (the broker provider). Capacity-direct: the engine
 * bypasses action dispatch, so a `spawn:<harness>` shadow handler that delegates
 * cannot re-enter itself. The target is always the connection's node — a node
 * credential cannot direct a spawn at another node (that is workspace-level
 * placement, which uses agent/workspace credentials).
 */
export const FleetNodeSpawnMessageSchema = z
  .object({
    ...FleetRequestEnvelopeFields,
    type: z.literal('node.spawn'),
    input: z.record(z.string(), FleetWireJsonValueSchema),
  })
  .strict();
export type FleetNodeSpawnMessage = z.infer<typeof FleetNodeSpawnMessageSchema>;

export const FleetAgentRegisterMessageSchema = z
  .object({
    ...FleetRequestEnvelopeFields,
    type: z.literal('agent.register'),
    name: z.string(),
    invocation_id: z.string().optional(),
    session_ref: z.string().optional(),
    resumable: z.boolean().optional(),
  })
  .strict();
export type FleetAgentRegisterMessage = z.infer<typeof FleetAgentRegisterMessageSchema>;

export const FleetAgentDeregisterMessageSchema = z
  .object({
    ...FleetRequestEnvelopeFields,
    type: z.literal('agent.deregister'),
    agent_id: z.string(),
    name: z.string().optional(),
  })
  .strict();
export type FleetAgentDeregisterMessage = z.infer<typeof FleetAgentDeregisterMessageSchema>;

export const FleetDeliveryAckMessageSchema = z
  .object({
    ...FleetRequestEnvelopeFields,
    type: z.literal('delivery.ack'),
    agent: z.string(),
    up_to_seq: z.number().int().nonnegative(),
  })
  .strict();
export type FleetDeliveryAckMessage = z.infer<typeof FleetDeliveryAckMessageSchema>;

export const FleetActionResultOutputMessageSchema = z
  .object({
    ...FleetRequestEnvelopeFields,
    type: z.literal('action.result'),
    invocation_id: z.string(),
    output: FleetWireJsonValueSchema,
    error: z.never().optional(),
  })
  .strict()
  .superRefine(forbidOwnProperty('error'));
export type FleetActionResultOutputMessage = z.infer<typeof FleetActionResultOutputMessageSchema>;

export const FleetActionResultErrorMessageSchema = z
  .object({
    ...FleetRequestEnvelopeFields,
    type: z.literal('action.result'),
    invocation_id: z.string(),
    error: z.string(),
    output: z.never().optional(),
  })
  .strict()
  .superRefine(forbidOwnProperty('output'));
export type FleetActionResultErrorMessage = z.infer<typeof FleetActionResultErrorMessageSchema>;

export const FleetActionResultMessageSchema = z.union([
  FleetActionResultOutputMessageSchema,
  FleetActionResultErrorMessageSchema,
]);
export type FleetActionResultMessage = z.infer<typeof FleetActionResultMessageSchema>;

export const FleetInventoryAgentSchema = z
  .object({
    agent_id: z.string(),
    name: z.string(),
    invocation_id: z.string().optional(),
    session_ref: z.string().optional(),
  })
  .strict();
export type FleetInventoryAgent = z.infer<typeof FleetInventoryAgentSchema>;

export const FleetInventorySyncMessageSchema = z
  .object({
    ...FleetRequestEnvelopeFields,
    type: z.literal('inventory.sync'),
    agents: z.array(FleetInventoryAgentSchema),
  })
  .strict();
export type FleetInventorySyncMessage = z.infer<typeof FleetInventorySyncMessageSchema>;

export const AgentRegisterReplyDataSchema = z
  .object({
    agent_id: z.string(),
    token: z.string(),
    name: z.string().optional(),
    // Returned only to nodes that advertise FLEET_DELIVERY_CURSOR_CAPABILITY.
    delivery_ack_seq: z.number().int().nonnegative().optional(),
  })
  .strict();
export type AgentRegisterReplyData = z.infer<typeof AgentRegisterReplyDataSchema>;

/**
 * `node.register` reply data. Carries the resolved provider identity and
 * per-capability acceptance alongside the node's public descriptor (which is
 * passed through as additional fields).
 */
export const NodeRegisterReplyDataSchema = z
  .object({
    provider: FleetProviderIdentitySchema,
    accepted_capabilities: z.array(FleetCapabilityAcceptanceSchema),
  })
  .passthrough();
export type NodeRegisterReplyData = z.infer<typeof NodeRegisterReplyDataSchema>;

export const FleetReplyMessageSchema = z
  .object({
    ...FleetResponseEnvelopeFields,
    type: z.literal('reply'),
    ok: z.literal(true),
    data: FleetWireJsonValueSchema,
  })
  .strict();
export type FleetReplyMessage = z.infer<typeof FleetReplyMessageSchema>;

export const FleetErrorMessageSchema = z
  .object({
    ...FleetResponseEnvelopeFields,
    type: z.literal('error'),
    ok: z.literal(false),
    code: z.string(),
    message: z.string(),
  })
  .strict();
export type FleetErrorMessage = z.infer<typeof FleetErrorMessageSchema>;

export const FleetDeliverMessageSchema = z
  .object({
    ...FleetWireEnvelopeFields,
    type: z.literal('deliver'),
    delivery_id: z.string(),
    agent_id: z.string(),
    agent: z.string(),
    msg_id: z.string(),
    seq: z.number().int().nonnegative(),
    mode: FleetDeliveryModeSchema,
    payload: FleetWireJsonValueSchema,
  })
  .strict();
export type FleetDeliverMessage = z.infer<typeof FleetDeliverMessageSchema>;

export const FleetActionInvokeMessageSchema = z
  .object({
    ...FleetWireEnvelopeFields,
    type: z.literal('action.invoke'),
    invocation_id: z.string(),
    action: z.string(),
    agent_id: z.string().optional(),
    agent_name: z.string().optional(),
    input: FleetWireJsonValueSchema,
  })
  .strict();
export type FleetActionInvokeMessage = z.infer<typeof FleetActionInvokeMessageSchema>;

export const FleetContextUpdateMessageSchema = z
  .object({
    ...FleetWireEnvelopeFields,
    type: z.literal('context.update'),
    topic: z.enum(['presence', 'channel', 'thread', 'agent']),
    event: z.string(),
    channel_id: z.string().nullable().optional(),
    agent_ids: z.array(z.string()).optional(),
    data: FleetWireJsonValueSchema,
  })
  .strict();
export type FleetContextUpdateMessage = z.infer<typeof FleetContextUpdateMessageSchema>;

export const FleetPingMessageSchema = z
  .object({
    ...FleetWireEnvelopeFields,
    type: z.literal('ping'),
  })
  .strict();
export type FleetPingMessage = z.infer<typeof FleetPingMessageSchema>;

export const FleetBrokerToRelaycastNonActionResultMessageSchema = z.discriminatedUnion('type', [
  FleetNodeRegisterMessageSchema,
  FleetNodeHeartbeatMessageSchema,
  FleetNodeDeregisterMessageSchema,
  FleetNodeSpawnMessageSchema,
  FleetAgentRegisterMessageSchema,
  FleetAgentDeregisterMessageSchema,
  FleetDeliveryAckMessageSchema,
  FleetInventorySyncMessageSchema,
]);
export type FleetBrokerToRelaycastNonActionResultMessage = z.infer<
  typeof FleetBrokerToRelaycastNonActionResultMessageSchema
>;

export const FleetBrokerToRelaycastMessageSchema = z.union([
  FleetBrokerToRelaycastNonActionResultMessageSchema,
  FleetActionResultMessageSchema,
]);
export type FleetBrokerToRelaycastMessage = z.infer<typeof FleetBrokerToRelaycastMessageSchema>;
export type FleetBrokerToRelaycastMessageType = FleetBrokerToRelaycastMessage['type'];

export const FleetRelaycastToBrokerMessageSchema = z.discriminatedUnion('type', [
  FleetDeliverMessageSchema,
  FleetActionInvokeMessageSchema,
  FleetContextUpdateMessageSchema,
  FleetPingMessageSchema,
  FleetReplyMessageSchema,
  FleetErrorMessageSchema,
]);
export type FleetRelaycastToBrokerMessage = z.infer<typeof FleetRelaycastToBrokerMessageSchema>;
export type FleetRelaycastToBrokerMessageType = FleetRelaycastToBrokerMessage['type'];

export function parseFleetBrokerToRelaycastMessage(
  value: unknown,
): FleetBrokerToRelaycastMessage {
  return FleetBrokerToRelaycastMessageSchema.parse(value);
}

export function parseFleetRelaycastToBrokerMessage(
  value: unknown,
): FleetRelaycastToBrokerMessage {
  return FleetRelaycastToBrokerMessageSchema.parse(value);
}
