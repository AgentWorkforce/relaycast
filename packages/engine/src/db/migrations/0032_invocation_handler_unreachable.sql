-- TTL grace for agent-handled invocations: the sweep fails an open invocation
-- only after its handler connection has been CONTINUOUSLY unreachable for the
-- TTL. This column records when the sweep first observed the handler
-- unreachable; it is cleared when connectivity recovers.
ALTER TABLE action_invocations ADD COLUMN handler_unreachable_since INTEGER;
