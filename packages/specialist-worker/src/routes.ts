import type {
  DelegationRequest,
  GitHubEnumerationParams,
  GitHubInvestigationParams,
  LinearEnumerationParams,
  SpecialistFinding,
  SpecialistFindings,
} from '@agent-assistant/specialists';
import {
  RelayAuthError,
  type RelayAuthTokenClaims,
  TokenVerifier,
} from '@relayauth/sdk';
import { RelayFileClient } from '@relayfile/sdk';
import { Hono, type Context } from 'hono';

import { A2aAgentCardSchema, type A2aAgentCard } from '@relaycast/a2a';
import { handleA2aRpc } from './routes/a2a-rpc.js';
import { checkRequiredSpecialistBindings } from './config/require-bindings.js';
import { createCloneRequester } from './specialist/clone-requester.js';
import {
  createGitHubApiFallback,
  createGitHubLibrarianApiFallback,
} from './specialist/github-api-client.js';
import { createGitHubAgenticSpecialist } from './specialist/github-specialist-agentic.js';
import { createLinearAgenticSpecialist } from './specialist/linear-specialist-agentic.js';

const DEFAULT_RELAYAUTH_URL = 'https://api.relayauth.dev';
const DEFAULT_RELAYFILE_URL = 'https://api.relayfile.dev';
const SPECIALIST_WORKER_AGENT_NAME = 'specialist-worker';
const SPECIALIST_WORKER_VERSION = '1.0.0';
// Specialist only reads from relayfile (listTree + readFile); never writes.
// Keep the delegated-token scopes minimal so a compromised short-lived
// token can't escalate beyond read.
const RELAYFILE_TOKEN_SCOPES = ['fs:read'];
const RELAYFILE_TOKEN_TTL_SECONDS = 3600;

// Cloudflare Workers + nodejs_compat will throw "TypeError: Illegal
// invocation: function called with incorrect `this` reference" when the
// global `fetch` gets detached by the bundler. Always going through
// `globalThis.fetch(...)` preserves the `this` binding at call time AND
// stays test-stubbable via `vi.stubGlobal("fetch", ...)` (a module-level
// bound helper would snapshot fetch before tests can stub it). See
// .claude/rules/workers-fetch.md.
async function callFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return globalThis.fetch(input, init);
}

export type SpecialistWorkerBindings = {
  OPENROUTER_API_KEY?: string;
  RELAYAUTH_API_URL?: string;
  RELAYAUTH_AUDIENCE?: string;
  RELAYAUTH_ISSUER?: string;
  RELAYAUTH_JWKS_URL?: string;
  RELAYAUTH_URL?: string;
  /**
   * RelayAuth coordinates for outbound relayfile-token minting. Required
   * since the legacy HS256 local-signing path was retired (cloud#326 —
   * relayfile accepts RS256 only).
   */
  SPECIALIST_RELAYAUTH_URL?: string;
  SPECIALIST_RELAYAUTH_API_KEY?: string;
  RELAYFILE_URL?: string;
  /**
   * Cloud web app base URL + bearer token for GitHub API proxying via Nango
   * and fire-and-forget /api/v1/github/clone/request clone-on-demand
   * triggers. Optional — when either is missing, the specialist remains
   * VFS-only.
   */
  CLOUD_API_URL?: string;
  SPECIALIST_CLOUD_API_TOKEN?: string;
};

type SpecialistWorkerConfig = {
  relayAuthAudience?: string[];
  relayAuthIssuer: string;
  relayAuthJwksUrl: string;
};

type SpecialistWorkerVariables = {
  config: SpecialistWorkerConfig;
};

type AppEnv = {
  Bindings: SpecialistWorkerBindings;
  Variables: SpecialistWorkerVariables;
};

type DelegationStatus = 'complete' | 'partial' | 'failed';

type LinearDelegationRequest = {
  requestId: string;
  capability: 'linear.enumerate';
  params: LinearEnumerationParams;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
};

type LinearSpecialistFindings = {
  requestId: string;
  capability: 'linear.enumerate';
  status: DelegationStatus;
  summary: string;
  findings: SpecialistFinding[];
  confidence?: number;
  metadata?: Record<string, unknown>;
};

type SupportedDelegationRequest = DelegationRequest | LinearDelegationRequest;
type SupportedSpecialistFindings = SpecialistFindings | LinearSpecialistFindings;

type BaseDelegationRequest = {
  requestId: string;
  capability: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
};

