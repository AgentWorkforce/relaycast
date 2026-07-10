import { randomUUID } from 'crypto';
import type { PathTokenPair, TokenPair, WorkspacePathTokenPair } from '@relayauth/types';

export class RelayAuthMintError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
  ) {
    super(message);
    this.name = 'RelayAuthMintError';
  }

  get mintErrorCode(): 'needs_reauth' | 'scope_insufficient' | 'relayauth_unavailable' {
    // Scope errors are terminal for a mint request: retrying sends the same
    // scopes and cannot make an invalid or insufficient grant succeed.
    if (
      this.responseBody.includes('insufficient_scope') ||
      this.responseBody.includes('invalid_scope')
    ) {
      return 'scope_insufficient';
    }
    if (this.statusCode === 401 || this.statusCode === 403) {
      return 'needs_reauth';
    }
    return 'relayauth_unavailable';
  }
}

export interface RelayfileConfig {
  url: string;
  relayAuthUrl: string;
  relayAuthApiKey: string;
}

export interface RelayfilePermissionConfig {
  ignored?: string[];
  readonly?: string[];
}

export interface MintRelayfileTokenOptions {
  workspaceId: string;
  relayAuthUrl: string;
  relayAuthApiKey: string;
  agentName?: string;
  scopes?: string[];
  ttlSeconds?: number;
}

export interface MintWorkspaceApiKeyOptions {
  workspaceId: string;
  relayAuthUrl: string;
  relayAuthApiKey: string;
  scopes?: string[];
  name?: string;
}

export interface MintPathScopedRelayfileTokenOptions {
  workspaceId: string;
  relayAuthUrl: string;
  workspaceToken?: string;
  relayAuthApiKey?: string;
  paths: string[];
  ttlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  delegationNotAfter?: string;
  agentName?: string;
  agentId?: string;
  scopes?: string[];
  auditLogger?: {
    info(message: string, context: Record<string, unknown>): unknown;
  };
}

export interface MintWorkspacePathScopedRelayfileTokenOptions {
  workspaceId: string;
  relayAuthUrl: string;
  relayAuthApiKey: string;
  paths: string[];
  scopes: string[];
  ttlSeconds: number;
  refreshTokenTtlSeconds?: number;
  delegationNotAfter?: string;
  agentName: string;
  agentId?: string;
  auditLogger?: {
    info(message: string, context: Record<string, unknown>): unknown;
  };
}

export interface MintWorkspaceScopedRelayfileTokenOptions {
  workspaceId: string;
  relayAuthUrl: string;
  relayAuthApiKey: string;
  scopes: string[];
  ttlSeconds: number;
  refreshTokenTtlSeconds?: number;
  delegationNotAfter?: string;
  agentName: string;
  agentId?: string;
  auditLogger?: MintPathScopedRelayfileTokenOptions["auditLogger"];
}

export type MintPathScopedRelayfileTokenPairResult =
  (PathTokenPair | WorkspacePathTokenPair) & { scopes: string[] };

export interface MintWorkspacePathScopedRelayfileTokenPairResult extends WorkspacePathTokenPair {
  scopes: string[];
}

export interface MintWorkspaceScopedRelayfileTokenPairResult extends TokenPair {
  scopes: string[];
  delegationNotAfter?: string;
}

const ROUTE_READ_SCOPE = 'fs:read';
const ROUTE_WRITE_SCOPE = 'fs:write';
const SYNC_READ_SCOPE = 'sync:read';
const SYNC_TRIGGER_SCOPE = 'sync:trigger';
const RELAYFILE_READ_SCOPE = 'relayfile:fs:read:*';
const RELAYFILE_WRITE_SCOPE = 'relayfile:fs:write:*';
const RELAYFILE_READ_PREFIX = 'relayfile:fs:read:';
const RELAYFILE_WRITE_PREFIX = 'relayfile:fs:write:';
const DENY_SCOPE_PREFIX = 'deny:scope:';
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_RELAYFILE_TOKEN_SCOPES = [
  ROUTE_READ_SCOPE,
  ROUTE_WRITE_SCOPE,
  SYNC_READ_SCOPE,
  SYNC_TRIGGER_SCOPE,
];
const DEFAULT_RELAYFILE_TOKEN_TTL_SECONDS = 7_200;

async function callFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return globalThis.fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
  });
}

