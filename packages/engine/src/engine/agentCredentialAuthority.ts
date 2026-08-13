import { and, eq, isNull, or } from 'drizzle-orm';
import {
  calculateJwkThumbprint,
  exportJWK,
  importSPKI,
  jwtVerify,
  type CryptoKey,
  type JWTPayload,
  type JWTVerifyResult,
} from 'jose';
import type {
  AgentRegistrationAuthority,
  WorkspaceRegistrationAuthority,
} from '@relaycast/types';
import type { getDb } from '../db/index.js';
import { agentCredentialClaims, agents, workspaces } from '../db/schema.js';
import { codedError } from '../lib/httpError.js';
import { sha256Hex } from '../lib/crypto.js';
import type { EngineConfig } from '../ports/index.js';
import { runAtomicWrites } from '../ports/database.js';

type Db = ReturnType<typeof getDb>;

const DEFAULT_AUDIENCE = 'relayauth:sponsor-binding';
const REQUIRED_INTENT = 'identity.create';
const REQUIRED_TOKEN_TYPE = 'sponsor_grant';
const CLOCK_SKEW_SECONDS = 60;
const SPONSOR_ID_PATTERN = /^user_[A-Za-z0-9_-]+$/u;
const RESERVED_METADATA_KEYS = new Set([
  'identity_key',
  'relayauth_sponsor_id',
  'relayauth_sponsor_binding',
  'relayauth_sponsor_proof_sha256',
]);

export interface SponsorAgentBinding {
  sponsorOrgId: string;
  sponsorId: string;
  sponsorOidcIssuer: string;
  sponsorOidcSubject: string;
  workUnitKeyHash: string;
  sponsorProofHash: string;
  sponsorBoundAt: Date;
}

export type AgentCredentialAuthorityDecision =
  | { mode: 'unenforced' }
  | { mode: 'sponsor'; binding: SponsorAgentBinding };

interface VerifiedSponsorGrant {
  orgId: string;
  sponsorId: string;
  oidcIssuer: string;
  oidcSubject: string;
  proofHash: string;
}

interface CachedVerificationKey {
  key: CryptoKey;
  kid: string;
}

const verificationKeyCache = new Map<string, Promise<CachedVerificationKey>>();

function authorityConfig(config: EngineConfig): NonNullable<EngineConfig['agentCredentialAuthority']> | undefined {
  return config.agentCredentialAuthority;
}

function invalidSponsorProof(): Error {
  return codedError('A valid, current RelayAuth sponsor proof is required', 'invalid_sponsor_proof', 403);
}

function authorityConfigurationError(): Error {
  return codedError('Agent credential authority is not configured correctly', 'credential_authority_unavailable', 503);
}

function migrationRequired(): Error {
  return codedError(
    'This legacy agent must bind its sponsor using its existing agent token before workspace-key rotation or reclaim',
    'agent_sponsor_migration_required',
    409,
  );
}

function requireConfigString(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw authorityConfigurationError();
  return normalized;
}

async function loadVerificationKey(publicKeyPem: string): Promise<CachedVerificationKey> {
  let pending = verificationKeyCache.get(publicKeyPem);
  if (!pending) {
    pending = (async () => {
      const key = await importSPKI(publicKeyPem, 'RS256');
      const jwk = await exportJWK(key);
      return { key, kid: await calculateJwkThumbprint(jwk, 'sha256') };
    })();
    verificationKeyCache.set(publicKeyPem, pending);
  }
  try {
    return await pending;
  } catch {
    verificationKeyCache.delete(publicKeyPem);
    throw authorityConfigurationError();
  }
}