type ErrorResult = {
  ok: false;
  status: 400 | 404;
  error: string;
  code: string;
};

type ParseResult<T> =
  | { ok: true; value: T }
  | ErrorResult;

type GitHubSpecialist = {
  card: A2aAgentCard;
  transport: {
    delegate(request: DelegationRequest): Promise<SpecialistFindings>;
  };
};

type LinearDelegationTransport = {
  delegate(request: LinearDelegationRequest): Promise<LinearSpecialistFindings>;
};

type LinearSpecialist = {
  card: A2aAgentCard;
  transport: LinearDelegationTransport;
};

class SpecialistInternalError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'SpecialistInternalError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
  return isRecord(value)
    && Object.values(value).every((entry) => isStringArray(entry));
}

function isPullRequestRef(value: unknown): value is GitHubInvestigationParams['pr'] {
  return isRecord(value)
    && isNonEmptyString(value.owner)
    && isNonEmptyString(value.repo)
    && Number.isInteger(value.number)
    && (value.number as number) > 0;
}

function readOptionalNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

function readOptionalMetadata(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  return isRecord(value) ? value : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function parseAudience(value: string | undefined): string[] | undefined {
  const entries = value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : undefined;
}

function resolveConfig(
  bindings: SpecialistWorkerBindings,
): SpecialistWorkerConfig {
  const relayAuthUrl = trimTrailingSlash(
    bindings.RELAYAUTH_URL?.trim()
      || bindings.RELAYAUTH_API_URL?.trim()
      || DEFAULT_RELAYAUTH_URL,
  );

  return {
    relayAuthAudience: parseAudience(bindings.RELAYAUTH_AUDIENCE),
    relayAuthIssuer: bindings.RELAYAUTH_ISSUER?.trim() || relayAuthUrl,
    relayAuthJwksUrl:
      bindings.RELAYAUTH_JWKS_URL?.trim()
      || `${relayAuthUrl}/.well-known/jwks.json`,
  };
}

function readBearerToken(authorization: string | undefined): string {
  if (!authorization) {
    throw new RelayAuthError(
      'Missing Authorization header',
      'missing_authorization',
      401,
    );
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match || match[1].trim().length === 0) {
    throw new RelayAuthError(
      'Invalid Authorization header',
      'invalid_authorization',
      401,
    );
  }

  return match[1].trim();
}

async function verifyBearerToken(c: Context<AppEnv>): Promise<RelayAuthTokenClaims> {
  const token = readBearerToken(c.req.header('Authorization'));
  const config = c.get('config');
  const verifier = new TokenVerifier({
    jwksUrl: config.relayAuthJwksUrl,
    issuer: config.relayAuthIssuer,
    ...(config.relayAuthAudience
      ? { audience: config.relayAuthAudience }
      : {}),
  });

  return verifier.verify(token);
}

function parseBaseDelegationRequest(value: unknown): ParseResult<BaseDelegationRequest> {
  if (!isRecord(value)) {
    return {
      ok: false,
      status: 400,
      error: 'DelegationRequest body must be an object',
      code: 'invalid_delegation_request',
    };
  }

  if (!isNonEmptyString(value.requestId)) {
    return {
      ok: false,
      status: 400,
      error: 'DelegationRequest.requestId must be a non-empty string',
      code: 'invalid_delegation_request',
    };
  }

  if (!isNonEmptyString(value.capability)) {
    return {
      ok: false,
      status: 400,
      error: 'DelegationRequest.capability must be a non-empty string',
      code: 'invalid_delegation_request',
    };
  }

  if (!isRecord(value.params)) {
    return {
      ok: false,
      status: 400,
      error: 'DelegationRequest.params must be an object',
      code: 'invalid_delegation_request',
    };
  }

  if (value.timeoutMs !== undefined && !isFiniteNumber(value.timeoutMs)) {
    return {
      ok: false,
      status: 400,
      error: 'DelegationRequest.timeoutMs must be a finite number',
      code: 'invalid_delegation_request',
    };
  }

  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    return {
      ok: false,
      status: 400,
      error: 'DelegationRequest.metadata must be an object',
      code: 'invalid_delegation_request',
    };
  }

  if (value.params.capability !== value.capability) {
    return {
      ok: false,
      status: 400,
      error: 'DelegationRequest.params.capability must match DelegationRequest.capability',
      code: 'invalid_delegation_request',
    };
  }

  return {
    ok: true,
    value: {
      requestId: value.requestId.trim(),
      capability: value.capability.trim(),
      params: value.params,
      timeoutMs: readOptionalNumber(value.timeoutMs),
      metadata: readOptionalMetadata(value.metadata),
    },
  };
}

