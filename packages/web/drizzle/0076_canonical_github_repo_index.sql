-- GitHub owner/repository names are case-insensitive. The shadow install
-- index stores canonical lowercase coordinates so resolver lookups and the
-- workspace/repo uniqueness constraint agree before any caller can use it.

WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "workspace_id", lower("repo_owner"), lower("repo_name")
      ORDER BY
        "updated_at" DESC,
        CASE "access_state"
          WHEN 'access_removed' THEN 0
          WHEN 'unknown' THEN 1
          WHEN 'active' THEN 2
          ELSE 3
        END,
        "created_at" DESC,
        "id" ASC
    ) AS rn
  FROM "repo_github_installation_index"
)
DELETE FROM "repo_github_installation_index" target
USING ranked
WHERE target."id" = ranked."id"
  AND ranked.rn > 1;

UPDATE "repo_github_installation_index"
SET
  "repo_owner" = lower("repo_owner"),
  "repo_name" = lower("repo_name"),
  "updated_at" = now()
WHERE "repo_owner" <> lower("repo_owner")
   OR "repo_name" <> lower("repo_name");
