-- An idempotent action replay must identify the handler that received the
-- original invocation even after the mutable action registration moves.
-- This is intentionally not a foreign key: deleting or releasing a handler
-- must not rewrite an already-returned acknowledgement.
ALTER TABLE action_invocations ADD COLUMN handler_agent_id TEXT;