function narrowDelegationRequest(
  request: BaseDelegationRequest,
): ParseResult<SupportedDelegationRequest> {
  switch (request.capability) {
    case 'pr_investigation':
    case 'github.investigate':
      if (!isNonEmptyString(request.params.query)) {
        return {
          ok: false,
          status: 400,
          error: 'GitHub investigation requests require params.query',
          code: 'invalid_delegation_request',
        };
      }

      if (
        request.params.filters !== undefined
        && !isStringArrayRecord(request.params.filters)
      ) {
        return {
          ok: false,
          status: 400,
          error: 'GitHub investigation params.filters must be a string[] record',
          code: 'invalid_delegation_request',
        };
      }

      if (
        request.params.limit !== undefined
        && !isFiniteNumber(request.params.limit)
      ) {
        return {
          ok: false,
          status: 400,
          error: 'GitHub investigation params.limit must be a finite number',
          code: 'invalid_delegation_request',
        };
      }

      if (
        request.params.pr !== undefined
        && !isPullRequestRef(request.params.pr)
      ) {
        return {
          ok: false,
          status: 400,
          error: 'GitHub investigation params.pr must be a valid pull request reference',
          code: 'invalid_delegation_request',
        };
      }

      const githubInvestigationQuery = request.params.query as string;
      const githubInvestigationFilters =
        request.params.filters as GitHubInvestigationParams['filters'] | undefined;
      const githubInvestigationLimit =
        request.params.limit as number | undefined;
      const githubInvestigationPr =
        request.params.pr as GitHubInvestigationParams['pr'];

      const githubInvestigationParams: GitHubInvestigationParams = {
        capability: request.capability,
        query: githubInvestigationQuery,
        ...(githubInvestigationFilters === undefined
          ? {}
          : { filters: githubInvestigationFilters }),
        ...(githubInvestigationLimit === undefined
          ? {}
          : { limit: githubInvestigationLimit }),
        ...(githubInvestigationPr === undefined
          ? {}
          : { pr: githubInvestigationPr }),
      };

      return {
        ok: true,
        value: {
          requestId: request.requestId,
          capability: githubInvestigationParams.capability,
          params: githubInvestigationParams,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        },
      };
    case 'github.enumerate':
      if (
        request.params.query !== undefined
        && typeof request.params.query !== 'string'
      ) {
        return {
          ok: false,
          status: 400,
          error: 'GitHub enumeration params.query must be a string',
          code: 'invalid_delegation_request',
        };
      }

      if (
        request.params.filters !== undefined
        && !isStringArrayRecord(request.params.filters)
      ) {
        return {
          ok: false,
          status: 400,
          error: 'GitHub enumeration params.filters must be a string[] record',
          code: 'invalid_delegation_request',
        };
      }

      if (
        request.params.cursor !== undefined
        && typeof request.params.cursor !== 'string'
      ) {
        return {
          ok: false,
          status: 400,
          error: 'GitHub enumeration params.cursor must be a string',
          code: 'invalid_delegation_request',
        };
      }

      if (
        request.params.limit !== undefined
        && !isFiniteNumber(request.params.limit)
      ) {
        return {
          ok: false,
          status: 400,
          error: 'GitHub enumeration params.limit must be a finite number',
          code: 'invalid_delegation_request',
        };
      }

      const githubEnumerationQuery =
        request.params.query as string | undefined;
      const githubEnumerationFilters =
        request.params.filters as GitHubEnumerationParams['filters'] | undefined;
      const githubEnumerationCursor =
        request.params.cursor as string | undefined;
      const githubEnumerationLimit =
        request.params.limit as number | undefined;

      const githubEnumerationParams: GitHubEnumerationParams = {
        capability: 'github.enumerate',
        ...(githubEnumerationQuery === undefined
          ? {}
          : { query: githubEnumerationQuery }),
        ...(githubEnumerationFilters === undefined
          ? {}
          : { filters: githubEnumerationFilters }),
        ...(githubEnumerationCursor === undefined
          ? {}
          : { cursor: githubEnumerationCursor }),
        ...(githubEnumerationLimit === undefined
          ? {}
          : { limit: githubEnumerationLimit }),
      };

      return {
        ok: true,
        value: {
          requestId: request.requestId,
          capability: githubEnumerationParams.capability,
          params: githubEnumerationParams,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        },
      };
    case 'linear.enumerate':
      if (
        request.params.query !== undefined
        && typeof request.params.query !== 'string'
      ) {
        return {
          ok: false,
          status: 400,
          error: 'Linear enumeration params.query must be a string',
          code: 'invalid_delegation_request',
        };
      }

      if (
        request.params.filters !== undefined
        && !isStringArrayRecord(request.params.filters)
      ) {
        return {
          ok: false,
          status: 400,
          error: 'Linear enumeration params.filters must be a string[] record',
          code: 'invalid_delegation_request',
        };
      }

      if (
        request.params.cursor !== undefined
        && typeof request.params.cursor !== 'string'
      ) {
        return {
          ok: false,
          status: 400,
          error: 'Linear enumeration params.cursor must be a string',
          code: 'invalid_delegation_request',
        };
      }

      if (
        request.params.limit !== undefined
        && !isFiniteNumber(request.params.limit)
      ) {
        return {
          ok: false,
          status: 400,
          error: 'Linear enumeration params.limit must be a finite number',
          code: 'invalid_delegation_request',
        };
      }

      const linearEnumerationQuery =
        request.params.query as string | undefined;
      const linearEnumerationFilters =
        request.params.filters as LinearEnumerationParams['filters'] | undefined;
      const linearEnumerationCursor =
        request.params.cursor as string | undefined;
      const linearEnumerationLimit =
        request.params.limit as number | undefined;

      const linearEnumerationParams: LinearEnumerationParams = {
        capability: 'linear.enumerate',
        ...(linearEnumerationQuery === undefined
          ? {}
          : { query: linearEnumerationQuery }),
        ...(linearEnumerationFilters === undefined
          ? {}
          : { filters: linearEnumerationFilters }),
        ...(linearEnumerationCursor === undefined
          ? {}
          : { cursor: linearEnumerationCursor }),
        ...(linearEnumerationLimit === undefined
          ? {}
          : { limit: linearEnumerationLimit }),
      };

      return {
        ok: true,
        value: {
          requestId: request.requestId,
          capability: linearEnumerationParams.capability,
          params: linearEnumerationParams,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        },
      };
    default:
      return {
        ok: false,
        status: 404,
        error: `Unknown capability: ${request.capability}`,
        code: 'unknown_capability',
      };
  }
}

