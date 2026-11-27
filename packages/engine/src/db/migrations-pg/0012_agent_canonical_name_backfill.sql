-- Backfill active rows in a single O(N log N) window pass, leaving any
-- pre-existing duplicate-case legacy rows beyond the earliest active identity
-- as NULL so existing databases migrate without unique-index failure.
-- Registration still checks `lower(name)` against those legacy rows until they
-- are released.
UPDATE "agents"
SET "canonical_name" = lower("name")
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT
      "id",
      row_number() OVER (
        PARTITION BY "workspace_id", lower("name")
        ORDER BY "created_at" ASC, "id" ASC
      ) AS "rn"
    FROM "agents"
    WHERE "status" <> 'released'
  ) AS "ranked"
  WHERE "rn" = 1
);
