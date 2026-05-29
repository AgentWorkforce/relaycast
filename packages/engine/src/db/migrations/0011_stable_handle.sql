-- Add stable handle column to agents
ALTER TABLE agents ADD COLUMN handle TEXT DEFAULT NULL;

-- Backfill existing agents: handle = '@' || name
UPDATE agents SET handle = '@' || name WHERE handle IS NULL;
