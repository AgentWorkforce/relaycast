import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/** Cloud's durable marker for credentials owned by a Relay Connect probe. */
export const RELAY_CONNECT_METADATA_SOURCE = 'cloud-relay-connect';

/** Relay Connect credentials are consumed by the probe's pull loop, not a node socket. */
export function isRelayConnectProbePullMetadata(metadata: unknown): boolean {
  return typeof metadata === 'object'
    && metadata !== null
    && (metadata as Record<string, unknown>).source === RELAY_CONNECT_METADATA_SOURCE;
}

/** SQL equivalent of {@link isRelayConnectProbePullMetadata}. */
export function isRelayConnectProbePullSql(metadata: SQLWrapper): SQL<boolean> {
  return sql<boolean>`COALESCE(json_extract(COALESCE(${metadata}, '{}'), '$.source') = ${RELAY_CONNECT_METADATA_SOURCE}, FALSE)`;
}
