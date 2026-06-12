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

const FleetWireEnvelopeFields = {
  v: FleetWireVersionSchema,
} as const;

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
    ...FleetWireEnvelopeFields,
    type: z.literal('node.register'),
    name: z.string(),
    node_id: z.string(),
    capabilities: z.array(z.string()),
    max_agents: z.number().int().nonnegative(),
    tags: z.array(z.string()),
    version: z.string(),
    // Absent and null both mean a fresh node with no resume cursor.
    resume_cursor: z.string().nullable().optional(),
  })
  .strict();
export type FleetNodeRegisterMessage = z.infer<typeof FleetNodeRegisterMessageSchema>;

export const FleetNodeHeartbeatMessageSchema = z
  .object({
    ...FleetWireEnvelopeFields,
    type: z.literal('node.heartbeat'),
    load: z.number().finite().nonnegative(),
    active_agents: z.number().int().nonnegative(),
    handlers_live: z.boolean(),
  })
  .strict();
export type FleetNodeHeartbeatMessage = z.infer<typeof FleetNodeHeartbeatMessageSchema>;

export const FleetNodeDeregisterMessageSchema = z
  .object({
    ...FleetWireEnvelopeFields,
    type: z.literal('node.deregister'),
  })
  .strict();
export type FleetNodeDeregisterMessage = z.infer<typeof FleetNodeDeregisterMessageSchema>;

export const FleetAgentRegisterMessageSchema = z
  .object({
    ...FleetWireEnvelopeFields,
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
    ...FleetWireEnvelopeFields,
    type: z.literal('agent.deregister'),
    name: z.string(),
  })
  .strict();
export type FleetAgentDeregisterMessage = z.infer<typeof FleetAgentDeregisterMessageSchema>;

export const FleetDeliveryAckMessageSchema = z
  .object({
    ...FleetWireEnvelopeFields,
    type: z.literal('delivery.ack'),
    agent: z.string(),
    up_to_seq: z.number().int().nonnegative(),
  })
  .strict();
export type FleetDeliveryAckMessage = z.infer<typeof FleetDeliveryAckMessageSchema>;

export const FleetActionResultOutputMessageSchema = z
  .object({
    ...FleetWireEnvelopeFields,
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
    ...FleetWireEnvelopeFields,
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
    ...FleetWireEnvelopeFields,
    type: z.literal('inventory.sync'),
    agents: z.array(FleetInventoryAgentSchema),
  })
  .strict();
export type FleetInventorySyncMessage = z.infer<typeof FleetInventorySyncMessageSchema>;

export const FleetDeliverMessageSchema = z
  .object({
    ...FleetWireEnvelopeFields,
    type: z.literal('deliver'),
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
    input: FleetWireJsonValueSchema,
  })
  .strict();
export type FleetActionInvokeMessage = z.infer<typeof FleetActionInvokeMessageSchema>;

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
  FleetPingMessageSchema,
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
