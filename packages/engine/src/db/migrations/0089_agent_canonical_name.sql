-- Case-insensitive active agent name uniqueness (prevents confusable
-- registration such as `ALPHA1` alongside `alpha1`). Released tombstones clear
-- `canonical_name` so the name can be re-registered under any casing.
ALTER TABLE agents
  ADD COLUMN canonical_name text;

-- Backfill active rows in a single O(N log N) window pass, leaving any
-- pre-existing duplicate-case legacy rows beyond the earliest active identity
-- as NULL so existing databases migrate without unique-index failure.
-- Registration still checks `lower(name)` against those legacy rows until they
-- are released.
UPDATE agents
SET canonical_name = lower(name)
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY workspace_id, lower(name)
        ORDER BY created_at ASC, id ASC
      ) AS rn
    FROM agents
    WHERE status <> 'released'
  ) AS ranked
  WHERE rn = 1
);

CREATE UNIQUE INDEX agents_workspace_canonical_name_unique
  ON agents (workspace_id, canonical_name)
  WHERE canonical_name IS NOT NULL AND status <> 'released';
