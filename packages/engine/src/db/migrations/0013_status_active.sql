-- Migrate 'online' status to spec-aligned 'active'
-- The spec defines statuses as: active, idle, blocked, waiting, offline
-- 'online' was the internal sentinel for "connected"; 'active' is the spec equivalent.
UPDATE agents SET status = 'active' WHERE status = 'online';
