ALTER TABLE workspaces ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT (unixepoch());
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN suspended_at INTEGER;
--> statement-breakpoint
CREATE INDEX idx_workspaces_last_activity ON workspaces(last_activity_at);
--> statement-breakpoint
CREATE INDEX idx_workspaces_suspended_at ON workspaces(suspended_at);
