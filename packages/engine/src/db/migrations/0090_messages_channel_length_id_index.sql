-- Channel and DM history pages newest-first by numeric snowflake order,
-- (length(id), id): ids are decimal TEXT that widened from 17 to 18 digits in
-- 2025-10, so plain `id` text order misorders history spanning that change.
-- This index keeps each page an index seek. It replaces
-- idx_messages_channel_time (channel_id, id): every channel_id lookup that
-- index served is a prefix of this one, and no query orders a channel by bare
-- text id any more. No data changes.
CREATE INDEX IF NOT EXISTS idx_messages_channel_length_id
  ON messages(channel_id, length(id), id);
DROP INDEX IF EXISTS idx_messages_channel_time;
