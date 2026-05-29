-- Unique constraint on deliveries: one record per (message, agent)
-- Prevents duplicate rows on idempotency retry
CREATE UNIQUE INDEX IF NOT EXISTS deliveries_message_agent_unique
  ON deliveries(message_id, agent_id);

-- Fix deliveries default status: 'pending' was the schema default but code writes 'accepted'
-- Align the default with what is actually written
-- (SQLite does not support ALTER COLUMN DEFAULT; future inserts via Drizzle use the code-supplied value)

-- Unique constraint on session_events: one sequence number per agent
-- Prevents duplicate sequences under concurrent POSTs
CREATE UNIQUE INDEX IF NOT EXISTS session_events_agent_sequence_unique
  ON session_events(agent_id, sequence);
