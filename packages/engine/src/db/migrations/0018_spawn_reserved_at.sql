-- Track whether a spawn invocation already holds a reserved node slot.
ALTER TABLE action_invocations ADD COLUMN spawn_reserved_at INTEGER DEFAULT NULL;
