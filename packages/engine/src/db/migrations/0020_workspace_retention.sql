-- Per-workspace retention settings (JSON: message_ttl_days, delivery_ttl_days,
-- message_log_ttl_days). NULL means the workspace inherits deployment defaults.
ALTER TABLE workspaces ADD COLUMN retention text;