function buildGitHubSpecialistCard(baseUrl = ''): A2aAgentCard {
  return {
    name: 'sage-github-specialist',
    description:
      'GitHub specialist for pull request investigation and repository enumeration.',
    url: baseUrl,
    version: SPECIALIST_WORKER_VERSION,
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    skills: [
      {
        id: 'pr_investigation',
        name: 'PR Investigation',
        description: 'Investigate a pull request and return structured findings.',
      },
      {
        id: 'github.enumerate',
        name: 'GitHub Enumeration',
        description: 'Enumerate GitHub entities and return structured findings.',
      },
    ],
    default_input_modes: ['text'],
    default_output_modes: ['text'],
  };
}

function buildLinearSpecialistCard(baseUrl = ''): A2aAgentCard {
  return {
    name: 'sage-linear-specialist',
    description:
      'Linear specialist for issue and project enumeration across teams.',
    url: baseUrl,
    version: SPECIALIST_WORKER_VERSION,
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    skills: [
      {
        id: 'linear.enumerate',
        name: 'Linear Enumeration',
        description: 'Enumerate Linear entities and return structured findings.',
      },
    ],
    default_input_modes: ['text'],
    default_output_modes: ['text'],
  };
}

function buildDiscoveryDocument(baseUrl: string): A2aAgentCard {
  const github = buildGitHubSpecialistCard(baseUrl);
  const linear = buildLinearSpecialistCard(baseUrl);

  return A2aAgentCardSchema.parse({
    name: SPECIALIST_WORKER_AGENT_NAME,
    description: 'Delegation router for GitHub and Linear specialists.',
    url: baseUrl,
    version: SPECIALIST_WORKER_VERSION,
    capabilities: {
      streaming:
        github.capabilities?.streaming === true
        || linear.capabilities?.streaming === true,
      pushNotifications:
        github.capabilities?.pushNotifications === true
        || linear.capabilities?.pushNotifications === true,
    },
    skills: [
      ...github.skills,
      ...linear.skills,
    ],
    default_input_modes: ['text'],
    default_output_modes: ['text'],
  });
}