function claimString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function claimInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function parseVerifiedGrant(
  verified: JWTVerifyResult<JWTPayload>,
  expectedKid: string,
  expectedIssuer: string,
  expectedAudience: string,
  expectedOrgId?: string,
): Omit<VerifiedSponsorGrant, 'proofHash'> {
  const { protectedHeader: header, payload: claims } = verified;
  const orgId = claimString(claims.org);
  const sponsorId = claimString(claims.sub);
  const issuedAt = claimInteger(claims.iat);
  const expiresAt = claimInteger(claims.exp);
  const grantId = claimString(claims.jti);
  const oidc = claims.oidc;
  const now = Math.floor(Date.now() / 1000);
  if (
    header.alg !== 'RS256'
    || header.kid !== expectedKid
    || (header.typ !== undefined && header.typ !== 'JWT')
    || header.crit !== undefined
    || claims.iss !== expectedIssuer
    || claims.aud !== expectedAudience
    || claims.intent !== REQUIRED_INTENT
    || claims.token_type !== REQUIRED_TOKEN_TYPE
    || !orgId
    || (expectedOrgId !== undefined && orgId !== expectedOrgId)
    || !sponsorId
    || !SPONSOR_ID_PATTERN.test(sponsorId)
    || sponsorId.length > 256
    || issuedAt === null
    || expiresAt === null
    || !grantId
    || issuedAt > now + CLOCK_SKEW_SECONDS
    || expiresAt <= now
    || !oidc
    || typeof oidc !== 'object'
    || Array.isArray(oidc)
  ) {
    throw invalidSponsorProof();
  }

  const oidcRecord = oidc as Record<string, unknown>;
  const oidcIssuer = claimString(oidcRecord.issuer);
  const oidcSubject = claimString(oidcRecord.subject);
  const oidcIssuedAt = claimInteger(oidcRecord.iat);
  if (!oidcIssuer || !oidcSubject || oidcIssuedAt === null || oidcIssuedAt <= 0) {
    throw invalidSponsorProof();
  }

  return { orgId, sponsorId, oidcIssuer, oidcSubject };
}

async function verifySponsorGrant(
  config: NonNullable<EngineConfig['agentCredentialAuthority']>,
  proof: string,
  expectedOrgId?: string,
): Promise<VerifiedSponsorGrant> {
  const publicKeyPem = requireConfigString(config.publicKeyPem);
  const issuer = requireConfigString(config.issuer);
  const audience = config.audience?.trim() || DEFAULT_AUDIENCE;
  const { key, kid } = await loadVerificationKey(publicKeyPem);

  let verified: JWTVerifyResult<JWTPayload>;
  try {
    verified = await jwtVerify(proof, key, {
      algorithms: ['RS256'],
      issuer,
      audience,
      requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'jti'],
      clockTolerance: 0,
    });
  } catch {
    throw invalidSponsorProof();
  }

  return {
    ...parseVerifiedGrant(verified, kid, issuer, audience, expectedOrgId),
    proofHash: await sha256Hex(proof),
  };
}

function toAgentBinding(
  workspaceId: string,
  grant: VerifiedSponsorGrant,
  workUnitKey: string,
): Promise<SponsorAgentBinding> {
  return sha256Hex(`${workspaceId}\0${workUnitKey}`).then((workUnitKeyHash) => ({
    sponsorOrgId: grant.orgId,
    sponsorId: grant.sponsorId,
    sponsorOidcIssuer: grant.oidcIssuer,
    sponsorOidcSubject: grant.oidcSubject,
    workUnitKeyHash,
    sponsorProofHash: grant.proofHash,
    sponsorBoundAt: new Date(),
  }));
}

function rowMatchesBinding(
  row: typeof agents.$inferSelect,
  binding: SponsorAgentBinding,
): boolean {
  return row.sponsorOrgId === binding.sponsorOrgId
    && row.sponsorId === binding.sponsorId
    && row.sponsorOidcIssuer === binding.sponsorOidcIssuer
    && row.sponsorOidcSubject === binding.sponsorOidcSubject
    && row.workUnitKeyHash === binding.workUnitKeyHash;
}

function claimMatchesBinding(
  claim: typeof agentCredentialClaims.$inferSelect,
  binding: SponsorAgentBinding,
): boolean {
  return claim.sponsorOrgId === binding.sponsorOrgId
    && claim.sponsorId === binding.sponsorId
    && claim.sponsorOidcIssuer === binding.sponsorOidcIssuer
    && claim.sponsorOidcSubject === binding.sponsorOidcSubject
    && claim.workUnitKeyHash === binding.workUnitKeyHash;
}

async function assertDurableClaimMatches(
  db: Db,
  workspaceId: string,
  agentName: string,
  binding: SponsorAgentBinding,
): Promise<void> {
  const [claim] = await db
    .select()
    .from(agentCredentialClaims)
    .where(and(
      eq(agentCredentialClaims.workspaceId, workspaceId),
      eq(agentCredentialClaims.agentName, agentName),
    ));
  if (claim && !claimMatchesBinding(claim, binding)) {
    throw codedError(
      'The sponsor proof and work-unit key do not own this agent credential',
      'agent_credential_authority_mismatch',
      409,
    );
  }
}

