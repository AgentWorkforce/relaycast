import { z } from 'zod';
import { FileAttachmentSchema } from './file.js';

// Durable delivery status lifecycle:
//   queued    -> durable row accepted, not yet sent to the current location
//   delivered -> sent to the current location, awaiting cumulative ack
//   acked     -> recipient location acknowledged through the seq cursor
//
// Failed/dead-lettered rows are terminal failure states used for explicit
// failure reports and TTL expiry respectively.
export const DeliveryStatusSchema = z.enum(['queued', 'delivered', 'acked', 'failed', 'dead_lettered']);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

// The sender-facing delivery state, derived from the stored row (the raw
// `status` is kept beside it for compatibility):
//   failed    -> status failed / dead_lettered (`error` says why)
//   replied   -> the recipient sent a DM back in the conversation (`replied_at`)
//   consumed  -> the recipient acked (status acked)
//   delivered -> the receiving software accepted it (`accepted_at`: the
//                `delivery.accepted` frame or an http_push 2xx). A host-side
//                socket write (raw status `delivered`, `delivered_at`) is NOT
//                enough: it proves nothing about the client, so it stays
//   queued    -> the row exists and delivery continues
export const DeliveryStateSchema = z.enum(['queued', 'delivered', 'consumed', 'replied', 'failed']);
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;

// The message payload carried alongside a queued delivery item so an offline
// consumer can recover what it missed without a second round-trip.
export const DeliveryMessageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  agent_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  /** Sender's `agent@machine` address at send time when the server recorded one, on direct messages and thread replies. Omitted when the sender has no location node. */
  agent_address: z.string().optional(),
  text: z.string(),
  thread_id: z.string().nullable(),
  created_at: z.string(),
  /** Stored files attached to the message; `GET /v1/files/{file_id}` returns a `download_url` for the bytes. */
  attachments: z.array(FileAttachmentSchema).optional(),
});
export type DeliveryMessage = z.infer<typeof DeliveryMessageSchema>;

export const DeliverySchema = z.object({
  id: z.string(),
  message_id: z.string(),
  channel_id: z.string(),
  agent_id: z.string(),
  status: DeliveryStatusSchema,
  seq: z.number(),
  location_type: z.string(),
  location_node_id: z.string().nullable(),
  route_node_id: z.string().nullable(),
  route_node_kind: z.string().nullable(),
  route_node_role: z.string().nullable(),
  delivery_adapter: z.string().nullable(),
  dispatch_attempts: z.number(),
  next_attempt_at: z.string().nullable(),
  last_dispatch_error: z.string().nullable(),
  mode: z.string(),
  reason: z.string().nullable(),
  priority: z.string(),
  retryable: z.boolean().nullable(),
  error: z.string().nullable(),
  available_at: z.string().nullable(),
  deadline: z.string().nullable(),
  expires_at: z.string().nullable(),
  delivered_at: z.string().nullable(),
  acked_at: z.string().nullable(),
  dead_lettered_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

// A queued delivery item: the delivery record plus the message it carries.
export const DeliveryItemSchema = DeliverySchema.extend({
  message: DeliveryMessageSchema.nullable(),
});
export type DeliveryItem = z.infer<typeof DeliveryItemSchema>;

export const ListDeliveriesQuerySchema = z.object({
  status: DeliveryStatusSchema.optional(),
  // Coerce so the same schema validates both typed callers and raw HTTP query strings.
  limit: z.coerce.number().int().positive().max(200).optional(),
  // Long-poll: milliseconds to hold an empty answer open until a delivery arrives.
  // A blank value is rejected rather than coerced to 0.
  wait: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? Number.NaN : value),
    z.coerce.number().int().min(0).max(25_000),
  ).optional(),
});
export type ListDeliveriesQuery = z.infer<typeof ListDeliveriesQuerySchema>;

export const FailDeliveryRequestSchema = z.object({
  error: z.string().optional(),
  retryable: z.boolean().optional(),
});
export type FailDeliveryRequest = z.infer<typeof FailDeliveryRequestSchema>;

export const DeferDeliveryRequestSchema = z.object({
  available_at: z.iso.datetime(),
  reason: z.string().optional(),
});
export type DeferDeliveryRequest = z.infer<typeof DeferDeliveryRequestSchema>;

// A delivery row as reported to the sender in a send response: enough to
// correlate later `delivery.*` events and `GET /v1/messages/:id/deliveries`.
export const SentDeliverySchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  status: DeliveryStatusSchema,
  /** Derived sender-facing state; `queued` at send time unless the send waited (`wait_ms`). `delivered` means the receiving software accepted it. */
  state: DeliveryStateSchema,
  /** When the receiving software accepted the row (`delivery.accepted`); `null` until then. */
  accepted_at: z.string().nullable(),
  /** When the recipient's explicit answer was recorded against the delivered row (a reply sent while the row was still queued is recorded when the row is delivered); `null` until then. */
  replied_at: z.string().nullable(),
  /** The recipient's reply once `replied_at` is set. */
  reply_message_id: z.string().nullable(),
  /** Failure reason once `state` is `failed`. */
  error: z.string().nullable(),
  expires_at: z.string().nullable(),
});
export type SentDelivery = z.infer<typeof SentDeliverySchema>;

// One recipient's delivery and read state for a message, as the sender sees it
// through `GET /v1/messages/:id/deliveries`.
export const MessageDeliveryReceiptSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  status: DeliveryStatusSchema,
  /** Derived sender-facing state (see `DeliveryStateSchema`). */
  state: DeliveryStateSchema,
  created_at: z.string(),
  delivered_at: z.string().nullable(),
  /** When the receiving software accepted the row (`delivery.accepted`, or an `http_push` 2xx). */
  accepted_at: z.string().nullable(),
  acked_at: z.string().nullable(),
  /** When the recipient's explicit answer was recorded against the delivered row (a reply sent while the row was still queued is recorded when the row is delivered); `null` until then (DMs only). */
  replied_at: z.string().nullable(),
  /** The recipient's reply message once `replied_at` is set. */
  reply_message_id: z.string().nullable(),
  dead_lettered_at: z.string().nullable(),
  error: z.string().nullable(),
  /** When the recipient marked the message read (or acked it, which also reads it); `null` until then. */
  read_at: z.string().nullable(),
});
export type MessageDeliveryReceipt = z.infer<typeof MessageDeliveryReceiptSchema>;

export const MessageDeliveriesResponseSchema = z.object({
  message_id: z.string(),
  deliveries: z.array(MessageDeliveryReceiptSchema),
});
export type MessageDeliveriesResponse = z.infer<typeof MessageDeliveriesResponseSchema>;
