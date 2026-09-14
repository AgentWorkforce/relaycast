ALTER TABLE actions ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'short';
--> statement-breakpoint
ALTER TABLE action_invocations ADD COLUMN task_state TEXT;
--> statement-breakpoint
CREATE INDEX idx_action_invocations_task_deadline
  ON action_invocations(json_extract(task_state, '$.deadline'))
  WHERE task_state IS NOT NULL AND status IN ('pending', 'dispatched', 'running');
