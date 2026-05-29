-- Drop global uniqueness constraint on workspace names.
-- Workspace names are NOT globally unique — multiple workspaces can share a name.
-- The apiKeyHash column remains globally unique for workspace identification.
DROP INDEX IF EXISTS `workspaces_name_unique`;
