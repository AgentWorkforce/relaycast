-- The agent whose spawn invocation created this agent. Agent tokens may
-- release or delete only agents they spawned; workspace keys keep full rights.
-- NULL for agents registered directly or spawned by a workspace key, and for
-- every row that predates this column. No foreign key: agents are tombstoned
-- rather than deleted, and a retained id grants nothing once its row is gone.
ALTER TABLE agents ADD COLUMN spawned_by TEXT;
