-- Migration: 0003_add_channel_mute
-- Purpose: Add is_muted boolean column to channel_members table
-- for per-agent channel mute functionality.

ALTER TABLE channel_members ADD COLUMN is_muted INTEGER NOT NULL DEFAULT 0;
