-- Presence refresh must not erase explicit work states. Remember only statuses
-- replaced by a liveness sweep/disconnect; existing offline rows are ambiguous
-- and deliberately receive no inferred recovery status.
ALTER TABLE agents ADD COLUMN status_before_liveness_loss TEXT;

-- Any later explicit status write, including offline -> offline, supersedes
-- recovery. A liveness transition changes this marker in the same statement;
-- ordinary status writers leave it unchanged and therefore clear it here.
CREATE TRIGGER agents_clear_liveness_recovery
AFTER UPDATE OF status ON agents
FOR EACH ROW
WHEN NEW.status_before_liveness_loss IS NOT NULL
  AND NEW.status_before_liveness_loss IS OLD.status_before_liveness_loss
BEGIN
  UPDATE agents SET status_before_liveness_loss = NULL WHERE id = NEW.id;
END;
