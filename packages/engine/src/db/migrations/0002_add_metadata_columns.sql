-- Migration: 0002_add_metadata_columns
-- Purpose: Add metadata JSON columns to channels and messages tables
-- for storing integration-specific data (e.g., Slack channel IDs, message timestamps)
--
-- SQLite ALTER TABLE ADD COLUMN constraints:
-- - Cannot add NOT NULL column without DEFAULT to table with existing rows
-- - DEFAULT must be a constant expression
-- - Column will have DEFAULT value for new rows; existing rows get the default retroactively

-- Add metadata column to channels table
-- Stores JSON object for integration-specific data (e.g., slack_channel_id)
ALTER TABLE channels ADD COLUMN metadata TEXT DEFAULT '{}';

-- Add metadata column to messages table
-- Stores JSON object for integration-specific data (e.g., slack_ts, slack_thread_ts)
ALTER TABLE messages ADD COLUMN metadata TEXT DEFAULT '{}';
