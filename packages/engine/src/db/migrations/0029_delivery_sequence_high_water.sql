-- Keep each agent's delivery sequence monotonic even after delivery retention
-- or a message-retention cascade removes every historical delivery row.

ALTER TABLE agents ADD COLUMN delivery_seq INTEGER NOT NULL DEFAULT 0;

-- Older engines could reuse a sequence after retention. If that sequence was
-- already cumulatively acknowledged, the active row is hidden by replay's
-- `seq > delivery_ack_seq` predicate. Repair every active row for each affected
-- agent, not just the hidden rows, so their FIFO order remains intact. New
-- values start above both the ACK cursor and every existing (including settled)
-- row, avoiding collisions with the unique (workspace_id, agent_id, seq) index.
WITH affected_agents AS MATERIALIZED (
  SELECT
    a.workspace_id,
    a.id AS agent_id,
    MAX(
      a.delivery_ack_seq,
      COALESCE((
        SELECT MAX(all_deliveries.seq)
        FROM deliveries all_deliveries
        WHERE all_deliveries.workspace_id = a.workspace_id
          AND all_deliveries.agent_id = a.id
      ), 0)
    ) AS base_seq
  FROM agents a
  WHERE EXISTS (
    SELECT 1
    FROM deliveries hidden
    WHERE hidden.workspace_id = a.workspace_id
      AND hidden.agent_id = a.id
      AND hidden.status IN ('queued', 'delivered')
      AND hidden.seq <= a.delivery_ack_seq
  )
),
ranked_active AS MATERIALIZED (
  SELECT
    active.id,
    affected_agents.base_seq + ROW_NUMBER() OVER (
      PARTITION BY active.workspace_id, active.agent_id
      ORDER BY active.created_at, active.id
    ) AS repaired_seq
  FROM deliveries active
  INNER JOIN affected_agents
    ON affected_agents.workspace_id = active.workspace_id
   AND affected_agents.agent_id = active.agent_id
  WHERE active.status IN ('queued', 'delivered')
)
UPDATE deliveries
SET seq = (
  SELECT ranked_active.repaired_seq
  FROM ranked_active
  WHERE ranked_active.id = deliveries.id
)
WHERE id IN (SELECT id FROM ranked_active);

-- Seed both ordinary and repaired agents from all remaining history. The ACK
-- cursor participates because retention may already have removed every row.
UPDATE agents
SET delivery_seq = MAX(
  delivery_ack_seq,
  COALESCE((
    SELECT MAX(deliveries.seq)
    FROM deliveries
    WHERE deliveries.workspace_id = agents.workspace_id
      AND deliveries.agent_id = agents.id
  ), 0)
);

-- Production delivery inserts allocate above this high-water (and defensively
-- above the ACK cursor). Advancing the counter from an AFTER INSERT trigger
-- keeps allocation and advancement in the same SQLite statement, including D1
-- and bare sequential adapters.
CREATE TRIGGER deliveries_advance_sequence_high_water
AFTER INSERT ON deliveries
BEGIN
  UPDATE agents
  SET delivery_seq = MAX(delivery_seq, NEW.seq)
  WHERE id = NEW.agent_id
    AND workspace_id = NEW.workspace_id;
END;
