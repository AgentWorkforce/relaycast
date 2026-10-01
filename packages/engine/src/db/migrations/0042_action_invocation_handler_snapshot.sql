-- An idempotent action replay must identify the handler and node that received
-- the original invocation even after mutable registration or routing moves.
-- These are intentionally not foreign keys: deleting/releasing a handler or
-- node must not rewrite an already-returned acknowledgement.
ALTER TABLE action_invocations ADD COLUMN handler_agent_id TEXT;
ALTER TABLE action_invocations ADD COLUMN handler_node_id TEXT;
