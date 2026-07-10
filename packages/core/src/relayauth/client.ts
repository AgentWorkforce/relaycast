import { RelayAuthClient } from '@relayauth/sdk';
import type { TokenPair } from '@relayauth/types';

type WorkflowIdentity = {
  id: string;
};

type RelayAuthRequestInit = {
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
};

type RevocableRelayAuthClient = RelayAuthClient & {
  revokeIdentity?: (identityId: string) => Promise<void>;
};

export function createRelayAuthClient(): RelayAuthClient | null {
  const baseUrl = process.env.RelayauthUrl ?? process.env.RELAYAUTH_URL;
  const apiKey = process.env.RELAYAUTH_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return new RelayAuthClient({ baseUrl, apiKey });
}

export async function createWorkflowIdentity(
  client: RelayAuthClient,
  runId: string,
  userId: string,
  workspaceId: string,
): Promise<{ identityId: string; token: TokenPair }> {
  const identity = await relayAuthRequest<WorkflowIdentity>(client, '/v1/identities', {
    method: 'POST',
    body: {
      name: `wf-${runId.slice(0, 8)}`,
      type: 'agent',
      sponsor: userId,
      sponsorId: userId,
      scopes: [
        `relaycast:channel:read:wf-${runId}*`,
        `relaycast:message:write:wf-${runId}*`,
        'relaycast:dm:read:*',
        'relaycast:dm:send:*',
        'relayfile:fs:read:*',
        'relayfile:fs:write:*',
        `cloud:workflow:read:${runId}`,
      ],
      budget: { maxActionsPerHour: 1000 },
      metadata: { runId, workspaceId },
      workspaceId,
    },
  });

  const token = await relayAuthRequest<TokenPair>(client, '/v1/tokens', {
    method: 'POST',
    body: {
      identityId: identity.id,
      ttl: '1h',
      expiresIn: 60 * 60,
    },
  });

  return { identityId: identity.id, token };
}

export async function revokeWorkflowIdentity(
  client: RelayAuthClient,
  identityId: string,
): Promise<void> {
  const revocableClient = client as RevocableRelayAuthClient;

  if (typeof revocableClient.revokeIdentity === 'function') {
    await revocableClient.revokeIdentity(identityId).catch(() => {});
    return;
  }

  await client.deleteIdentity(identityId).catch(() => {});
}

async function relayAuthRequest<T>(
  client: RelayAuthClient,
  path: string,
  init: RelayAuthRequestInit = {},
): Promise<T> {
  const url = new URL(path, normalizeBaseUrl(client.options.baseUrl));
  const headers = new Headers(init.headers);

  if (client.options.apiKey) {
    headers.set('x-api-key', client.options.apiKey);
  }

  if (client.options.token) {
    headers.set('authorization', `Bearer ${client.options.token}`);
  }

  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.body);
  }

  const response = await fetch(url, {
    method: init.method,
    headers,
    body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      detail
        ? `RelayAuth request failed (${response.status}): ${detail}`
        : `RelayAuth request failed (${response.status})`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}
