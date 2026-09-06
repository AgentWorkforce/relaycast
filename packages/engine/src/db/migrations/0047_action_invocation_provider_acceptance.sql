-- Preserve registered node-action socket acceptance independently of the
-- materialized action foreign key, which is cleared when capabilities prune.
ALTER TABLE action_invocations
  ADD COLUMN provider_accepted_attempt INTEGER DEFAULT NULL;
