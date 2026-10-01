-- Deleting a node probes every child FK by node id alone. Workspace-leading
-- and active-only indexes cannot cover those probes over retained history.
-- Keep nullable keys sparse, but include every status and workspace so SET NULL
-- and CASCADE preserve their existing semantics without full child-table scans.
CREATE INDEX IF NOT EXISTS idx_deliveries_location_node_fk
  ON deliveries(location_node_id) WHERE location_node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deliveries_route_node_fk
  ON deliveries(route_node_id) WHERE route_node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_location_node_fk
  ON agents(location_node_id) WHERE location_node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_origin_node_fk
  ON agents(origin_node_id) WHERE origin_node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_node_bindings_node_fk
  ON agent_node_bindings(node_id);
CREATE INDEX IF NOT EXISTS idx_node_providers_node_fk
  ON node_providers(node_id);
