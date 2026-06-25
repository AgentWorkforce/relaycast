-- Split node kind (transport) from node role (ownership/capability) and
-- collapse WebSocket delivery onto one node envelope.

ALTER TABLE nodes ADD COLUMN role TEXT NOT NULL DEFAULT 'broker';
ALTER TABLE deliveries ADD COLUMN route_node_role TEXT DEFAULT NULL;

UPDATE nodes
SET
  role = CASE
    WHEN kind = 'direct_ws' THEN 'direct'
    WHEN kind = 'fleet_ws' THEN 'broker'
    WHEN kind = 'http_push' AND max_agents = 1 THEN 'direct'
    WHEN kind = 'http_push' THEN 'broker'
    ELSE role
  END,
  kind = CASE
    WHEN kind IN ('direct_ws', 'fleet_ws') THEN 'ws'
    ELSE kind
  END,
  delivery_adapter = CASE
    WHEN delivery_adapter IN ('direct.ws.v1', 'fleet.ws.v1') THEN 'ws.node.v1'
    ELSE delivery_adapter
  END;

UPDATE deliveries
SET
  route_node_role = CASE
    WHEN route_node_kind = 'direct_ws' THEN 'direct'
    WHEN route_node_kind = 'fleet_ws' THEN 'broker'
    WHEN route_node_id IS NOT NULL THEN (
      SELECT n.role
      FROM nodes n
      WHERE n.workspace_id = deliveries.workspace_id
        AND n.id = deliveries.route_node_id
    )
    ELSE NULL
  END,
  route_node_kind = CASE
    WHEN route_node_kind IN ('direct_ws', 'fleet_ws') THEN 'ws'
    ELSE route_node_kind
  END,
  delivery_adapter = CASE
    WHEN delivery_adapter IN ('direct.ws.v1', 'fleet.ws.v1') THEN 'ws.node.v1'
    ELSE delivery_adapter
  END;
