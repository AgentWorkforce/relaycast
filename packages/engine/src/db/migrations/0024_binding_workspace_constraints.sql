-- Additive follow-up for environments that already ran 0021 before
-- workspace-consistent binding constraints were introduced.

CREATE UNIQUE INDEX IF NOT EXISTS agents_workspace_id_unique
  ON agents(workspace_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS nodes_workspace_id_unique
  ON nodes(workspace_id, id);

CREATE TABLE IF NOT EXISTS agent_node_bindings_constrained (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  session_ref TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER,
  FOREIGN KEY(workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id, node_id) REFERENCES nodes(workspace_id, id) ON DELETE CASCADE,
  UNIQUE(agent_id, node_id)
);

INSERT OR IGNORE INTO agent_node_bindings_constrained (
  id,
  workspace_id,
  agent_id,
  node_id,
  status,
  session_ref,
  priority,
  created_at,
  updated_at
)
SELECT
  b.id,
  b.workspace_id,
  b.agent_id,
  b.node_id,
  b.status,
  b.session_ref,
  b.priority,
  b.created_at,
  b.updated_at
FROM agent_node_bindings b
INNER JOIN agents a
  ON a.workspace_id = b.workspace_id
 AND a.id = b.agent_id
INNER JOIN nodes n
  ON n.workspace_id = b.workspace_id
 AND n.id = b.node_id;

DROP TABLE agent_node_bindings;

ALTER TABLE agent_node_bindings_constrained RENAME TO agent_node_bindings;

CREATE INDEX IF NOT EXISTS idx_agent_node_bindings_workspace
  ON agent_node_bindings(workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_agent_node_bindings_agent
  ON agent_node_bindings(workspace_id, agent_id, status);

CREATE INDEX IF NOT EXISTS idx_agent_node_bindings_node
  ON agent_node_bindings(workspace_id, node_id, status);

CREATE TRIGGER IF NOT EXISTS agent_node_bindings_workspace_agent_insert
BEFORE INSERT ON agent_node_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM agents a
  WHERE a.workspace_id = NEW.workspace_id
    AND a.id = NEW.agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent_node_bindings workspace/agent mismatch');
END;

CREATE TRIGGER IF NOT EXISTS agent_node_bindings_workspace_node_insert
BEFORE INSERT ON agent_node_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM nodes n
  WHERE n.workspace_id = NEW.workspace_id
    AND n.id = NEW.node_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent_node_bindings workspace/node mismatch');
END;

CREATE TRIGGER IF NOT EXISTS agent_node_bindings_workspace_agent_update
BEFORE UPDATE OF workspace_id, agent_id ON agent_node_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM agents a
  WHERE a.workspace_id = NEW.workspace_id
    AND a.id = NEW.agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent_node_bindings workspace/agent mismatch');
END;

CREATE TRIGGER IF NOT EXISTS agent_node_bindings_workspace_node_update
BEFORE UPDATE OF workspace_id, node_id ON agent_node_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM nodes n
  WHERE n.workspace_id = NEW.workspace_id
    AND n.id = NEW.node_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent_node_bindings workspace/node mismatch');
END;
