-- DM unread counts read a per-participant cursor. DM membership lives in
-- dm_participants, so a cursor stored only on channel_members never moves.
ALTER TABLE dm_participants ADD COLUMN last_read_id TEXT;

-- Seed each cursor from the participant's newest read receipt in that DM, so
-- conversations read before this column existed do not come back unread.
-- Walks each DM's messages once per participant and probes the receipt
-- primary key. Snowflake ids order numerically, not as text.
UPDATE dm_participants SET last_read_id = (
  SELECT CAST(MAX(CAST(m.id AS INTEGER)) AS TEXT)
  FROM dm_conversations dc
  JOIN messages m ON m.channel_id = dc.channel_id
  JOIN read_receipts rr ON rr.message_id = m.id AND rr.agent_id = dm_participants.agent_id
  WHERE dc.id = dm_participants.conversation_id
);
