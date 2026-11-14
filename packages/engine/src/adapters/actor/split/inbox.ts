/**
 * An agent's inbox in the split topology: its pending deliveries, their
 * delivery seq and the ack cursor. Sources hand it outbox entries; it keeps
 * one cursor per source and applies entries strictly in `source_seq` order,
 * skipping ones it already holds (a repeated or overlapping hand-off) and
 * stopping at a gap (a hand-off that overtook an earlier one; the source
 * still has the missing entries and sends them again). Every accepted entry
 * gets the next inbox seq, so per-source order is kept inside the inbox.
 * The idempotency key is (source, source_seq), never the delivery id: a
 * delivery id that repeats across sources must not wedge a stream.
 */
import { buildDeliverFrame, toFleetWireJson } from '../../../engine/deliveryWire.js';
import type { ActorDatabase } from '../database.js';
import { INBOX_SEQ_BASE, InboxHandoffSchema, type InboxAcceptResult, type InboxHandoff } from './protocol.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS split_inbox_cursors (
    source TEXT PRIMARY KEY,
    through INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS split_inbox (
    seq INTEGER PRIMARY KEY,
    delivery_id TEXT NOT NULL,
    frame TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS split_inbox_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_seq INTEGER NOT NULL,
    acked_seq INTEGER NOT NULL
  )`,
];

export type DeliverFrame = ReturnType<typeof buildDeliverFrame>;

export interface SplitInbox {
  /** Apply one hand-off; answers the cursor and the `deliver` frames it created, in seq order. Run inside the actor's transaction. */
  accept(handoff: InboxHandoff): { result: InboxAcceptResult; frames: DeliverFrame[] };
  /** Unacked deliveries in seq order (replayed to a socket that connects). */
  pending(limit?: number): DeliverFrame[];
  /** Ack every delivery up to `upToSeq`; answers how many were acked. */
  ack(upToSeq: number): number;
  /** The ack cursor and the last seq handed out. */
  state(): { lastSeq: number; ackedSeq: number };
}

export function createSplitInbox(sql: ActorDatabase, options: { now?: () => number } = {}): SplitInbox {
  const now = options.now ?? Date.now;
  let schemaReady = false;
  const ensureSchema = (): void => {
    if (schemaReady) return;
    for (const statement of SCHEMA) sql.exec(statement);
    sql.exec('INSERT INTO split_inbox_state (id, last_seq, acked_seq) VALUES (1, ?, ?) ON CONFLICT (id) DO NOTHING', INBOX_SEQ_BASE, INBOX_SEQ_BASE);
    schemaReady = true;
  };
  const state = (): { lastSeq: number; ackedSeq: number } => {
    ensureSchema();
    const [row] = sql.exec('SELECT last_seq, acked_seq FROM split_inbox_state WHERE id = 1') as { last_seq: number | bigint; acked_seq: number | bigint }[];
    return { lastSeq: Number(row!.last_seq), ackedSeq: Number(row!.acked_seq) };
  };

  return {
    accept(raw) {
      const handoff = InboxHandoffSchema.parse(raw);
      ensureSchema();
      const [cursorRow] = sql.exec('SELECT through FROM split_inbox_cursors WHERE source = ?', handoff.source) as { through: number | bigint }[];
      const before = cursorRow ? Number(cursorRow.through) : 0;
      let through = before;
      let { lastSeq } = state();
      const frames: DeliverFrame[] = [];
      const nowMs = now();
      for (const entry of [...handoff.entries].sort((a, b) => a.source_seq - b.source_seq)) {
        if (entry.source_seq <= through) continue; // already held
        if (entry.source_seq !== through + 1) break; // overtook an earlier hand-off
        const data = handoff.payloads[entry.msg_id];
        if (!data) break; // a hand-off without the message cannot be delivered; the source sends it again
        lastSeq += 1;
        const frame = buildDeliverFrame({
          delivery_id: entry.delivery_id,
          agent_id: handoff.agent.id,
          agent: handoff.agent.name,
          msg_id: entry.msg_id,
          seq: lastSeq,
          mode: entry.mode,
          payload: toFleetWireJson({ type: entry.event_type, data }),
        });
        sql.exec(
          'INSERT INTO split_inbox (seq, delivery_id, frame, created_at_ms) VALUES (?, ?, ?, ?)',
          lastSeq,
          entry.delivery_id,
          JSON.stringify(frame),
          nowMs,
        );
        frames.push(frame);
        through = entry.source_seq;
      }
      if (through !== before) {
        sql.exec(
          'INSERT INTO split_inbox_cursors (source, through) VALUES (?, ?) ON CONFLICT (source) DO UPDATE SET through = excluded.through',
          handoff.source,
          through,
        );
        sql.exec('UPDATE split_inbox_state SET last_seq = ? WHERE id = 1', lastSeq);
      }
      return { result: { through, accepted: frames.length }, frames };
    },

    pending(limit = 1000) {
      ensureSchema();
      const rows = sql.exec('SELECT frame FROM split_inbox ORDER BY seq LIMIT ?', limit) as { frame: string }[];
      return rows.map((row) => JSON.parse(row.frame) as DeliverFrame);
    },

    ack(upToSeq) {
      const current = state();
      const target = Math.min(Math.floor(upToSeq), current.lastSeq);
      if (!Number.isFinite(target) || target <= current.ackedSeq) return 0;
      const [row] = sql.exec('SELECT COUNT(*) AS n FROM split_inbox WHERE seq <= ?', target) as { n: number | bigint }[];
      sql.exec('DELETE FROM split_inbox WHERE seq <= ?', target);
      sql.exec('UPDATE split_inbox_state SET acked_seq = ? WHERE id = 1', target);
      return Number(row?.n ?? 0);
    },

    state,
  };
}