function trimRequired(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required to mint a relayfile token`);
  }
  return trimmed;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function buildRelayfileIdentityName(workspaceId: string, agentName: string): string {
  const safeWorkspace = workspaceId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 32);
  const safeAgent = agentName.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48);
  return `${safeAgent || 'cloud-agent'}-${safeWorkspace}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

async function createRelayfileIdentity(options: {
  workspaceId: string;
  relayAuthUrl: string;
  relayAuthApiKey: string;
  agentName: string;
  scopes: string[];
}): Promise<string> {
  const identity = await relayAuthRequest<{ id: string }>(
    options.relayAuthUrl,
    options.relayAuthApiKey,
    '/v1/identities',
    {
      method: 'POST',
      body: {
        name: buildRelayfileIdentityName(options.workspaceId, options.agentName),
        type: 'agent',
        sponsorId: options.agentName,
        scopes: options.scopes,
        metadata: {
          agentName: options.agentName,
          productId: 'cloud',
          relayfileWorkspaceId: options.workspaceId,
        },
        workspaceId: options.workspaceId,
      },
    },
  );

  if (!identity.id?.trim()) {
    throw new Error('RelayAuth identity response did not include id');
  }
  return identity.id;
}

async function relayAuthRequest<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: HeadersInit } = {},
): Promise<T> {
  const url = new URL(path, baseUrl);
  const headers = new Headers(init.headers);
  headers.set('x-api-key', apiKey);

  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.body);
  }

  const response = await callFetch(url.toString(), {
    method: init.method,
    headers,
    body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new RelayAuthMintError(
      detail
        ? `RelayAuth request failed (${response.status}) ${path}: ${detail}`
        : `RelayAuth request failed (${response.status}) ${path}`,
      response.status,
      detail,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export async function mintRelayfileToken(
  opts: MintRelayfileTokenOptions,
): Promise<string> {
  const workspaceId = trimRequired(opts.workspaceId, 'workspaceId');
  const relayAuthUrl = normalizeBaseUrl(trimRequired(opts.relayAuthUrl, 'relayAuthUrl'));
  const relayAuthApiKey = trimRequired(opts.relayAuthApiKey, 'relayAuthApiKey');
  const agentName = opts.agentName?.trim() || 'cloud-orchestrator';
  const scopes = dedupeScopes(opts.scopes ?? DEFAULT_RELAYFILE_TOKEN_SCOPES);

  const identityId = await createRelayfileIdentity({
    workspaceId,
    relayAuthUrl,
    relayAuthApiKey,
    agentName,
    scopes,
  });

  const tokenPair = await relayAuthRequest<{ accessToken: string }>(
    relayAuthUrl,
    relayAuthApiKey,
    '/v1/tokens',
    {
      method: 'POST',
      body: {
        identityId,
        scopes,
        audience: ['relayfile'],
        expiresIn: opts.ttlSeconds ?? DEFAULT_RELAYFILE_TOKEN_TTL_SECONDS,
      },
    },
  );

  if (!tokenPair.accessToken?.trim()) {
    throw new Error('RelayAuth token response did not include accessToken');
  }
  return tokenPair.accessToken;
}

export async function mintWorkspaceApiKey(
  opts: MintWorkspaceApiKeyOptions,
): Promise<string> {
  const workspaceId = trimRequired(opts.workspaceId, 'workspaceId');
  const relayAuthUrl = normalizeBaseUrl(trimRequired(opts.relayAuthUrl, 'relayAuthUrl'));
  const relayAuthApiKey = trimRequired(opts.relayAuthApiKey, 'relayAuthApiKey');
  const scopes = opts.scopes ? dedupeScopes(opts.scopes) : undefined;
  const name = opts.name?.trim();

  const response = await relayAuthRequest<{ key?: string }>(
    relayAuthUrl,
    relayAuthApiKey,
    '/v1/tokens/workspace',
    {
      method: 'POST',
      body: {
        workspaceId,
        ...(scopes ? { scopes } : {}),
        ...(name ? { name } : {}),
      },
    },
  );

  if (!response.key?.startsWith('relay_ws_')) {
    throw new Error('RelayAuth workspace token response did not include relay_ws_ key');
  }
  return response.key;
}

function normalizePathTokenPath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed === '*' || trimmed === '/*' || trimmed === '/**') {
    throw new Error('paths must contain at least one non-root relayfile path');
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, '/');
  if (collapsed.endsWith('/')) {
    return `${collapsed.slice(0, -1)}/**`;
  }
  return collapsed;
}

function normalizePathTokenPaths(paths: readonly string[]): string[] {
  return dedupeScopes(paths.map((path) => normalizePathTokenPath(path)));
}

function normalizePathTokenScope(scope: string): string {
  const match = /^relayfile:fs:(read|write):(.+)$/.exec(scope.trim());
  if (!match) {
    return scope.trim();
  }
  return `relayfile:fs:${match[1]}:${normalizePathTokenPath(match[2] ?? '*')}`;
}

function pathTokenScopesFromPaths(paths: readonly string[]): string[] {
  return dedupeScopes(paths.flatMap((path) => [
    `relayfile:fs:read:${path}`,
    `relayfile:fs:write:${path}`,
  ]));
}

function recordPathTokenMinted(
  logger: MintPathScopedRelayfileTokenOptions['auditLogger'],
  context: Record<string, unknown>,
): void {
  if (logger) {
    void logger.info('Relayfile path-scoped token minted', context);
    return;
  }

  console.info('[relayfile] Relayfile path-scoped token minted', context);
}

export async function mintPathScopedRelayfileTokenPair(
  opts: MintPathScopedRelayfileTokenOptions,
): Promise<MintPathScopedRelayfileTokenPairResult> {
  const workspaceId = trimRequired(opts.workspaceId, 'workspaceId');
  const relayAuthUrl = normalizeBaseUrl(trimRequired(opts.relayAuthUrl, 'relayAuthUrl'));
  const workspaceToken = opts.workspaceToken?.trim();
  const relayAuthApiKey = opts.relayAuthApiKey?.trim();
  if (!workspaceToken && !relayAuthApiKey) {
    throw new Error('workspaceToken or relayAuthApiKey is required to mint a relayfile token');
  }
  const agentName = opts.agentName?.trim() || 'cloud-orchestrator';
  const paths = normalizePathTokenPaths(opts.paths);
  if (paths.length === 0) {
    throw new Error('paths is required to mint a path-scoped relayfile token');
  }

  const scopes = opts.scopes
    ? dedupeScopes(opts.scopes.map((scope) => normalizePathTokenScope(scope)))
    : pathTokenScopesFromPaths(paths);

  if (relayAuthApiKey) {
    return mintWorkspacePathScopedRelayfileTokenPair({
      workspaceId,
      relayAuthUrl,
      relayAuthApiKey,
      paths,
      scopes,
      ttlSeconds: opts.ttlSeconds ?? 3_600,
      refreshTokenTtlSeconds: opts.refreshTokenTtlSeconds,
      delegationNotAfter: opts.delegationNotAfter,
      agentName,
      agentId: opts.agentId,
      auditLogger: opts.auditLogger,
    });
  }

  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set('authorization', `Bearer ${workspaceToken}`);
  const response = await callFetch(new URL('/v1/tokens/path', relayAuthUrl).toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      workspaceId,
      paths,
      ttlSeconds: opts.ttlSeconds ?? 3_600,
      ...(opts.refreshTokenTtlSeconds ? { refreshTokenTtlSeconds: opts.refreshTokenTtlSeconds } : {}),
      ...(opts.delegationNotAfter?.trim() ? { delegationNotAfter: opts.delegationNotAfter.trim() } : {}),
      agentName,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new RelayAuthMintError(`relayauth path-token mint failed: ${response.status} ${body}`, response.status, body);
  }

  const tokenPair = await response.json() as Partial<PathTokenPair | WorkspacePathTokenPair>;
  if (!tokenPair.accessToken?.startsWith('relay_pa_')) {
    throw new Error('relayauth returned token without expected relay_pa_ prefix');
  }
  if (!tokenPair.refreshToken?.startsWith('relay_pa_')) {
    throw new Error('relayauth returned refresh token without expected relay_pa_ prefix');
  }
  if (
    typeof tokenPair.accessTokenExpiresAt !== 'string' ||
    typeof tokenPair.refreshTokenExpiresAt !== 'string' ||
    tokenPair.tokenType !== 'Bearer'
  ) {
    throw new Error('relayauth path-token response did not include expected TokenPair metadata');
  }

  recordPathTokenMinted(opts.auditLogger, {
    area: 'relayfile',
    outcome: 'path_token_minted',
    workspaceId,
    agentName,
    agentId: opts.agentId?.trim() || undefined,
    paths,
    scopes,
    requester: agentName,
  });

  return {
    ...(tokenPair as PathTokenPair),
    scopes,
  };
}

export async function mintPathScopedRelayfileToken(
  opts: MintPathScopedRelayfileTokenOptions,
): Promise<string> {
  const tokenPair = await mintPathScopedRelayfileTokenPair(opts);
  return tokenPair.accessToken;
}

export async function mintWorkspacePathScopedRelayfileTokenPair(
  opts: MintWorkspacePathScopedRelayfileTokenOptions,
): Promise<MintWorkspacePathScopedRelayfileTokenPairResult> {
  const workspaceId = trimRequired(opts.workspaceId, 'workspaceId');
  const relayAuthUrl = normalizeBaseUrl(trimRequired(opts.relayAuthUrl, 'relayAuthUrl'));
  const relayAuthApiKey = trimRequired(opts.relayAuthApiKey, 'relayAuthApiKey');
  const agentName = trimRequired(opts.agentName, 'agentName');
  const paths = normalizePathTokenPaths(opts.paths);
  if (paths.length === 0) {
    throw new Error('paths is required to mint a direct workspace path relayfile token');
  }
  const scopes = dedupeScopes(opts.scopes.map((scope) => normalizePathTokenScope(scope)));
  if (scopes.length === 0) {
    throw new Error('scopes is required to mint a direct workspace path relayfile token');
  }

  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set('x-api-key', relayAuthApiKey);
  const response = await callFetch(new URL('/v1/tokens/workspace-path', relayAuthUrl).toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      workspaceId,
      paths,
      scopes,
      audience: ['relayfile'],
      ttlSeconds: opts.ttlSeconds,
      ...(opts.refreshTokenTtlSeconds ? { refreshTokenTtlSeconds: opts.refreshTokenTtlSeconds } : {}),
      ...(opts.delegationNotAfter?.trim() ? { delegationNotAfter: opts.delegationNotAfter.trim() } : {}),
      agentName,
      ...(opts.agentId?.trim() ? { agentId: opts.agentId.trim() } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new RelayAuthMintError(`relayauth direct workspace path-token mint failed: ${response.status} ${body}`, response.status, body);
  }

  const tokenPair = await response.json() as {
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: string;
    refreshTokenExpiresAt?: string;
    tokenType?: string;
    delegationNotAfter?: string;
    key?: string;
    workspaceToken?: string;
    issuedViaWorkspaceTokenId?: string;
  };
  if (tokenPair.key || tokenPair.workspaceToken || tokenPair.issuedViaWorkspaceTokenId) {
    throw new Error('relayauth direct workspace path-token response included workspace-token material');
  }
  if (!tokenPair.accessToken?.startsWith('relay_pa_')) {
    throw new Error('relayauth returned token without expected relay_pa_ prefix');
  }
  if (!tokenPair.refreshToken?.startsWith('relay_pa_')) {
    throw new Error('relayauth returned refresh token without expected relay_pa_ prefix');
  }
  if (
    typeof tokenPair.accessTokenExpiresAt !== 'string' ||
    typeof tokenPair.refreshTokenExpiresAt !== 'string' ||
    tokenPair.tokenType !== 'Bearer'
  ) {
    throw new Error('relayauth direct workspace path-token response did not include expected TokenPair metadata');
  }

  recordPathTokenMinted(opts.auditLogger, {
    area: 'relayfile',
    outcome: 'direct_workspace_path_token_minted',
    workspaceId,
    agentName,
    agentId: opts.agentId?.trim() || undefined,
    paths,
    scopes,
    ttlSeconds: opts.ttlSeconds,
    requester: agentName,
  });

  return {
    ...(tokenPair as WorkspacePathTokenPair),
    scopes,
  };
}

export async function mintWorkspacePathScopedRelayfileToken(
  opts: MintWorkspacePathScopedRelayfileTokenOptions,
): Promise<string> {
  const tokenPair = await mintWorkspacePathScopedRelayfileTokenPair(opts);
  return tokenPair.accessToken;
}

export async function mintWorkspaceScopedRelayfileTokenPair(
  opts: MintWorkspaceScopedRelayfileTokenOptions,
): Promise<MintWorkspaceScopedRelayfileTokenPairResult> {
  const workspaceId = trimRequired(opts.workspaceId, 'workspaceId');
  const relayAuthUrl = normalizeBaseUrl(trimRequired(opts.relayAuthUrl, 'relayAuthUrl'));
  const relayAuthApiKey = trimRequired(opts.relayAuthApiKey, 'relayAuthApiKey');
  const agentName = trimRequired(opts.agentName, 'agentName');
  const scopes = dedupeScopes(opts.scopes.map((scope) => scope.trim()).filter(Boolean));
  if (scopes.length === 0) {
    throw new Error('scopes is required to mint a workspace relayfile token');
  }

  const identityId = await createRelayfileIdentity({
    workspaceId,
    relayAuthUrl,
    relayAuthApiKey,
    agentName,
    scopes,
  });
  const workspaceToken = await mintWorkspaceApiKey({
    workspaceId,
    relayAuthUrl,
    relayAuthApiKey,
    scopes: ['relayauth:token:create:*', ...scopes],
    name: `${agentName}-delegated`,
  });

  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set('x-api-key', workspaceToken);
  const response = await callFetch(new URL('/v1/tokens/agent', relayAuthUrl).toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      agentId: identityId,
      scopes,
      audience: ['relayfile'],
      expiresIn: opts.ttlSeconds,
      ...(opts.refreshTokenTtlSeconds ? { refreshTokenTtlSeconds: opts.refreshTokenTtlSeconds } : {}),
      ...(opts.delegationNotAfter?.trim() ? { delegationNotAfter: opts.delegationNotAfter.trim() } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new RelayAuthMintError(`relayauth direct workspace agent-token mint failed: ${response.status} ${body}`, response.status, body);
  }

  const tokenPair = await response.json() as {
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: string;
    refreshTokenExpiresAt?: string;
    tokenType?: string;
    agentId?: string;
    workspaceId?: string;
    tokenClass?: string;
    issuedViaWorkspaceTokenId?: string;
    delegationNotAfter?: string;
  };

  if (!tokenPair.accessToken?.startsWith('relay_ag_')) {
    throw new Error('relayauth returned token without expected relay_ag_ prefix');
  }
  if (!tokenPair.refreshToken?.startsWith('relay_ag_')) {
    throw new Error('relayauth returned refresh token without expected relay_ag_ prefix');
  }
  if (
    typeof tokenPair.accessTokenExpiresAt !== 'string' ||
    typeof tokenPair.refreshTokenExpiresAt !== 'string' ||
    tokenPair.tokenType !== 'Bearer'
  ) {
    throw new Error('relayauth workspace-scoped token response did not include expected TokenPair metadata');
  }

  recordPathTokenMinted(opts.auditLogger, {
    area: 'relayfile',
    outcome: 'workspace_scoped_token_minted',
    workspaceId,
    agentName,
    agentId: opts.agentId?.trim() || identityId,
    scopes,
    ttlSeconds: opts.ttlSeconds,
    requester: agentName,
  });

  return {
    ...(tokenPair as TokenPair),
    scopes,
    ...(opts.delegationNotAfter?.trim() ? { delegationNotAfter: opts.delegationNotAfter.trim() } : {}),
  };
}

export function mintScopedRelayfileToken(opts: MintRelayfileTokenOptions & {
  agentName: string;
  scopes: string[];
}): Promise<string> {
  return mintRelayfileToken({
    ...opts,
    scopes: dedupeScopes(opts.scopes),
    ttlSeconds: opts.ttlSeconds ?? 3_600,
  });
}

function normalizeScopePath(file: string): string {
  const trimmed = file.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed === '*') {
    return '*';
  }

  const withoutDotPrefix = trimmed.startsWith('./') ? trimmed.slice(1) : trimmed;
  const normalized = (withoutDotPrefix.startsWith('/') ? withoutDotPrefix : `/${withoutDotPrefix}`)
    .replace(/\/{2,}/g, '/');

  if (normalized.endsWith('/')) {
    return `${normalized}**`;
  }

  return normalized;
}

function dedupeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
}

function isRelayfileReadScope(scope: string): boolean {
  return scope === RELAYFILE_READ_SCOPE || scope.startsWith(RELAYFILE_READ_PREFIX);
}

function isRelayfileWriteScope(scope: string): boolean {
  return scope === RELAYFILE_WRITE_SCOPE || scope.startsWith(RELAYFILE_WRITE_PREFIX);
}

function normalizePermissionList(paths?: readonly string[]): string[] {
  return dedupeScopes((paths ?? []).map((path) => normalizeScopePath(path)));
}

function toDenyScope(scope: string): string {
  return `${DENY_SCOPE_PREFIX}${scope}`;
}

function matchesScopePattern(scopePath: string, pattern: string): boolean {
  if (pattern === '*') {
    return true;
  }
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return scopePath === prefix || scopePath.startsWith(`${prefix}/`);
  }
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return scopePath.startsWith(prefix);
  }
  return scopePath === pattern;
}

