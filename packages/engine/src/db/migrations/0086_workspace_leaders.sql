-- Admin-set workspace leader patterns: a JSON object `{"patterns": [...]}` of
-- exact agent names or globs, owned by GET/PUT /v1/workspace/leaders. NULL
-- means unset (no leaders).
ALTER TABLE workspaces
  ADD COLUMN leaders text;
