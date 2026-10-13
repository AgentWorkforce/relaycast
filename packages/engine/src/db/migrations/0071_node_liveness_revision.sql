-- Unix-second timestamps cannot order a heartbeat or registration that lands
-- in the same second as an offline claim. Give every node a monotonic liveness
-- generation and stamp related provider, hosted-agent, and dispatch writes
-- relative to it. The settle tail can then clean old generations after the
-- control fence is released without touching any post-claim work.
ALTER TABLE nodes ADD COLUMN liveness_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE node_providers ADD COLUMN liveness_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN node_liveness_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE action_invocations ADD COLUMN node_liveness_revision INTEGER NOT NULL DEFAULT 0;

-- Normal node heartbeat/register writes advance the parent generation. An
-- offline claim sets liveness_revision itself, so the WHEN clause preserves
-- that explicitly chosen boundary instead of incrementing it again.
CREATE TRIGGER nodes_advance_liveness_revision
AFTER UPDATE OF status, last_heartbeat_at ON nodes
FOR EACH ROW
WHEN NEW.liveness_revision = OLD.liveness_revision
BEGIN
  UPDATE nodes
  SET liveness_revision = MAX(
    OLD.liveness_revision + 1,
    COALESCE((
      SELECT MAX(liveness_revision)
      FROM node_providers
      WHERE workspace_id = NEW.workspace_id AND node_id = NEW.id
    ), 0),
    COALESCE((
      SELECT MAX(node_liveness_revision)
      FROM agents
      WHERE workspace_id = NEW.workspace_id AND location_node_id = NEW.id
    ), 0),
    COALESCE((
      SELECT MAX(node_liveness_revision)
      FROM action_invocations
      WHERE workspace_id = NEW.workspace_id AND dispatched_node_id = NEW.id
    ), 0)
  )
  WHERE id = NEW.id;
END;

CREATE TRIGGER node_providers_stamp_liveness_revision_insert
AFTER INSERT ON node_providers
FOR EACH ROW
BEGIN
  UPDATE node_providers
  SET liveness_revision = COALESCE((
    SELECT liveness_revision + 1
    FROM nodes
    WHERE workspace_id = NEW.workspace_id AND id = NEW.node_id
  ), 1)
  WHERE id = NEW.id;
END;

CREATE TRIGGER node_providers_stamp_liveness_revision_update
AFTER UPDATE OF status, last_heartbeat_at, instance_id ON node_providers
FOR EACH ROW
WHEN NEW.liveness_revision = OLD.liveness_revision
BEGIN
  UPDATE node_providers
  SET liveness_revision = COALESCE((
    SELECT liveness_revision + 1
    FROM nodes
    WHERE workspace_id = NEW.workspace_id AND id = NEW.node_id
  ), OLD.liveness_revision + 1)
  WHERE id = NEW.id;
END;

CREATE TRIGGER agents_stamp_node_liveness_revision_insert
AFTER INSERT ON agents
FOR EACH ROW
WHEN NEW.location_type = 'via_node' AND NEW.location_node_id IS NOT NULL
BEGIN
  UPDATE agents
  SET node_liveness_revision = COALESCE((
    SELECT liveness_revision + 1
    FROM nodes
    WHERE workspace_id = NEW.workspace_id AND id = NEW.location_node_id
  ), 1)
  WHERE id = NEW.id;
END;

CREATE TRIGGER agents_stamp_node_liveness_revision_update
AFTER UPDATE OF status, last_seen, location_type, location_node_id, provider_name ON agents
FOR EACH ROW
WHEN NEW.location_type = 'via_node'
  AND NEW.location_node_id IS NOT NULL
  AND NEW.node_liveness_revision = OLD.node_liveness_revision
BEGIN
  UPDATE agents
  SET node_liveness_revision = COALESCE((
    SELECT liveness_revision + 1
    FROM nodes
    WHERE workspace_id = NEW.workspace_id AND id = NEW.location_node_id
  ), OLD.node_liveness_revision + 1)
  WHERE id = NEW.id;
END;

CREATE TRIGGER action_invocations_stamp_node_liveness_revision_insert
AFTER INSERT ON action_invocations
FOR EACH ROW
WHEN NEW.dispatched_node_id IS NOT NULL
BEGIN
  UPDATE action_invocations
  SET node_liveness_revision = COALESCE((
    SELECT liveness_revision + 1
    FROM nodes
    WHERE workspace_id = NEW.workspace_id AND id = NEW.dispatched_node_id
  ), 1)
  WHERE id = NEW.id;
END;

CREATE TRIGGER action_invocations_stamp_node_liveness_revision_update
AFTER UPDATE OF status, dispatched_node_id, dispatched_at, dispatch_attempts ON action_invocations
FOR EACH ROW
WHEN NEW.dispatched_node_id IS NOT NULL
  AND NEW.node_liveness_revision = OLD.node_liveness_revision
BEGIN
  UPDATE action_invocations
  SET node_liveness_revision = COALESCE((
    SELECT liveness_revision + 1
    FROM nodes
    WHERE workspace_id = NEW.workspace_id AND id = NEW.dispatched_node_id
  ), OLD.node_liveness_revision + 1)
  WHERE id = NEW.id;
END;
