/**
 * Wire contract of the split actor topology (prototype).
 *
 * In the default topology one `Workspace` actor runs the whole engine for a
 * workspace, so every write in it is serialized. In the split topology the
 * hot path runs on per-entity actors instead:
 *
 *   Workspace (metadata)  auth, directory, channel rosters, node bindings;
 *                         everything that is not the hot path
 *   Channel  <ws>-ch-<channel id>    message order, history, outbox
 *   Conversation <ws>-dm-<pair key>  1:1 DM order, history, outbox
 *   Inbox    <ws>-in-<agent id>      pending deliveries, delivery seq, ack cursor;
 *                                    the gateway opens one actor socket per
 *                                    agent attached to a node socket
 *
 * A send commits the message and one outbox entry per recipient in the
 * source actor (one write), and the caller hands each recipient's pending
 * entries to that recipient's inbox. Each (source, recipient) pair has its
 * own gap-free `source_seq`; an inbox applies entries in that order and
 * skips ones it already has, so a repeated or overlapping hand-off is
 * idempotent and a hand-off that raced ahead of an earlier one waits for it
 * (the source keeps unconfirmed entries and sends them again).
 */
import { z } from 'zod';

/**
 * Inbox delivery seqs start here, so a node socket that also receives
 * deliveries from the Workspace actor (routes outside the hot path) can tell
 * the two seq spaces apart when it acks.
 */
export const INBOX_SEQ_BASE = 1_000_000_000_000;

/** Most entries one hand-off carries per recipient; the rest follow on the next one. */
export const MAX_ENTRIES_PER_HANDOFF = 200;

/** Actor ids are 1-128 of `[A-Za-z0-9._-]`. */
const ACTOR_ID_PART = /^[A-Za-z0-9._]+$/;

function actorId(workspaceId: string, kind: 'ch' | 'dm' | 'in', entity: string): string {
  if (!ACTOR_ID_PART.test(workspaceId) || !ACTOR_ID_PART.test(entity)) {
    throw new Error(`split actor id parts must match ${ACTOR_ID_PART}`);
  }
  const id = `${workspaceId}-${kind}-${entity}`;
  if (id.length > 128) throw new Error('split actor id is longer than 128 characters');
  return id;
}

export const channelActorId = (workspaceId: string, channelId: string): string => actorId(workspaceId, 'ch', channelId);
/** `pairKey` is the engine's DM pair key (`dm_<pairKey>` is the conversation id). */
export const conversationActorId = (workspaceId: string, pairKey: string): string => actorId(workspaceId, 'dm', pairKey);
export const inboxActorId = (workspaceId: string, agentId: string): string => actorId(workspaceId, 'in', agentId);

/** `<ws>-<kind>-<entity>` back to its parts, or null. */
export function parseSplitActorId(id: string): { workspaceId: string; kind: 'ch' | 'dm' | 'in'; entity: string } | null {
  const match = /^([A-Za-z0-9._]+)-(ch|dm|in)-([A-Za-z0-9._]+)$/.exec(id);
  return match ? { workspaceId: match[1]!, kind: match[2] as 'ch' | 'dm' | 'in', entity: match[3]! } : null;
}

const AgentRefSchema = z.object({ id: z.string().min(1), name: z.string().min(1) });
export type AgentRef = z.infer<typeof AgentRefSchema>;

const SenderSchema = AgentRefSchema.extend({ address: z.string().min(1).optional() });

/** What the gateway learned from the Workspace actor, and the caller's text. */
export const SourcePostSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('channel'),
    sender: SenderSchema,
    channel: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    /** Members to deliver to (the sender is skipped). */
    recipients: z.array(AgentRefSchema),
    text: z.string(),
    mode: z.enum(['wait', 'steer']).default('wait'),
    confirmed: z.lazy(() => ConfirmationsSchema).optional(),
  }),
  z.object({
    kind: z.literal('dm'),
    sender: SenderSchema,
    conversationId: z.string().min(1),
    recipient: AgentRefSchema,
    text: z.string(),
    mode: z.enum(['wait', 'steer']).default('wait'),
    confirmed: z.lazy(() => ConfirmationsSchema).optional(),
  }),
]);
export type SourcePost = z.input<typeof SourcePostSchema>;

/** Hand-offs an inbox accepted: entries up to `through` can leave the source's outbox. */
export const ConfirmationsSchema = z.array(z.object({ recipient: z.string().min(1), through: z.number().int().nonnegative() }));
export type Confirmation = z.infer<typeof ConfirmationsSchema>[number];

export const OutboxEntrySchema = z.object({
  source_seq: z.number().int().positive(),
  delivery_id: z.string().min(1),
  msg_id: z.string().min(1),
  mode: z.enum(['wait', 'steer']),
  event_type: z.string().min(1),
});
export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;

/** One recipient inbox's share of a source's outbox. */
export const InboxHandoffSchema = z.object({
  /** The source actor id; the inbox keeps one cursor per source. */
  source: z.string().min(1),
  agent: AgentRefSchema,
  entries: z.array(OutboxEntrySchema).max(MAX_ENTRIES_PER_HANDOFF),
  /** Event data by message id, for the entries' `deliver` payloads. */
  payloads: z.record(z.string(), z.record(z.string(), z.unknown())),
});
export type InboxHandoff = z.infer<typeof InboxHandoffSchema>;

export interface InboxAcceptResult {
  /** Highest `source_seq` of this source the inbox holds; the source may drop its outbox up to here. */
  through: number;
  accepted: number;
}

/** A source's answer to a post: the HTTP response and the hand-offs for the caller to run. */
export interface SourcePostResult {
  status: number;
  body: string;
  handoffs: InboxHandoff[];
}

/** Socket metadata the gateway opens an inbox socket with. */
export const InboxSocketMetadataSchema = z.object({
  v: z.literal(1),
  kind: z.literal('inbox'),
  workspace_id: z.string().min(1),
  agent_id: z.string().min(1),
  agent_name: z.string().min(1),
});
export type InboxSocketMetadata = z.infer<typeof InboxSocketMetadataSchema>;

/** What the gateway asks the Workspace actor before routing a hot-path send. */
export const SplitResolveSchema = z.object({
  token: z.string().min(1),
  dm_to: z.string().min(1).optional(),
  channel: z.string().min(1).optional(),
});
export type SplitResolveInput = z.infer<typeof SplitResolveSchema>;

export type SplitResolveResult =
  | { ok: false; reason: 'unauthenticated' | 'not_found' | 'unsupported' }
  | {
    ok: true;
    sender: AgentRef & { address: string };
    dm?: { recipient: AgentRef; conversation_id: string; pair_key: string };
    channel?: { id: string; name: string; members: AgentRef[] };
  };
