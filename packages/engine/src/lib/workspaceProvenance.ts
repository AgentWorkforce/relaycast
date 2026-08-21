import type {
  WorkspaceCreationSource,
  WorkspaceProvenanceInput,
  WorkspaceUsageClassification,
} from '@relaycast/types';
import type { WorkspaceProvenanceRecord } from '../db/schema.js';
import {
  extractActorIdentity,
  extractOriginActor,
  requiredOriginInfo,
  UNKNOWN_ORIGIN_ACTOR,
} from './origin.js';

function sourceFromOriginClient(originClient: string): WorkspaceCreationSource {
  const normalized = originClient.toLowerCase();
  if (normalized.includes('mcp')) return 'mcp';
  if (normalized.includes('agent-relay') || normalized.includes('relay-broker')) return 'cli';
  if (normalized.includes('sdk')) return 'sdk';
  return 'api';
}

/**
 * Build the immutable creation snapshot stored on a workspace row.
 *
 * Declared values are analytics dimensions, not authentication claims. Server-
 * sanitized request identity is copied alongside them so hosted reporting can
 * group the workspace without another write on every message.
 */
export function buildWorkspaceProvenance(
  request: Request,
  declared?: WorkspaceProvenanceInput,
): {
  provenance: WorkspaceProvenanceRecord;
  usageClassification: WorkspaceUsageClassification;
  classificationSource: 'creator' | 'unclassified';
  classificationReason: string | null;
  classifiedAt: Date | null;
} {
  const origin = requiredOriginInfo(request);
  const hasOriginClient = origin.origin_client !== 'unknown';
  const originActor = extractOriginActor(request);
  const actor = extractActorIdentity(request);
  const classification = declared?.classification ?? 'unknown';
  const creatorClassified = classification !== 'unknown';

  return {
    provenance: {
      source: declared?.source ?? sourceFromOriginClient(origin.origin_client),
      ...(declared?.origin_id ? { origin_id: declared.origin_id } : {}),
      classification,
      source_basis: declared ? 'declared' : hasOriginClient ? 'origin_client' : 'default',
      ...(originActor !== UNKNOWN_ORIGIN_ACTOR ? { origin_actor: originActor } : {}),
      ...actor,
    },
    usageClassification: classification,
    classificationSource: creatorClassified ? 'creator' : 'unclassified',
    classificationReason: creatorClassified ? 'creator_declared' : null,
    classifiedAt: creatorClassified ? new Date() : null,
  };
}
