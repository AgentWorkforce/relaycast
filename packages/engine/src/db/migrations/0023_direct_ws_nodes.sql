-- Every agent has exactly one node route. Backfill legacy self-connected agents
-- as implicit direct_ws nodes-of-one.

INSERT OR IGNORE INTO nodes (
  id,
  workspace_id,
  name,
  token_hash,
  kind,
  delivery_adapter,
  delivery_config,
  capabilities,
  max_agents,
  active_agents,
  reserved_agents,
  tags,
  version,
  status,
  handlers_live,
  load,
  last_heartbeat_at,
  created_at
)
SELECT
  'node_direct_' || a.id,
  a.workspace_id,
  'direct-' || a.id,
  'implicit_direct:' || a.workspace_id || ':' || a.id,
  'direct_ws',
  'direct.ws.v1',
  json_object('implicit', 1, 'agent_id', a.id, 'agent_name', a.name),
  json_array(),
  1,
  1,
  0,
  json_array('implicit', 'direct_ws'),
  'implicit',
  CASE WHEN a.status IN ('active', 'online') THEN 'online' ELSE 'offline' END,
  0,
  0,
  CASE WHEN a.status IN ('active', 'online') THEN unixepoch() ELSE NULL END,
  unixepoch()
FROM agents a
WHERE NOT EXISTS (
  SELECT 1
  FROM agent_node_bindings b
  WHERE b.workspace_id = a.workspace_id
    AND b.agent_id = a.id
    AND b.status = 'active'
);

INSERT OR IGNORE INTO agent_node_bindings (
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
  'anb_direct_' || a.id,
  a.workspace_id,
  a.id,
  'node_direct_' || a.id,
  'active',
  a.session_ref,
  0,
  unixepoch(),
  unixepoch()
FROM agents a
WHERE EXISTS (
  SELECT 1
  FROM nodes n
  WHERE n.workspace_id = a.workspace_id
    AND n.id = 'node_direct_' || a.id
    AND n.kind = 'direct_ws'
)
  AND NOT EXISTS (
    SELECT 1
    FROM agent_node_bindings b
    WHERE b.workspace_id = a.workspace_id
      AND b.agent_id = a.id
      AND b.status = 'active'
  );

UPDATE agents
SET
  location_type = 'via_node',
  location_node_id = 'node_direct_' || id,
  origin_node_id = COALESCE(origin_node_id, 'node_direct_' || id)
WHERE EXISTS (
  SELECT 1
  FROM agent_node_bindings b
  WHERE b.workspace_id = agents.workspace_id
    AND b.agent_id = agents.id
    AND b.node_id = 'node_direct_' || agents.id
    AND b.status = 'active'
);

UPDATE deliveries
SET
  route_node_id = 'node_direct_' || agent_id,
  route_node_kind = 'direct_ws',
  delivery_adapter = 'direct.ws.v1'
WHERE route_node_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM agents a
    WHERE a.workspace_id = deliveries.workspace_id
      AND a.id = deliveries.agent_id
      AND a.location_node_id = 'node_direct_' || a.id
  );

UPDATE nodes
SET active_agents = (
  SELECT COUNT(*)
  FROM agent_node_bindings b
  WHERE b.workspace_id = nodes.workspace_id
    AND b.node_id = nodes.id
    AND b.status = 'active'
);
