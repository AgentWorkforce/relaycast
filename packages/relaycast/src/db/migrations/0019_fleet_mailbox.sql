-- Fleet Phase 2: bounded durable mailbox state machine.

ALTER TABLE agents ADD COLUMN delivery_ack_seq INTEGER NOT NULL DEFAULT 0;

ALTER TABLE deliveries ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN location_type TEXT NOT NULL DEFAULT 'self_connected';
ALTER TABLE deliveries ADD COLUMN location_node_id TEXT DEFAULT NULL REFERENCES nodes(id) ON DELETE SET NULL;
ALTER TABLE deliveries ADD COLUMN expires_at INTEGER DEFAULT NULL;
ALTER TABLE deliveries ADD COLUMN delivered_at INTEGER DEFAULT NULL;
ALTER TABLE deliveries ADD COLUMN acked_at INTEGER DEFAULT NULL;
ALTER TABLE deliveries ADD COLUMN dead_lettered_at INTEGER DEFAULT NULL;

-- Existing public rows used accepted/deferred for "queued" and delivered for
-- "terminal success". Preserve that meaning while moving to queued/delivered/acked.
UPDATE deliveries SET status = 'queued' WHERE status IN ('pending', 'accepted', 'deferred');
UPDATE deliveries SET status = 'acked', acked_at = COALESCE(updated_at, created_at) WHERE status = 'delivered';

-- Populate location snapshots from the current agent roster for old rows.
UPDATE deliveries
SET
  location_type = COALESCE((SELECT location_type FROM agents WHERE agents.id = deliveries.agent_id), 'self_connected'),
  location_node_id = (SELECT location_node_id FROM agents WHERE agents.id = deliveries.agent_id);

-- Assign durable per-agent sequence numbers to existing rows before enforcing uniqueness.
WITH ranked AS (
  SELECT
    rowid AS rid,
    ROW_NUMBER() OVER (
      PARTITION BY workspace_id, agent_id
      ORDER BY created_at, id
    ) AS rn
  FROM deliveries
)
UPDATE deliveries
SET seq = (SELECT rn FROM ranked WHERE ranked.rid = deliveries.rowid);

-- Use the old deadline as the mailbox expiry when present; otherwise default
-- legacy queued rows to one hour after creation. Terminal rows do not expire.
UPDATE deliveries
SET expires_at = COALESCE(deadline, created_at + 3600)
WHERE status IN ('queued', 'delivered') AND expires_at IS NULL;

-- Seed the cumulative cursor from the contiguous acked prefix, not the max acked
-- seq: node replay sends rows with seq > delivery_ack_seq, so if an older row is
-- still queued/delivered below a newer acked row, MAX(acked seq) would skip it
-- forever. The contiguous prefix is (lowest still-active seq) - 1; when nothing
-- is active, every row is settled so the cursor can advance to the max seq.
UPDATE agents
SET delivery_ack_seq = COALESCE(
  (
    SELECT MIN(seq) - 1
    FROM deliveries
    WHERE deliveries.agent_id = agents.id
      AND deliveries.status IN ('queued', 'delivered')
  ),
  (
    SELECT MAX(seq)
    FROM deliveries
    WHERE deliveries.agent_id = agents.id
  ),
  0
);

CREATE UNIQUE INDEX IF NOT EXISTS deliveries_agent_seq_unique
  ON deliveries(workspace_id, agent_id, seq);

CREATE INDEX IF NOT EXISTS idx_deliveries_agent_status_seq
  ON deliveries(workspace_id, agent_id, status, seq);

CREATE INDEX IF NOT EXISTS idx_deliveries_expires
  ON deliveries(workspace_id, status, expires_at);
