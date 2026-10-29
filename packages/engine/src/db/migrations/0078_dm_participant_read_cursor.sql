-- DM unread counts read a per-participant cursor. DM membership lives in
-- dm_participants, so a cursor stored only on channel_members never moves.
ALTER TABLE dm_participants ADD COLUMN last_read_id TEXT;
