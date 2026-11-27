-- Backfill active rows while leaving any pre-existing duplicate-case legacy
-- rows beyond the earliest active identity as NULL so existing databases
-- migrate without unique-index failure. Registration still checks `lower(name)`
-- against those legacy rows until they are released.
UPDATE "agents"
SET "canonical_name" = lower("name")
WHERE "status" <> 'released'
  AND NOT EXISTS (
    SELECT 1
    FROM "agents" AS "earlier"
    WHERE "earlier"."workspace_id" = "agents"."workspace_id"
      AND "earlier"."status" <> 'released'
      AND lower("earlier"."name") = lower("agents"."name")
      AND (
        "earlier"."created_at" < "agents"."created_at"
        OR ("earlier"."created_at" = "agents"."created_at" AND "earlier"."id" < "agents"."id")
      )
  );
