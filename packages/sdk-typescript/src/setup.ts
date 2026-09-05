import {
  ApiResponseSchema,
  CreateWorkspaceResponseSchema,
  WorkspaceLookupSchema,
} from '@relaycast/types';
import type { ZodType } from 'zod';
import { camelizeKeys } from './casing.js';
import { AgentClient } from './agent.js';
import { HttpClient, type RetryPolicyInput } from './client.js';
import { Relay } from './communicate/relay.js';
import { SDK_ORIGIN } from './origin.js';
import { RelayCast } from './relay.js';
import {
  AgentNotRegisteredError,
  MalformedApiResponseError,
  MissingApiKeyError,
  RelaycastApiError,
} from './setup-errors.js';
import type {
  AgentRecord,
  CreateWorkspaceOptions,
  JoinWorkspaceOptions,
  RegisterAgentOptions,
  RelaycastSetupOptions,
  WorkspaceInfo,
} from './setup-types.js';
import type { WorkspaceLookup } from './types.js';
import { toWorkspaceProvenanceInput } from './workspace-provenance.js';

const DEFAULT_CLOUD_BASE_URL = 'https://cast.agentrelay.com';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const RETRY_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

type ApiKeyProvider = RelaycastSetupOptions['apiKey'];

interface NormalizedRetryPolicy {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  jitter: boolean;
}

interface SetupConfig {
  apiKey: ApiKeyProvider;
  baseUrl: string;
  requestTimeoutMs: number;
  retryPolicy: NormalizedRetryPolicy;
  retryPolicyInput: RetryPolicyInput;
}

interface WorkspaceHandleConfig {
  retryPolicyInput: RetryPolicyInput;
}

interface CreateWorkspaceResult {
  workspaceId: string;
  apiKey: string;
  createdAt: string;
  expiresAt?: string | null;
}

interface RequestConfig {
  method: 'GET' | 'POST';
  path: string;
  schema: ZodType;
  body?: Record<string, unknown>;
  allowNotFound?: boolean;
  requireApiKey?: boolean;
  headers?: Record<string, string>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeRetryPolicy(
  input?: RelaycastSetupOptions['retry'],
): { normalized: NormalizedRetryPolicy; clientInput: RetryPolicyInput } {
  const maxRetries = Number.isFinite(input?.maxRetries)
    ? Math.max(0, Math.floor(input!.maxRetries))
    : DEFAULT_MAX_RETRIES;
  const backoffMs = Number.isFinite(input?.baseDelayMs)
    ? Math.max(0, Math.floor(input!.baseDelayMs))
    : DEFAULT_BASE_DELAY_MS;

  return {
    normalized: {
      maxRetries,
      backoffMs,
      backoffMultiplier: DEFAULT_BACKOFF_MULTIPLIER,
      jitter: true,
    },
    clientInput: {
      maxRetries,
      backoffMs,
      backoffMultiplier: DEFAULT_BACKOFF_MULTIPLIER,
      jitter: true,
      retryOn: [...RETRY_STATUS_CODES],
    },
  };
}

function computeBackoffMs(policy: NormalizedRetryPolicy, retryAttempt: number): number {
  const exponential = policy.backoffMs * (policy.backoffMultiplier ** retryAttempt);
  if (!policy.jitter) {
    return Math.max(0, Math.round(exponential));
  }
  const jitterFactor = 0.5 + Math.random();
  return Math.max(0, Math.round(exponential * jitterFactor));
}

function parseRetryAfterMs(response: Response): number | null {
  const header = response.headers.get('Retry-After');
  if (!header) {
    return null;
  }

  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }

  const asDate = Date.parse(header);
  if (Number.isNaN(asDate)) {
    return null;
  }

  return Math.max(0, asDate - Date.now());
}

function extractMalformedField(responseBody: unknown, fallback = 'response'): string {
  return ApiResponseSchema(CreateWorkspaceResponseSchema)
    .safeParse(responseBody).error?.issues[0]?.path.filter((segment) => typeof segment === 'string').at(-1)
    ?? fallback;
}

function toLookupMalformedField(responseBody: unknown, fallback = 'response'): string {
  return ApiResponseSchema(WorkspaceLookupSchema)
    .safeParse(responseBody).error?.issues[0]?.path.filter((segment) => typeof segment === 'string').at(-1)
    ?? fallback;
}

function normalizeBaseUrl(options?: RelaycastSetupOptions): string {
  if (isNonEmptyString(options?.baseUrl)) {
    return options!.baseUrl!.trim();
  }
  return DEFAULT_CLOUD_BASE_URL;
}