async function workspaceSponsorOrg(db: Db, workspaceId: string): Promise<string | null> {
  const [workspace] = await db
    .select({ sponsorOrgId: workspaces.sponsorOrgId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!workspace) throw codedError('Workspace not found', 'workspace_not_found', 404);
  return workspace.sponsorOrgId;
}

async function pinEmptyWorkspaceSponsorOrg(db: Db, workspaceId: string, orgId: string): Promise<void> {
  const currentOrg = await workspaceSponsorOrg(db, workspaceId);
  if (currentOrg !== null) {
    if (currentOrg !== orgId) throw invalidSponsorProof();
    return;
  }

  const [incumbent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId))
    .limit(1);
  if (incumbent) throw migrationRequired();

  await db
    .update(workspaces)
    .set({ sponsorOrgId: orgId })
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.sponsorOrgId)));
  if (await workspaceSponsorOrg(db, workspaceId) !== orgId) throw invalidSponsorProof();
}

/** Verify a workspace-create proof before the caller performs any DB write. */
export async function authorizeWorkspaceCreation(
  config: EngineConfig,
  input: WorkspaceRegistrationAuthority | undefined,
): Promise<string | undefined> {
  const enforced = authorityConfig(config);
  if (!enforced) return undefined;
  if (!input) throw invalidSponsorProof();
  return (await verifySponsorGrant(enforced, input.sponsor_proof)).orgId;
}

/** Verify a new registration and pin only an empty legacy workspace. */
export async function authorizeNewAgentCredential(
  db: Db,
  config: EngineConfig,
  workspaceId: string,
  input: AgentRegistrationAuthority | undefined,
): Promise<AgentCredentialAuthorityDecision> {
  const enforced = authorityConfig(config);
  if (!enforced) return { mode: 'unenforced' };
  if (!input) throw invalidSponsorProof();
  const grant = await verifySponsorGrant(enforced, input.sponsor_proof);
  await pinEmptyWorkspaceSponsorOrg(db, workspaceId, grant.orgId);
  const binding = await toAgentBinding(workspaceId, grant, input.work_unit_key);
  return {
    mode: 'sponsor',
    binding,
  };
}

/** Reject recreation of a deleted protected name under a different binding. */
export async function authorizeNewNamedAgentCredential(
  db: Db,
  config: EngineConfig,
  workspaceId: string,
  agentName: string,
  input: AgentRegistrationAuthority | undefined,
): Promise<AgentCredentialAuthorityDecision> {
  const decision = await authorizeNewAgentCredential(db, config, workspaceId, input);
  if (decision.mode === 'sponsor') {
    await assertDurableClaimMatches(db, workspaceId, agentName, decision.binding);
  }
  return decision;
}

/** Verify rotation/reclaim against immutable state; no client metadata participates. */
export async function authorizeExistingAgentCredential(
  db: Db,
  config: EngineConfig,
  workspaceId: string,
  agentName: string,
  input: AgentRegistrationAuthority | undefined,
): Promise<AgentCredentialAuthorityDecision> {
  const enforced = authorityConfig(config);
  if (!enforced) return { mode: 'unenforced' };
  if (!input) throw invalidSponsorProof();

  const orgId = await workspaceSponsorOrg(db, workspaceId);
  if (!orgId) throw migrationRequired();
  const grant = await verifySponsorGrant(enforced, input.sponsor_proof, orgId);
  const binding = await toAgentBinding(workspaceId, grant, input.work_unit_key);
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, agentName)));
  if (!agent) throw codedError(`Agent "${agentName}" not found`, 'agent_not_found', 404);
  if (!agent.sponsorOrgId) throw migrationRequired();
  if (!rowMatchesBinding(agent, binding)) {
    throw codedError(
      'The sponsor proof and work-unit key do not own this agent credential',
      'agent_credential_authority_mismatch',
      409,
    );
  }
  return { mode: 'sponsor', binding };
}

/**
 * One-time legacy migration authenticated by the incumbent agent token at the
 * route layer. Workspace keys cannot invoke this operation.
 */
