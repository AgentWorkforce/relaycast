-- Quote redaction (owner-named trusted delegates §8, §16.2): the one change
-- allowed to a stored owner_approval sets `quote` to null and records
-- `quote_redacted_at`, once. Any other UPDATE that changes, clears or adds
-- owner_approval is still refused. The allowed form is exactly the value the
-- redaction route writes: json_set over the old approval.
DROP TRIGGER IF EXISTS messages_owner_approval_immutable;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS messages_owner_approval_immutable
BEFORE UPDATE OF owner_approval ON messages
WHEN OLD.owner_approval IS NOT NEW.owner_approval
  AND NOT (
    OLD.owner_approval IS NOT NULL
    AND NEW.owner_approval IS NOT NULL
    AND json_type(OLD.owner_approval, '$.quote_redacted_at') IS NULL
    AND json_type(NEW.owner_approval, '$.quote_redacted_at') = 'text'
    AND NEW.owner_approval = json_set(
      json_set(OLD.owner_approval, '$.quote', NULL),
      '$.quote_redacted_at', json_extract(NEW.owner_approval, '$.quote_redacted_at')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'owner_approval is immutable');
END;
