-- Preserve registered node-action socket acceptance independently of the
-- materialized action foreign key, which is cleared when capabilities prune.
ALTER TABLE action_invocations
  ADD COLUMN provider_accepted_attempt INTEGER DEFAULT NULL;

-- Before this column existed, dispatch_attempts advanced only after the local
-- socket owner accepted an agent- or node-hosted registered action. Preserve
-- those in-flight generations across an action prune during rolling upgrade.
-- Pending rows were never accepted and intentionally remain NULL.
UPDATE action_invocations
SET provider_accepted_attempt = dispatch_attempts
WHERE invocation_origin = 'registered_action'
  AND action_id IS NOT NULL
  AND status IN ('dispatched', 'invoked')
  AND dispatch_attempts > 0;