function normalizeStatus(status: string): AgentRecord['status'] {
  return status === 'online' || status === 'away' ? status : 'offline';
}

export class WorkspaceHandle {
  public readonly info: WorkspaceInfo;
  public readonly workspaceId: string;
  public readonly apiKey: string;

  private readonly retryPolicyInput: RetryPolicyInput;
  private relayCastInstance: RelayCast | null = null;
  private readonly agentRecords = new Map<string, AgentRecord>();
  private readonly registrationOrder: AgentRecord[] = [];
  private readonly relays = new Map<string, Relay>();

  constructor(info: WorkspaceInfo, config: WorkspaceHandleConfig) {
    this.info = Object.freeze({ ...info });
    this.workspaceId = info.workspaceId;
    this.apiKey = info.apiKey;
    this.retryPolicyInput = config.retryPolicyInput;
  }

  relayCast(): RelayCast {
    if (!this.relayCastInstance) {
      this.relayCastInstance = new RelayCast({
        apiKey: this.apiKey,
        baseUrl: this.info.baseUrl,
        retryPolicy: this.retryPolicyInput,
      });
    }
    return this.relayCastInstance;
  }

  as(token: string): AgentClient {
    return new AgentClient(new HttpClient({
      apiKey: token,
      baseUrl: this.info.baseUrl,
      retryPolicy: this.retryPolicyInput,
    }));
  }

  relay(agentName: string): Relay {
    const existingRelay = this.relays.get(agentName);
    if (existingRelay) {
      return existingRelay;
    }

    const record = this.agentRecords.get(agentName);
    if (!record) {
      throw new AgentNotRegisteredError(agentName);
    }

    const relay = new Relay(this.as(record.token));
    this.relays.set(agentName, relay);
    return relay;
  }

  async registerAgent(opts: RegisterAgentOptions): Promise<AgentRecord> {
    const created = await this.relayCast().agents.register(opts);
    const record: AgentRecord = {
      ...created,
      type: opts.type ?? 'agent',
      status: normalizeStatus(created.status),
    };

    const existingIndex = this.registrationOrder.findIndex((agent) => agent.name === record.name);
    if (existingIndex >= 0) {
      this.registrationOrder[existingIndex] = record;
    } else {
      this.registrationOrder.push(record);
    }

    this.agentRecords.set(record.name, record);
    this.relays.delete(record.name);
    return record;
  }

  getAgentToken(name: string): string | undefined {
    return this.agentRecords.get(name)?.token;
  }

  listRegisteredAgents(): AgentRecord[] {
    return [...this.registrationOrder];
  }

  getApiKey(): string {
    return this.apiKey;
  }
}

export class RelaycastSetup {
  private readonly config: SetupConfig;

  constructor(options: RelaycastSetupOptions = {}) {
    const retryPolicy = normalizeRetryPolicy(options.retry);

    this.config = {
      apiKey: options.apiKey,
      baseUrl: normalizeBaseUrl(options),
      requestTimeoutMs: Number.isFinite(options.requestTimeoutMs)
        ? Math.max(1, Math.floor(options.requestTimeoutMs!))
        : DEFAULT_REQUEST_TIMEOUT_MS,
      retryPolicy: retryPolicy.normalized,
      retryPolicyInput: retryPolicy.clientInput,
    };
  }

  async createWorkspace(options: CreateWorkspaceOptions): Promise<WorkspaceHandle> {
    const workspace = await this.requestWorkspace<CreateWorkspaceResult>({
      method: 'POST',
      path: '/v1/workspaces',
      schema: CreateWorkspaceResponseSchema,
      body: {
        name: options.name,
        ...(options.expiresInSeconds !== undefined
          ? { expires_in_seconds: options.expiresInSeconds }
          : {}),
        provenance: toWorkspaceProvenanceInput(options.provenance),
      },
      headers: options.idempotencyKey !== undefined
        ? { 'Idempotency-Key': options.idempotencyKey }
        : undefined,
      requireApiKey: true,
    });

    if (!workspace) {
      throw new MalformedApiResponseError('workspace_id', workspace);
    }

    return new WorkspaceHandle(
      {
        workspaceId: workspace.workspaceId,
        apiKey: workspace.apiKey,
        baseUrl: this.config.baseUrl,
        createdAt: workspace.createdAt,
        ...(workspace.expiresAt !== undefined ? { expiresAt: workspace.expiresAt } : {}),
        name: options.name,
      },
      { retryPolicyInput: this.config.retryPolicyInput },
    );
  }

