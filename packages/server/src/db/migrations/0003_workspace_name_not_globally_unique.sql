-- Workspace names are labels and do not need to be globally unique.
-- Keep api_key_hash globally unique for authentication.

DROP INDEX IF EXISTS workspaces_name_unique;
