-- Bind every deterministic 1:1 DM id to the workspace and sorted participant
-- pair that derived it. The primary key is the atomic reservation seam: a
-- conflicting digest can never overwrite or alias another pair's conversation.
CREATE TABLE dm_conversation_reservations (
  conversation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  participant_one_id TEXT NOT NULL,
  participant_two_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT dm_conversation_reservations_sorted_pair_check
    CHECK (participant_one_id <= participant_two_id)
);

CREATE UNIQUE INDEX dm_conversation_reservations_pair_unique
  ON dm_conversation_reservations (workspace_id, participant_one_id, participant_two_id);

-- PRE-FLIGHT AUDIT (run this read-only query BEFORE applying this migration).
-- The backfill below aborts the whole migration if any single legacy 1:1 has a
-- roster that is not 1 or 2 distinct participants. That is deliberate - inventing
-- a tuple would bind a conversation to the wrong pair - but it means one corrupt
-- row blocks the deployment, so find them first:
--
--   SELECT dc.id, dc.workspace_id, COUNT(DISTINCT dp.agent_id) AS participants
--   FROM dm_conversations dc
--   LEFT JOIN dm_participants dp ON dp.conversation_id = dc.id
--   WHERE dc.dm_type = '1:1'
--   GROUP BY dc.id, dc.workspace_id
--   HAVING participants NOT BETWEEN 1 AND 2;
--
-- An empty result means this migration will apply cleanly. Remediate any rows it
-- returns and re-run the audit before the cutover.

-- Existing self-DMs have one roster row, while ordinary 1:1 DMs have two.
-- MIN/MAX produces the canonical sorted pair for both shapes. A malformed 1:1
-- with zero or more than two distinct participants deliberately yields NULL and
-- aborts this migration at the NOT NULL constraint instead of inventing a tuple.
INSERT INTO dm_conversation_reservations (
  conversation_id,
  workspace_id,
  participant_one_id,
  participant_two_id,
  created_at
)
SELECT
  dc.id,
  dc.workspace_id,
  CASE WHEN COUNT(DISTINCT dp.agent_id) BETWEEN 1 AND 2 THEN MIN(dp.agent_id) END,
  CASE WHEN COUNT(DISTINCT dp.agent_id) BETWEEN 1 AND 2 THEN MAX(dp.agent_id) END,
  dc.created_at
FROM dm_conversations dc
LEFT JOIN dm_participants dp ON dp.conversation_id = dc.id
WHERE dc.dm_type = '1:1'
GROUP BY dc.id, dc.workspace_id, dc.created_at;