  async joinWorkspace(
    workspaceId: string,
    apiKey: string,
    _options: JoinWorkspaceOptions = {},
  ): Promise<WorkspaceHandle> {
    if (!isNonEmptyString(apiKey)) {
      throw new MissingApiKeyError();
    }

    return new WorkspaceHandle(
      {
        workspaceId,
        apiKey: apiKey.trim(),
        baseUrl: this.config.baseUrl,
      },
      { retryPolicyInput: this.config.retryPolicyInput },
    );
  }

  async lookupWorkspace(name: string): Promise<WorkspaceLookup | null> {
    return this.requestWorkspace<WorkspaceLookup>({
      method: 'GET',
      path: `/v1/workspaces/by-name/${encodeURIComponent(name)}`,
      schema: WorkspaceLookupSchema,
      allowNotFound: true,
    });
  }

  private async resolveApiKey(): Promise<string | undefined> {
    const source = this.config.apiKey;
    if (typeof source === 'function') {
      const resolved = await source();
      return isNonEmptyString(resolved) ? resolved.trim() : undefined;
    }
    return isNonEmptyString(source) ? source.trim() : undefined;
  }

  private async fetchWithRetry(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const url = new URL(path, this.config.baseUrl);
    const apiKey = await this.resolveApiKey();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-SDK-Version': SDK_ORIGIN.version,
      'X-Relaycast-Origin-Client': SDK_ORIGIN.client,
      'X-Relaycast-Origin-Version': SDK_ORIGIN.version,
    };

    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }
    Object.assign(headers, extraHeaders ?? {});

    let attempt = 0;

    while (true) {
      try {
        const response = await fetch(url.toString(), {
          method,
          headers,
          body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });

        if (RETRY_STATUS_CODES.has(response.status) && attempt < this.config.retryPolicy.maxRetries) {
          const waitMs = response.status === 429
            ? parseRetryAfterMs(response) ?? computeBackoffMs(this.config.retryPolicy, attempt)
            : computeBackoffMs(this.config.retryPolicy, attempt);
          attempt += 1;
          await sleep(waitMs);
          continue;
        }

        return response;
      } catch (error) {
        if (attempt >= this.config.retryPolicy.maxRetries) {
          throw error;
        }
        const waitMs = computeBackoffMs(this.config.retryPolicy, attempt);
        attempt += 1;
        await sleep(waitMs);
      }
    }
  }

  private async requestWorkspace<TOutput>({
    method,
    path,
    schema,
    body,
    headers: extraHeaders,
    allowNotFound = false,
    requireApiKey = false,
  }: RequestConfig): Promise<TOutput | null> {
    const response = await this.fetchWithRetry(method, path, body, extraHeaders);

    if (allowNotFound && response.status === 404) {
      return null;
    }

    const responseBody = await this.parseResponseBody(response);

    if (!response.ok) {
      throw new RelaycastApiError(
        response.status,
        responseBody,
        this.extractApiErrorMessage(response.status, responseBody),
      );
    }

    const parsedEnvelope = ApiResponseSchema(schema).safeParse(responseBody);
    if (!parsedEnvelope.success) {
      const fallback = schema === WorkspaceLookupSchema ? toLookupMalformedField(responseBody) : extractMalformedField(responseBody);
      throw new MalformedApiResponseError(fallback, responseBody);
    }

    if (!parsedEnvelope.data.ok) {
      throw new RelaycastApiError(
        response.status,
        responseBody,
        parsedEnvelope.data.error.message,
      );
    }

    const data = camelizeKeys(parsedEnvelope.data.data) as TOutput;
    if (requireApiKey) {
      const candidate = data as { apiKey?: unknown };
      if (!isNonEmptyString(candidate.apiKey)) {
        throw new MalformedApiResponseError('api_key', responseBody);
      }
    }

    return data;
  }

  private async parseResponseBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length === 0) {
      return null;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      if (response.ok) {
        throw new MalformedApiResponseError('response', text, 'Relaycast API response is not valid JSON');
      }
      return text;
    }
  }

  private extractApiErrorMessage(status: number, responseBody: unknown): string {
    const parsedWorkspace = ApiResponseSchema(CreateWorkspaceResponseSchema).safeParse(responseBody);
    if (parsedWorkspace.success && !parsedWorkspace.data.ok) {
      return parsedWorkspace.data.error.message;
    }

    const parsedLookup = ApiResponseSchema(WorkspaceLookupSchema).safeParse(responseBody);
    if (parsedLookup.success && !parsedLookup.data.ok) {
      return parsedLookup.data.error.message;
    }

    return `Relaycast API request failed with status ${status}`;
  }
}
