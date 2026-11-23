-- Optional requester identity for invocations issued on behalf of another
-- agent (for example a hosted launcher spawning for a workspace agent).
-- caller_id/caller_name keep recording the authenticated caller.
ALTER TABLE action_invocations
  ADD COLUMN requester_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE action_invocations
  ADD COLUMN requester_name TEXT;