function getRequiredEnv(
  bindings: SpecialistWorkerBindings,
  key:
    | 'OPENROUTER_API_KEY'
    | 'SPECIALIST_RELAYAUTH_URL'
    | 'SPECIALIST_RELAYAUTH_API_KEY',
): string {
  const value = bindings[key]?.trim();
  if (!value) {
    throw new SpecialistInternalError(
      `${key} is required`,
      'specialist_configuration_error',
    );
  }
  return value;
}

async function createRelayFileClient(
  bindings: SpecialistWorkerBindings,
  workspaceId: string,
): Promise<RelayFileClient> {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    throw new SpecialistInternalError(
      'workspaceId is required to mint a relayfile token',
      'specialist_configuration_error',
    );
  }

  const relayAuthUrl = getRequiredEnv(bindings, 'SPECIALIST_RELAYAUTH_URL');
  const relayAuthApiKey = getRequiredEnv(
    bindings,
    'SPECIALIST_RELAYAUTH_API_KEY',
  );
  const baseUrl = normalizeBaseUrl(relayAuthUrl);

  const identity = await relayAuthRequest<{ id: string }>(
    baseUrl,
    relayAuthApiKey,
    '/v1/identities',
    {
      method: 'POST',
      body: {
        name: buildSpecialistIdentityName(normalizedWorkspaceId),
        type: 'agent',
        sponsorId: SPECIALIST_WORKER_AGENT_NAME,
        scopes: RELAYFILE_TOKEN_SCOPES,
        metadata: {
          agentName: SPECIALIST_WORKER_AGENT_NAME,
          productId: 'specialist',
          relayfileWorkspaceId: normalizedWorkspaceId,
        },
        workspaceId: normalizedWorkspaceId,
      },
    },
  );

  const tokenPair = await relayAuthRequest<{ accessToken: string }>(
    baseUrl,
    relayAuthApiKey,
    '/v1/tokens',
    {
      method: 'POST',
      body: {
        identityId: identity.id,
        scopes: RELAYFILE_TOKEN_SCOPES,
        audience: ['relayfile'],
        expiresIn: RELAYFILE_TOKEN_TTL_SECONDS,
      },
    },
  );

  return new RelayFileClient({
    baseUrl: trimTrailingSlash(
      bindings.RELAYFILE_URL?.trim() || DEFAULT_RELAYFILE_URL,
    ),
    token: tokenPair.accessToken,
    readCache: {},
  });
}

/**
 * Direct HTTP call to RelayAuth using `globalThis.fetch` so CF Workers
 * doesn't detach the `fetch` binding via esbuild hoisting. Intentionally
 * skips `@relayauth/sdk`'s `RelayAuthClient` — the SDK's internal
 * `_request` calls bare `fetch(...)` which hits the same
 * "Illegal invocation" bug. See .claude/rules/workers-fetch.md.
 */
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
    throw new SpecialistInternalError(
      detail
        ? `RelayAuth request failed (${response.status}) ${path}: ${detail}`
        : `RelayAuth request failed (${response.status}) ${path}`,
      'specialist_relayauth_error',
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

function buildSpecialistIdentityName(workspaceId: string): string {
  const safeWorkspace = workspaceId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 32);
  const timestamp = Date.now().toString(36);
  const random = crypto.randomUUID().slice(0, 8);
  return `${SPECIALIST_WORKER_AGENT_NAME}-${safeWorkspace}-${timestamp}-${random}`;
}

function resolveWorkspaceId(claims: RelayAuthTokenClaims): string {
  const workspaceId = claims.wks?.trim() || claims.workspace_id?.trim();
  if (!workspaceId) {
    throw new SpecialistInternalError(
      'Verified token is missing workspace id',
      'missing_workspace_id',
    );
  }
  return workspaceId;
}