export function applyRelayfilePermissionsToScopes(
  baseScopes: readonly string[],
  permissions: RelayfilePermissionConfig = {},
): string[] {
  const ignored = normalizePermissionList(permissions.ignored);
  const readonly = normalizePermissionList(permissions.readonly);
  const ignoredAll = ignored.includes('*');
  const readonlyAll = readonly.includes('*');

  let scopes = dedupeScopes(baseScopes);
  const canRead = scopes.some((scope) => scope === ROUTE_READ_SCOPE || isRelayfileReadScope(scope));
  const canWrite = scopes.some((scope) => scope === ROUTE_WRITE_SCOPE || isRelayfileWriteScope(scope));

  if (ignoredAll) {
    scopes = scopes.filter((scope) =>
      scope !== ROUTE_READ_SCOPE &&
      scope !== ROUTE_WRITE_SCOPE &&
      scope !== SYNC_READ_SCOPE &&
      !isRelayfileReadScope(scope) &&
      !isRelayfileWriteScope(scope)
    );
  } else {
    if (canRead && !scopes.includes(ROUTE_READ_SCOPE)) {
      scopes.unshift(ROUTE_READ_SCOPE);
    }
    if ((canRead || canWrite) && !scopes.includes(SYNC_READ_SCOPE)) {
      scopes.unshift(SYNC_READ_SCOPE);
    }

    if (readonlyAll) {
      scopes = scopes.filter((scope) => scope !== ROUTE_WRITE_SCOPE && !isRelayfileWriteScope(scope));
    } else if (canWrite && !scopes.includes(ROUTE_WRITE_SCOPE)) {
      scopes.unshift(ROUTE_WRITE_SCOPE);
    }
  }

  const denyScopes = [
    ...ignored.flatMap((pattern) =>
      pattern === '*'
        ? [toDenyScope(RELAYFILE_READ_SCOPE), toDenyScope(RELAYFILE_WRITE_SCOPE)]
        : [
            toDenyScope(`${RELAYFILE_READ_PREFIX}${pattern}`),
            toDenyScope(`${RELAYFILE_WRITE_PREFIX}${pattern}`),
          ]
    ),
    ...readonly.flatMap((pattern) =>
      pattern === '*'
        ? [toDenyScope(RELAYFILE_WRITE_SCOPE)]
        : [toDenyScope(`${RELAYFILE_WRITE_PREFIX}${pattern}`)]
    ),
  ];

  return dedupeScopes([...scopes, ...denyScopes]);
}

