-- Add metadata JSON columns to channels and messages tables
-- for storing integration-specific data (e.g., Slack channel IDs, message timestamps)

-- Add metadata to channels table
ALTER TABLE channels ADD COLUMN metadata TEXT DEFAULT '{}';

-- Add metadata to messages table
ALTER TABLE messages ADD COLUMN metadata TEXT DEFAULT '{}';

-- Create index for querying messages by metadata (for looking up by slack_ts, etc.)
CREATE INDEX IF NOT EXISTS idx_messages_metadata ON messages(metadata);
