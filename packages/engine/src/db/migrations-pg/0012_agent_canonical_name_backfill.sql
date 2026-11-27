-- Backfill active rows in a single O(N log N) window pass using locale-
-- independent ASCII case folding (`COLLATE "C"`), leaving any pre-existing
-- duplicate-case legacy rows beyond the earliest active identity as NULL so
-- existing databases migrate without unique-index failure. Registration still
-- checks `lower(name COLLATE "C")` against those legacy rows until they are
-- released.
UPDATE "agents"
SET "canonical_name" = lower("name" COLLATE "C")
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT
      "id",
      row_number() OVER (
        PARTITION BY "workspace_id", lower("name" COLLATE "C")
        ORDER BY "created_at" ASC, "id" ASC
      ) AS "rn"
    FROM "agents"
    WHERE "status" <> 'released'
  ) AS "ranked"
  WHERE "rn" = 1
);