export function compilePermissionsToScopes(
  permissions: RelayfilePermissionConfig,
  allFiles?: string[],
): string[] {
  const ignored = normalizePermissionList(permissions.ignored);
  const readonly = normalizePermissionList(permissions.readonly);

  if (!allFiles) {
    return applyRelayfilePermissionsToScopes(
      [RELAYFILE_READ_SCOPE, RELAYFILE_WRITE_SCOPE],
      permissions,
    );
  }

  const scopes: string[] = [];
  let hasReadableFile = false;
  let hasWritableFile = false;

  for (const file of allFiles) {
    const scopePath = normalizeScopePath(file);
    if (ignored.some((pattern) => matchesScopePattern(scopePath, pattern))) {
      continue;
    }

    scopes.push(`${RELAYFILE_READ_PREFIX}${scopePath}`);
    hasReadableFile = true;

    if (!readonly.some((pattern) => matchesScopePattern(scopePath, pattern))) {
      scopes.push(`${RELAYFILE_WRITE_PREFIX}${scopePath}`);
      hasWritableFile = true;
    }
  }

  if (hasReadableFile) {
    scopes.unshift(SYNC_READ_SCOPE);
  }
  if (hasReadableFile) {
    scopes.unshift(ROUTE_READ_SCOPE);
  }
  if (hasWritableFile) {
    scopes.unshift(ROUTE_WRITE_SCOPE);
  }

  return dedupeScopes(scopes);
}

export interface RelayfileClient {
  baseUrl: string;
  token: string;
  workspaceId: string;
}

export async function createRelayfileClient(
  url: string,
  relayAuthUrl: string,
  relayAuthApiKey: string,
  workspaceId: string,
): Promise<RelayfileClient> {
  const token = await mintRelayfileToken({
    workspaceId,
    relayAuthUrl,
    relayAuthApiKey,
  });
  return {
    baseUrl: url.replace(/\/$/, ''),
    token,
    workspaceId,
  };
}
