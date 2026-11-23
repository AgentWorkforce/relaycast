-- Owner-named trusted delegates: a delegate's owner approval claim, stored
-- with the message in its own column, never inside caller-editable metadata.
-- Numbered after main's 0086 so it does not collide when this branch lands.
ALTER TABLE messages ADD COLUMN owner_approval TEXT;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS messages_owner_approval_immutable
BEFORE UPDATE OF owner_approval ON messages
WHEN OLD.owner_approval IS NOT NEW.owner_approval
BEGIN
  SELECT RAISE(ABORT, 'owner_approval is immutable');
END;
