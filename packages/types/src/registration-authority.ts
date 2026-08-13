import { z } from 'zod';

/** Maximum compact JWS size accepted for a RelayAuth sponsor grant. */
export const SPONSOR_PROOF_MAX_BYTES = 16 * 1024;

/**
 * Proof material presented to the server before it creates or rotates an
 * agent credential. The sponsor identity and organization are deliberately
 * absent: both are derived from the signed proof and are never trusted from a
 * caller-controlled field.
 */
export const AgentRegistrationAuthoritySchema = z
  .object({
    sponsor_proof: z.string().min(1).max(SPONSOR_PROOF_MAX_BYTES),
    work_unit_key: z.string().min(32).max(4096),
  })
  .strict();

export type AgentRegistrationAuthority = z.infer<typeof AgentRegistrationAuthoritySchema>;

/** Sponsor proof used to pin a newly-created workspace to its RelayAuth org. */
export const WorkspaceRegistrationAuthoritySchema = z
  .object({
    sponsor_proof: z.string().min(1).max(SPONSOR_PROOF_MAX_BYTES),
  })
  .strict();

export type WorkspaceRegistrationAuthority = z.infer<typeof WorkspaceRegistrationAuthoritySchema>;
