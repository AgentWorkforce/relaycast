/**
 * A message source of the split topology: a Channel or a 1:1 Conversation
 * actor. It owns its message order and history and an outbox with one entry
 * per (recipient, message). A post is one write: the message, its outbox
 * entries and any confirmations the caller carried. The caller (the gateway)
 * hands the returned entries to the recipients' inboxes and confirms them on
 * a later post or with {@link SplitSource.confirm}; until then they stay in
 * the outbox and ride along on the next hand-off to that recipient, and the
 * source's alarm redrives any that sat too long.
 */
import { randomInt } from 'node:crypto';
import { snowflakeIdLowerBound } from '../../../engine/snowflake.js';
import { buildDmReceivedEventData, buildMessageCreatedEventData } from '../../../engine/deliveryWire.js';
import type { ActorDatabase } from '../database.js';
import {
  MAX_ENTRIES_PER_HANDOFF,
  SourcePostSchema,
  type AgentRef,
  type Confirmation,
  type InboxHandoff,
  type OutboxEntry,
  type SourcePost,
  type SourcePostResult,
} from './protocol.js';

/** Delivery TTL shown in send receipts (the engine's default mailbox TTL). */
const RECEIPT_TTL_MS = 60 * 60 * 1000;
/** An outbox entry older than this is redriven by the source's alarm. */
export const REDRIVE_AFTER_MS = 2_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS split_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    sender_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS split_recipients (
    recipient TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    last_seq INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS split_outbox (
    recipient TEXT NOT NULL,
    source_seq INTEGER NOT NULL,
    delivery_id TEXT NOT NULL,
    msg_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    event_type TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (recipient, source_seq)
  )`,
];

/**
 * Message ids for a source actor. The engine's generator takes its 10 worker
 * bits from a random per-process hash, which is safe with one Workspace actor
 * per workspace but not with one process per channel, conversation and inbox:
 * two sources posting in the same millisecond collide whenever their worker
 * bits do. Here the 22 bits under the timestamp start at a random point each
 * millisecond (and count up within it), so ids stay snowflake-shaped and
 * time-ordered, increase within a source, and two sources collide only when
 * the same millisecond draws the same 21-bit start.
 */
export function createSourceIdGenerator(now: () => number = Date.now): () => string {
  let lastMs = -1;
  let low = 0;
  return () => {
    let ms = Math.max(now(), lastMs);
    if (ms === lastMs && low + 1 >= 1 << 22) ms = lastMs + 1;
    if (ms === lastMs) {
      low += 1;
    } else {
      lastMs = ms;
      low = randomInt(0, 1 << 21);
    }
    return (BigInt(snowflakeIdLowerBound(ms)) | BigInt(low)).toString();
  };
}

export interface SplitSource {
  /** Commit one message and its outbox entries; answer the HTTP response and the hand-offs. Run inside the actor's transaction. */
  post(input: SourcePost): SourcePostResult;
  /**
   * Group commit: several messages in one write (the caller's transaction),
   * in order. One hand-off per recipient covers all of them.
   */
  postMany(inputs: readonly SourcePost[]): { results: { status: number; body: string }[]; handoffs: InboxHandoff[] };
  /** Drop outbox entries the recipients' inboxes accepted. */
  confirm(confirmations: readonly Confirmation[]): void;
  /** Hand-offs for every recipient with an entry older than `olderThanMs` (the alarm's redrive). */
  dueHandoffs(olderThanMs?: number): InboxHandoff[];
  /** When the alarm should next look at the outbox, or null when it is empty. */
  nextRedriveAt(): number | null;
  /** Messages in order, newest last (history reads and tests). */
  history(limit?: number): { seq: number; id: string; event_type: string; payload: Record<string, unknown> }[];
}

export function createSplitSource(sql: ActorDatabase, options: { actorId: string; now?: () => number }): SplitSource {
  const now = options.now ?? Date.now;
  const generateId = createSourceIdGenerator(now);
  let schemaReady = false;
  const ensureSchema = (): void => {
    if (schemaReady) return;
    for (const statement of SCHEMA) sql.exec(statement);
    schemaReady = true;
  };

  const confirm = (confirmations: readonly Confirmation[]): void => {
    ensureSchema();
    for (const { recipient, through } of confirmations) {
      sql.exec('DELETE FROM split_outbox WHERE recipient = ? AND source_seq <= ?', recipient, through);
    }
  };

  const handoffFor = (recipient: AgentRef): InboxHandoff => {
    const entries = sql.exec(
      'SELECT source_seq, delivery_id, msg_id, mode, event_type FROM split_outbox WHERE recipient = ? ORDER BY source_seq LIMIT ?',
      recipient.id,
      MAX_ENTRIES_PER_HANDOFF,
    ) as OutboxEntry[];
    const payloads: InboxHandoff['payloads'] = {};
    for (const msgId of new Set(entries.map((entry) => entry.msg_id))) {
      const [row] = sql.exec('SELECT payload FROM split_messages WHERE id = ?', msgId) as { payload: string }[];
      if (row) payloads[msgId] = JSON.parse(row.payload) as Record<string, unknown>;
    }
    return {
      source: options.actorId,
      agent: recipient,
      entries: entries.map((entry) => ({ ...entry, source_seq: Number(entry.source_seq) })),
      payloads,
    };
  };

  /** Commit one message; answers its HTTP response and the recipients it queued entries for. */
  const commit = (raw: SourcePost): { status: number; body: string; recipients: AgentRef[] } => {
    {
      ensureSchema();
      const input = SourcePostSchema.parse(raw);
      if (input.confirmed) confirm(input.confirmed);
      const nowMs = now();
      const id = generateId();
      // The engine stores second precision; receipts and payloads match it.
      const createdAt = new Date(Math.floor(nowMs / 1000) * 1000).toISOString();
      const expiresAt = new Date(Math.floor(nowMs / 1000) * 1000 + RECEIPT_TTL_MS).toISOString();
      const sender = input.sender;
      const recipients = input.kind === 'channel'
        ? input.recipients.filter((member) => member.id !== sender.id)
        : [input.recipient];

      let responseData: Record<string, unknown>;
      let eventType: string;
      let payload: Record<string, unknown>;
      if (input.kind === 'channel') {
        eventType = 'message.created';
        const message = {
          id,
          channel_id: input.channel.id,
          agent_id: sender.id,
          agent_name: sender.name,
          text: input.text,
          blocks: null,
          metadata: {},
          has_attachments: false,
          thread_id: null,
          created_at: createdAt,
          mentions: [],
          attachments: [],
          injection_mode: input.mode,
        };
        payload = buildMessageCreatedEventData(message, { channelName: input.channel.name, fromName: sender.name, mode: input.mode });
        const deliveries = recipients.map((recipient) => ({
          id: `del_${id}_${recipient.id}`,
          agent_id: recipient.id,
          status: 'queued',
          expires_at: expiresAt,
        }));
        responseData = { ...message, deliveries: deliveries.slice(0, 50), deliveries_truncated: deliveries.length > 50 };
      } else {
        eventType = 'dm.received';
        const metadata = { injection_mode: input.mode };
        const message = {
          conversation_id: input.conversationId,
          message: {
            id,
            agent_id: sender.id,
            agent_name: sender.name,
            agent_address: sender.address ?? `${sender.name}@direct`,
            text: input.text,
            injection_mode: input.mode,
            attachments: [],
            metadata,
          },
          created_at: createdAt,
          id,
          from_agent_id: sender.id,
          to: input.recipient.name,
          text: input.text,
          injection_mode: input.mode,
          attachments: [],
          metadata,
        };
        payload = buildDmReceivedEventData(message, { fromName: sender.name });
        responseData = {
          ...message,
          delivery: { id: `del_${id}_${input.recipient.id}`, status: 'queued', expires_at: expiresAt },
        };
      }

      sql.exec(
        'INSERT INTO split_messages (id, sender_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)',
        id,
        sender.id,
        eventType,
        JSON.stringify(payload),
        Math.floor(nowMs / 1000),
      );
      for (const recipient of recipients) {
        const [row] = sql.exec(
          `INSERT INTO split_recipients (recipient, name, last_seq) VALUES (?, ?, 1)
           ON CONFLICT (recipient) DO UPDATE SET last_seq = last_seq + 1, name = excluded.name
           RETURNING last_seq`,
          recipient.id,
          recipient.name,
        ) as { last_seq: number | bigint }[];
        sql.exec(
          'INSERT INTO split_outbox (recipient, source_seq, delivery_id, msg_id, mode, event_type, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
          recipient.id,
          Number(row!.last_seq),
          `del_${id}_${recipient.id}`,
          id,
          input.mode,
          eventType,
          nowMs,
        );
      }

      return { status: 201, body: JSON.stringify({ ok: true, data: responseData }), recipients };
    }
  };

  return {
    post(raw) {
      const { status, body, recipients } = commit(raw);
      return { status, body, handoffs: recipients.map(handoffFor) };
    },

    postMany(inputs) {
      const recipients = new Map<string, AgentRef>();
      const results = inputs.map((input) => {
        const { status, body, recipients: queued } = commit(input);
        for (const recipient of queued) recipients.set(recipient.id, recipient);
        return { status, body };
      });
      // One hand-off per recipient carries the entries of every message in the batch.
      return { results, handoffs: [...recipients.values()].map(handoffFor) };
    },

    confirm,

    dueHandoffs(olderThanMs = REDRIVE_AFTER_MS) {
      ensureSchema();
      const cutoff = now() - olderThanMs;
      const due = sql.exec(
        `SELECT DISTINCT o.recipient AS id, r.name AS name FROM split_outbox o
         JOIN split_recipients r ON r.recipient = o.recipient
         WHERE o.created_at_ms <= ?`,
        cutoff,
      ) as AgentRef[];
      return due.map(handoffFor);
    },

    nextRedriveAt() {
      ensureSchema();
      const [row] = sql.exec('SELECT MIN(created_at_ms) AS oldest FROM split_outbox') as { oldest: number | bigint | null }[];
      return row?.oldest === null || row?.oldest === undefined ? null : Number(row.oldest) + REDRIVE_AFTER_MS;
    },

    history(limit = 100) {
      ensureSchema();
      const rows = sql.exec(
        'SELECT seq, id, event_type, payload FROM split_messages ORDER BY seq DESC LIMIT ?',
        limit,
      ) as { seq: number | bigint; id: string; event_type: string; payload: string }[];
      return rows.reverse().map((row) => ({
        seq: Number(row.seq),
        id: row.id,
        event_type: row.event_type,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      }));
    },
  };
}
