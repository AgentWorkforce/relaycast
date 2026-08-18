import type { WorkspaceProvenanceInput } from '@relaycast/types';

/** SDK-facing workspace provenance options. Wire casing is handled internally. */
export type WorkspaceProvenanceOptions = Omit<WorkspaceProvenanceInput, 'origin_id'> & {
  originId?: string;
};

export function toWorkspaceProvenanceInput(
  provenance?: WorkspaceProvenanceOptions,
): WorkspaceProvenanceInput {
  if (!provenance) {
    return { source: 'sdk' };
  }

  const { originId, ...wireProvenance } = provenance;
  return {
    ...wireProvenance,
    ...(originId !== undefined ? { origin_id: originId } : {}),
  };
}
