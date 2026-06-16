'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEvent, useRelay } from '@relaycast/react';
import { RelayError, type NodeRosterEntry } from '@relaycast/sdk';

// Re-fetch the authoritative roster on this cadence so the view self-heals if a
// `node.*` event is ever missed and so client-side liveness stays fresh.
const RECONCILE_INTERVAL_MS = 20_000;

function sortNodes(nodes: NodeRosterEntry[]): NodeRosterEntry[] {
  return [...nodes].sort((a, b) => {
    // Live nodes first, then online-but-stale, then offline; ties broken by name.
    const rank = (n: NodeRosterEntry) => (n.live ? 0 : n.status === 'online' ? 1 : 2);
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return a.name.localeCompare(b.name);
  });
}

export interface UseFleetReturn {
  nodes: NodeRosterEntry[];
  loading: boolean;
  /** True when the per-workspace fleet rollout flag is off (GET /v1/nodes → 404). */
  disabled: boolean;
  error: Error | null;
  refresh: () => void;
}

/**
 * Tracks the workspace's fleet node roster. Seeds from `relay.nodes.list()`, then
 * applies live `node.online` / `node.heartbeat` / `node.offline` events emitted on
 * the workspace stream, with a periodic reconcile poll as a backstop.
 */
export function useFleet(): UseFleetReturn {
  const relay = useRelay();
  const [nodesById, setNodesById] = useState<Map<string, NodeRosterEntry>>(new Map());
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await relay.nodes.list();
      setNodesById(new Map(list.map((node) => [node.id, node])));
      setDisabled(false);
      setError(null);
    } catch (err: unknown) {
      // A 404 with `fleet_nodes_disabled` means the workspace hasn't opted into
      // the fleet rollout — that's an expected state, not an error.
      if (err instanceof RelayError && (err.rawCode === 'fleet_nodes_disabled' || err.statusCode === 404)) {
        setDisabled(true);
        setNodesById(new Map());
        setError(null);
      } else {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      setLoading(false);
    }
  }, [relay]);

  const upsertNode = useCallback((node: NodeRosterEntry | undefined) => {
    if (!node?.id) return;
    setNodesById((prev) => {
      const next = new Map(prev);
      next.set(node.id, node);
      return next;
    });
  }, []);

  useEffect(() => {
    void refresh();
    pollTimer.current = setInterval(() => void refresh(), RECONCILE_INTERVAL_MS);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = null;
    };
  }, [refresh]);

  // The event payload is the same camelCased roster entry as the REST list.
  const handleNodeEvent = useCallback(
    (evt: unknown) => {
      const node = (evt as { node?: NodeRosterEntry }).node;
      upsertNode(node);
    },
    [upsertNode],
  );

  useEvent('node.online', handleNodeEvent);
  useEvent('node.heartbeat', handleNodeEvent);
  useEvent('node.offline', handleNodeEvent);

  const nodes = useMemo(() => sortNodes([...nodesById.values()]), [nodesById]);

  return { nodes, loading, disabled, error, refresh };
}
