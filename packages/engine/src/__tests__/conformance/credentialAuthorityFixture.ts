import { generateKeyPairSync } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, SignJWT } from 'jose';
import type {
  AgentRegistrationAuthority,
  WorkspaceRegistrationAuthority,
} from '@relaycast/types';
import type { EngineConfig } from '../../ports/index.js';

export const TEST_SPONSOR_ISSUER = 'https://auth.test.example';
export const TEST_SPONSOR_AUDIENCE = 'relayauth:sponsor-binding';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const TEST_SPONSOR_PUBLIC_KEY_PEM = keys.publicKey.export({
  format: 'pem',
  type: 'spki',
}).toString();

let kidPromise: Promise<string> | undefined;

async function signingKid(): Promise<string> {
  kidPromise ??= exportJWK(keys.publicKey).then((jwk) => calculateJwkThumbprint(jwk, 'sha256'));
  return kidPromise;
}

export function testCredentialAuthorityConfig(): NonNullable<EngineConfig['agentCredentialAuthority']> {
  return {
    publicKeyPem: TEST_SPONSOR_PUBLIC_KEY_PEM,
    issuer: TEST_SPONSOR_ISSUER,
    audience: TEST_SPONSOR_AUDIENCE,
  };
}

export async function mintSponsorProof(options: {
  orgId?: string;
  sponsorId?: string;
  expiresInSeconds?: number;
  issuedAt?: number;
} = {}): Promise<string> {
  const now = options.issuedAt ?? Math.floor(Date.now() / 1000);
  const sponsorId = options.sponsorId ?? 'user_test_owner';
  return new SignJWT({
    org: options.orgId ?? 'org_test',
    intent: 'identity.create',
    token_type: 'sponsor_grant',
    oidc: {
      issuer: 'https://idp.test.example',
      subject: sponsorId.replace(/^user_/u, 'oidc_'),
      iat: now,
    },
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: await signingKid() })
    .setIssuer(TEST_SPONSOR_ISSUER)
    .setAudience(TEST_SPONSOR_AUDIENCE)
    .setSubject(sponsorId)
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresInSeconds ?? 300))
    .setJti(`spg_${crypto.randomUUID().replace(/-/gu, '')}`)
    .sign(keys.privateKey);
}

export function workspaceAuthority(sponsorProof: string): WorkspaceRegistrationAuthority {
  return { sponsor_proof: sponsorProof };
}

export function agentAuthority(
  sponsorProof: string,
  workUnitKey = 'test-work-unit-key-000000000000000000000001',
): AgentRegistrationAuthority {
  return { sponsor_proof: sponsorProof, work_unit_key: workUnitKey };
}
