-- A numeric zero must mean measured idle, never "no measurement available".
-- Keep the existing numeric columns for SQLite/D1 compatibility and carry
-- measurement presence explicitly alongside them.
ALTER TABLE nodes ADD COLUMN load_reported INTEGER NOT NULL DEFAULT 0;
ALTER TABLE node_providers ADD COLUMN load_reported INTEGER NOT NULL DEFAULT 0;

-- Do not backfill load_reported. Every released provider implementation sent a
-- placeholder load value, including finite-capacity providers, so no historic
-- numeric value is known to be a measurement.

-- Provider capacity uses the same sentinel: any unbounded provider makes its
-- aggregate broker node unbounded. Correct aggregates written by the prior
-- additive-zero behavior before deciding whether their load was measured.
UPDATE nodes
SET max_agents = 0
WHERE EXISTS (
  SELECT 1
  FROM node_providers
  WHERE node_providers.workspace_id = nodes.workspace_id
    AND node_providers.node_id = nodes.id
    AND node_providers.max_agents = 0
);
