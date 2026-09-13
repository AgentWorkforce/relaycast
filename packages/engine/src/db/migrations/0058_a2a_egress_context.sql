-- Retain the accepted public response through the existing egress retry horizon.
-- Credentials remain exclusively in current a2a_agents and are never copied here.
CREATE TABLE IF NOT EXISTS a2a_egress_context (
  id TEXT PRIMARY KEY NOT NULL REFERENCES a2a_egress(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  response TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_a2a_egress_context_message ON a2a_egress_context(message_id);
