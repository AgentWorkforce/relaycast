-- Port of SQLite 0088: the one change allowed to a stored owner_approval sets
-- `quote` to null and records `quote_redacted_at`, once. The trigger and its
-- WHEN clause (from 0009) are unchanged; the function now lets exactly that
-- redaction through and refuses everything else.
CREATE OR REPLACE FUNCTION "public"."messages_owner_approval_immutable"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."owner_approval" IS NOT NULL
    AND NEW."owner_approval" IS NOT NULL
    AND (OLD."owner_approval" -> 'quote_redacted_at') IS NULL
    AND jsonb_typeof(NEW."owner_approval" -> 'quote_redacted_at') = 'string'
    AND NEW."owner_approval" = OLD."owner_approval"
      || jsonb_build_object('quote', NULL, 'quote_redacted_at', NEW."owner_approval" -> 'quote_redacted_at')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'owner_approval is immutable' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
