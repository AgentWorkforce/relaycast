-- Migrate 'online' status to spec-aligned 'active'
-- The spec defines statuses as: active, idle, blocked, waiting, offline
-- 'online' was the internal sentinel for "connected"; 'active' is the spec equivalent.
--
-- NOTE: SQLite cannot ALTER a column DEFAULT, so the agents.status DEFAULT may
-- still read 'online' in the table definition. This is inert: every insert path
-- sets status explicitly (registration defaults to 'active'), so no new row is
-- ever created with the stale default. (Same SQLite limitation noted in 0012.)
UPDATE agents SET status = 'active' WHERE status = 'online';