export async function bindLegacyAgentCredential(
  db: Db,
  config: EngineConfig,
  workspaceId: string,
  agentId: string,
  input: AgentRegistrationAuthority | undefined,
): Promise<AgentCredentialAuthorityDecision> {
  const enforced = authorityConfig(config);
  if (!enforced) return { mode: 'unenforced' };
  if (!input) throw invalidSponsorProof();

  const grant = await verifySponsorGrant(enforced, input.sponsor_proof);
  const binding = await toAgentBinding(workspaceId, grant, input.work_unit_key);
  const [current] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)));
  if (!current) throw codedError('Authenticated agent not found', 'agent_not_found', 404);

  const currentOrg = await workspaceSponsorOrg(db, workspaceId);
  if (currentOrg !== null && currentOrg !== binding.sponsorOrgId) throw invalidSponsorProof();
  if (current.sponsorOrgId !== null) {
    if (!rowMatchesBinding(current, binding)) {
      throw codedError('This agent is already bound to another credential authority', 'agent_credential_authority_mismatch', 409);
    }
    return { mode: 'sponsor', binding };
  }

  const hasPartialBinding = current.sponsorId !== null
    || current.sponsorOidcIssuer !== null
    || current.sponsorOidcSubject !== null
    || current.workUnitKeyHash !== null
    || current.sponsorProofHash !== null
    || current.sponsorBoundAt !== null;
  if (hasPartialBinding) {
    throw codedError('Legacy agent has an incomplete credential binding', 'agent_credential_authority_corrupt', 409);
  }

  await runAtomicWrites(db, (writeDb) => [
    writeDb
      .update(workspaces)
      .set({ sponsorOrgId: binding.sponsorOrgId })
      .where(and(
        eq(workspaces.id, workspaceId),
        or(isNull(workspaces.sponsorOrgId), eq(workspaces.sponsorOrgId, binding.sponsorOrgId)),
      )),
    writeDb
      .update(agents)
      .set(binding)
      .where(and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.id, agentId),
        isNull(agents.sponsorOrgId),
        isNull(agents.sponsorId),
        isNull(agents.sponsorOidcIssuer),
        isNull(agents.sponsorOidcSubject),
        isNull(agents.workUnitKeyHash),
        isNull(agents.sponsorProofHash),
        isNull(agents.sponsorBoundAt),
      )),
    writeDb
      .insert(agentCredentialClaims)
      .values({
        workspaceId,
        agentName: current.name,
        sponsorOrgId: binding.sponsorOrgId,
        sponsorId: binding.sponsorId,
        sponsorOidcIssuer: binding.sponsorOidcIssuer,
        sponsorOidcSubject: binding.sponsorOidcSubject,
        workUnitKeyHash: binding.workUnitKeyHash,
        claimedAt: binding.sponsorBoundAt,
      })
      .onConflictDoNothing(),
  ]);

  const [bound] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)));
  if (!bound || !rowMatchesBinding(bound, binding)) {
    throw codedError('Legacy credential binding lost a concurrent race', 'agent_credential_authority_mismatch', 409);
  }
  return { mode: 'sponsor', binding };
}

export function bindingColumns(decision: AgentCredentialAuthorityDecision): Partial<typeof agents.$inferInsert> {
  return decision.mode === 'sponsor' ? decision.binding : {};
}

export function credentialClaimColumns(
  workspaceId: string,
  agentName: string,
  decision: AgentCredentialAuthorityDecision,
): typeof agentCredentialClaims.$inferInsert | undefined {
  if (decision.mode !== 'sponsor') return undefined;
  return {
    workspaceId,
    agentName,
    sponsorOrgId: decision.binding.sponsorOrgId,
    sponsorId: decision.binding.sponsorId,
    sponsorOidcIssuer: decision.binding.sponsorOidcIssuer,
    sponsorOidcSubject: decision.binding.sponsorOidcSubject,
    workUnitKeyHash: decision.binding.workUnitKeyHash,
    claimedAt: decision.binding.sponsorBoundAt,
  };
}

export function decisionMatchesAgent(
  decision: AgentCredentialAuthorityDecision,
  agent: typeof agents.$inferSelect,
): boolean {
  return decision.mode === 'unenforced' || rowMatchesBinding(agent, decision.binding);
}

/** Prevent editable metadata from masquerading as the server-side binding. */
export function assertNoCredentialAuthorityMetadata(
  config: EngineConfig,
  metadata: Record<string, unknown> | undefined,
): void {
  if (!authorityConfig(config) || !metadata) return;
  const reserved = Object.keys(metadata).find((key) => RESERVED_METADATA_KEYS.has(key));
  if (reserved) {
    throw codedError(
      `Agent metadata key "${reserved}" is reserved for the server credential authority`,
      'reserved_agent_metadata',
      400,
    );
  }
}
