-- The scheduled unreachable-target sweep (`deadLetterUnreachableDeliveryBatch`)
-- looks for ACTIVE deliveries routed to a long-offline ws node. The only index
-- on location_node_id is the FK index over every delivery ever routed to a
-- node, so production read ~250k rows per run (3.5-4.6s) to find the few still
-- queued or delivered, stalling the shared D1 for every tenant while it ran.
-- Restricting the index to the two active statuses keeps it the size of the
-- live queue, not the delivery history. No data changes.
CREATE INDEX IF NOT EXISTS idx_deliveries_active_location_node
  ON deliveries(location_node_id)
  WHERE status IN ('queued', 'delivered') AND location_node_id IS NOT NULL;
