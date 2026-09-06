-- Preserve action invocation provenance independently of action_id. Provider
-- capability refreshes can delete materialized actions, and that foreign key
-- intentionally uses ON DELETE SET NULL.
ALTER TABLE action_invocations
  ADD COLUMN invocation_origin TEXT NOT NULL DEFAULT 'legacy_unknown'
  CHECK (invocation_origin IN ('legacy_unknown', 'registered_action', 'builtin'));

-- Existing rows that still reference an action are unambiguously registered.
-- Rows whose reference was already cleared remain unknown and therefore never
-- gain built-in lifecycle authority.
UPDATE action_invocations
SET invocation_origin = 'registered_action'
WHERE action_id IS NOT NULL;

-- Any open pre-migration row with no action reference is ambiguous: it may be
-- a built-in invocation or an already-pruned registered action. Fail it closed
-- rather than let retry/drain bind it by name to a different handler (or let a
-- release acquire destructive lifecycle authority).
UPDATE action_invocations
SET status = 'failed',
    error = 'invocation_origin_unavailable',
    completed_at = unixepoch()
WHERE action_id IS NULL
  AND status IN ('pending', 'dispatched', 'invoked');