async function delegateToSpecialist(
  request: SupportedDelegationRequest,
  bindings: SpecialistWorkerBindings,
  workspaceId: string,
): Promise<SupportedSpecialistFindings> {
  const relayFile = await createRelayFileClient(bindings, workspaceId);
  const apiKey = getRequiredEnv(bindings, 'OPENROUTER_API_KEY');

  if (request.capability === 'linear.enumerate') {
    return createLinearAgenticSpecialist({
      relayFile,
      workspaceId,
      apiKey,
    }).transport.delegate(request);
  }

  if (
    request.capability !== 'pr_investigation'
    && request.capability !== 'github.investigate'
    && request.capability !== 'github.enumerate'
  ) {
    throw new SpecialistInternalError(
      'No specialist registered for delegation request',
      'unknown_capability',
    );
  }

  const cloudApiUrl = bindings.CLOUD_API_URL?.trim();
  const cloudApiToken = bindings.SPECIALIST_CLOUD_API_TOKEN?.trim();

  const hasCloudGithubProxy = Boolean(cloudApiUrl && cloudApiToken);

  const cloneRequester = hasCloudGithubProxy
    ? createCloneRequester({
      cloudApiUrl: cloudApiUrl!,
      cloudApiToken: cloudApiToken!,
    })
    : undefined;

  const githubApiFallback = hasCloudGithubProxy
    ? createGitHubApiFallback({
      cloudApiUrl: cloudApiUrl!,
      cloudApiToken: cloudApiToken!,
      ...(cloneRequester ? { cloneRequester } : {}),
      workspaceId,
    })
    : undefined;

  const githubLibrarianApiFallback = hasCloudGithubProxy
    ? createGitHubLibrarianApiFallback({
      cloudApiUrl: cloudApiUrl!,
      cloudApiToken: cloudApiToken!,
      ...(cloneRequester ? { cloneRequester } : {}),
      workspaceId,
    })
    : undefined;

  const specialist = createGitHubAgenticSpecialist({
    relayFile,
    workspaceId,
    apiKey,
    ...(githubApiFallback ? { githubApiFallback } : {}),
    ...(githubLibrarianApiFallback ? { githubLibrarianApiFallback } : {}),
  });
  // Narrow the GitHub union back to a single capability for the generic
  // transport.delegate signature. Matches the pattern in routes/a2a-rpc.ts.
  if (request.capability === 'github.enumerate') {
    return specialist.transport.delegate(request);
  }
  return specialist.transport.delegate(request);
}

function withWorkspaceMetadata<T extends SupportedDelegationRequest>(
  request: T,
  workspaceId: string,
): T {
  return {
    ...request,
    metadata: {
      ...(request.metadata ?? {}),
      workspaceId,
    },
  };
}

function errorResponse(
  c: Context<AppEnv>,
  status: number,
  error: string,
  code: string,
) {
  return c.json({ error, code }, status as 400 | 401 | 404 | 500);
}

function normalizeError(error: unknown): {
  status: number;
  error: string;
  code: string;
} {
  if (error instanceof RelayAuthError) {
    return {
      status: error.statusCode ?? 401,
      error: error.message,
      code: error.code,
    };
  }

  if (error instanceof SpecialistInternalError) {
    return {
      status: 500,
      error: error.message,
      code: error.code,
    };
  }

  if (error instanceof Error) {
    return {
      status: 500,
      error: error.message,
      code: 'specialist_internal_error',
    };
  }

  return {
    status: 500,
    error: 'Specialist execution failed',
    code: 'specialist_internal_error',
  };
}

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    // Fail fast on missing required bindings. See
    // `src/config/require-bindings.ts` for rationale + history. The
    // check is cheap (string-length on ~3 env values) and runs on every
    // request so both real traffic and post-deploy smoke probes reveal
    // misconfigurations immediately instead of on a downstream throw
    // hours later.
    const bindingReport = checkRequiredSpecialistBindings(c.env as Record<string, string | undefined>);
    if (bindingReport) {
      console.error(bindingReport.configError.message, {
        missing: bindingReport.missing,
      });
      return c.json(
        {
          error: bindingReport.configError.message,
          code: 'specialist_configuration_error',
          missing: bindingReport.missing,
        },
        500,
      );
    }
    c.set('config', resolveConfig(c.env));
    await next();
  });

  app.get('/.well-known/agent-card.json', (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(buildDiscoveryDocument(origin));
  });

  app.get('/.well-known/agent.json', (c) => {
    const sunset = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toUTCString();
    c.header('Deprecation', 'true');
    c.header('Sunset', sunset);
    return c.redirect('/.well-known/agent-card.json', 308);
  });

  app.use('/a2a/rpc', async (c, next) => {
    try {
      await verifyBearerToken(c);
      await next();
    } catch (error) {
      const normalized = normalizeError(error);
      return errorResponse(
        c,
        normalized.status,
        normalized.error,
        normalized.code,
      );
    }
  });

  app.post('/a2a/rpc', (c) => handleA2aRpc(c));

  app.post('/delegate', (c) => c.json(
    {
      code: 'deprecated_endpoint',
    },
    410,
  ));

  return app;
}

const app = createApp();

export default app;
