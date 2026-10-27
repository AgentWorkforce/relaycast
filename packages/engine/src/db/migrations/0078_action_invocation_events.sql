-- A bounded lifecycle timeline per action invocation (dispatches, agent
-- registrations, accepted and rejected results, requeues and their reasons),
-- so a caller can see what happened to a spawn instead of only its last
-- status. Appended in the same UPDATE as each state transition it records.
-- The column is not part of any liveness trigger, so recording an event never
-- advances node_liveness_revision.
ALTER TABLE action_invocations ADD COLUMN events TEXT NOT NULL DEFAULT '[]';
