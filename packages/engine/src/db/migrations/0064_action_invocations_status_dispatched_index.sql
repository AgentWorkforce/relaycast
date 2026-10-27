-- The dispatched-invocation timeout sweep filters on
-- status IN (?) AND dispatched_at <= ? and had no usable index, so every run
-- scanned all of action_invocations (~232k rows, ~1.1 s per query in
-- production). D1 runs one query at a time per database, so each run queued
-- every other request behind it, surfacing as "D1 DB is overloaded. Requests
-- queued for too long." The pending retry sweep (status = ? AND
-- retry_after_at <= ?) also uses the status prefix. No data changes.
CREATE INDEX IF NOT EXISTS idx_action_invocations_status_dispatched
  ON action_invocations(status, dispatched_at);
