-- Unique constraint on deliveries: one record per (message, agent)
-- Prevents duplicate rows on idempotency retry.
-- Deduplicate any pre-existing rows first (keep the earliest by rowid) so the
-- unique index creation cannot fail on a database that already has duplicates.
DELETE FROM deliveries
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM deliveries GROUP BY message_id, agent_id
);

CREATE UNIQUE INDEX IF NOT EXISTS deliveries_message_agent_unique
  ON deliveries(message_id, agent_id);

-- Fix deliveries default status: 'pending' was the schema default but code writes 'accepted'
-- Align the default with what is actually written
-- (SQLite does not support ALTER COLUMN DEFAULT; future inserts via Drizzle use the code-supplied value)

-- Unique constraint on session_events: one sequence number per agent
-- Prevents duplicate sequences under concurrent POSTs.
-- Deduplicate first, for the same reason as the deliveries index above.
DELETE FROM session_events
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM session_events GROUP BY agent_id, sequence
);

CREATE UNIQUE INDEX IF NOT EXISTS session_events_agent_sequence_unique
  ON session_events(agent_id, sequence);
