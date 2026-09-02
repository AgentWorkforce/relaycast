-- `last_heartbeat_at` does not mean "this node proved it was alive". It is
-- written by registration (registerNode, upsertProvider, recomputeNodeAggregate)
-- and by disconnect cleanup (markNodeOffline, markProviderOffline,
-- markDirectNodeOfflineForAgent) as well as by genuine heartbeats, so a node
-- that registered and never sent a heartbeat carries a timestamp indistinguish-
-- able from one that did.
--
-- machine_id reuse must not be decided on that column: reusing a row rotates
-- its token, so a wrong answer silently revokes a credential another host is
-- holding. `proven_live_at` is written ONLY by an arriving heartbeat frame, and
-- is cleared whenever enrollment re-issues a row's token, so a freshly issued
-- credential has to prove itself before that row can be reused again.
ALTER TABLE nodes ADD COLUMN proven_live_at INTEGER DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_nodes_workspace_machine_proven
  ON nodes(workspace_id, machine_id, proven_live_at);
