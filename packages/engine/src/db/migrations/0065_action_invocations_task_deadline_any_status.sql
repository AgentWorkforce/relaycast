-- idx_action_invocations_task_deadline (0060) is partial on
-- status IN ('pending', 'dispatched', 'running'). The task deadline sweep binds
-- those statuses as parameters, and SQLite cannot prove a bound parameter
-- satisfies a partial index's WHERE clause, so the sweep scanned all of
-- action_invocations (~232k rows, ~0.9 s per update in production). This index
-- keeps only the literal task_state IS NOT NULL condition, which the sweep
-- states verbatim. No data changes.
CREATE INDEX IF NOT EXISTS idx_action_invocations_task_deadline_any_status
  ON action_invocations(json_extract(task_state, '$.deadline'))
  WHERE task_state IS NOT NULL;
