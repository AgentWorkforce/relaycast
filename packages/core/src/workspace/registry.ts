import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mintRelayfileToken } from "../relayfile/client.js";
import { generateWorkspaceId, isValidWorkspaceId } from "./id.js";

export type WorkspacePermissions = {
  ignored: string[];
  readonly: string[];
};

export interface WorkspaceEntry {
  id: string;
  name?: string;
  relaycastApiKey: string;
  relayfileWorkspaceId: string;
  relayauthWorkspaceId: string;
  createdAt: string;
  createdBy: string;
  permissions: WorkspacePermissions;
}

export interface WorkspaceJoinResult {
  entry: WorkspaceEntry;
  token: string;
  tokenIssuedAt?: string | null;
  tokenExpiresAt?: string | null;
  suggestedRefreshAt?: string | null;
  relaycastApiKey: string;
  relayfileUrl: string;
  relayauthUrl: string;
  wsUrl: string;
  scopes: string[];
}

export interface WorkspaceRegistry {
  create(opts: {
    name?: string;
    createdBy: string;
    permissions?: Partial<WorkspacePermissions>;
  }): Promise<WorkspaceEntry>;
  get(id: string): Promise<WorkspaceEntry | null>;
  join(
    id: string,
    agentName: string,
    options?: {
      permissions?: Partial<WorkspacePermissions>;
      requestedScopes?: string[];
    },
  ): Promise<WorkspaceJoinResult>;
}

export interface WorkspaceRegistryPersistence {
  create(entry: WorkspaceEntry): Promise<WorkspaceEntry>;
  get(id: string): Promise<WorkspaceEntry | null>;
}

export interface MintWorkspaceTokenOptions {
  workspaceId: string;
  agentName: string;
  relayAuthUrl: string;
  relayAuthApiKey: string;
  scopes?: readonly string[];
  ttlSeconds?: number;
}

export interface CloudWorkspaceRegistryOptions {
  relayauthBaseUrl?: string;
  fetchImpl?: typeof fetch;
  persistence?: WorkspaceRegistryPersistence;
  createRelaycastWorkspace?: (input: {
    workspaceId: string;
    name: string;
  }) => Promise<{ apiKey: string }>;
  joinAccessFactory?: (input: {
    entry: WorkspaceEntry;
    agentName: string;
    permissions: WorkspacePermissions;
    requestedScopes?: string[];
  }) => Promise<
    Partial<Pick<WorkspaceJoinResult, "relayfileUrl" | "relayauthUrl" | "wsUrl" | "scopes" | "tokenIssuedAt" | "tokenExpiresAt" | "suggestedRefreshAt">> & {
      token: string;
    }
  >;
  workspaceIdFactory?: () => string;
  now?: () => Date;
  joinScopes?: readonly string[];
  tokenTtlSeconds?: number;
}

export interface LocalWorkspaceRegistryOptions {
  rootDir?: string;
  filePath?: string;
  relaycastBaseUrl?: string;
  relayfileBaseUrl?: string;
  relayauthBaseUrl?: string;
  relayauthApiKey?: string;
  jwtSecret?: string;
  relayApiKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  joinScopes?: readonly string[];
  tokenTtlSeconds?: number;
}

type WorkspaceRegistryFile = {
  version: 1;
  workspaces: Record<string, WorkspaceEntry>;
};

const DEFAULT_JOIN_SCOPES = ["fs:read", "fs:write", "ops:read", "sync:read", "sync:trigger"];
const DEFAULT_RELAYAUTH_URL = "https://api.relayauth.dev";

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildUrl(baseUrl: string, pathname: string): string {
  return new URL(pathname.replace(/^\/+/, ""), `${stripTrailingSlash(baseUrl)}/`).toString();
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizeWorkspacePermissions(
  permissions?: Partial<WorkspacePermissions>,
): WorkspacePermissions {
  return {
    ignored: unique(permissions?.ignored ?? []),
    readonly: unique(permissions?.readonly ?? []),
  };
}

function mergeWorkspacePermissions(
  base: WorkspacePermissions,
  override?: Partial<WorkspacePermissions>,
): WorkspacePermissions {
  const normalizedOverride = normalizeWorkspacePermissions(override);
  return {
    ignored: unique([...base.ignored, ...normalizedOverride.ignored]),
    readonly: unique([...base.readonly, ...normalizedOverride.readonly]),
  };
}

function normalizeScopes(scopes: readonly string[] | undefined): string[] {
  const normalized = unique(scopes ?? DEFAULT_JOIN_SCOPES);
  return normalized.length > 0 ? normalized : [...DEFAULT_JOIN_SCOPES];
}

function toRelayfileWebSocketUrl(relayfileUrl: string, workspaceId: string): string {
  if (!relayfileUrl.trim()) {
    return "";
  }
  const url = new URL(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/ws`,
    `${stripTrailingSlash(relayfileUrl)}/`,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractRelaycastApiKey(payload: unknown): string {
  if (!isRecord(payload)) {
    throw new Error("Relaycast workspace response was not an object");
  }

  const topLevelKey =
    typeof payload.api_key === "string" ? payload.api_key.trim() : "";
  if (topLevelKey) {
    return topLevelKey;
  }

  const nestedKey =
    typeof payload.data === "object" &&
    payload.data !== null &&
    typeof (payload.data as { api_key?: unknown }).api_key === "string"
      ? ((payload.data as { api_key: string }).api_key).trim()
      : "";
  if (nestedKey) {
    return nestedKey;
  }

  throw new Error("Relaycast workspace response did not include api_key");
}

function asWorkspaceEntry(value: unknown): WorkspaceEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!isValidWorkspaceId(id)) {
    return null;
  }

  const relaycastApiKey =
    typeof value.relaycastApiKey === "string" ? value.relaycastApiKey : "";
  const createdAt =
    typeof value.createdAt === "string" ? value.createdAt : "";
  const createdBy =
    typeof value.createdBy === "string" ? value.createdBy : "";
  const name =
    typeof value.name === "string" ? value.name : undefined;
  const permissions = normalizeWorkspacePermissions(
    isRecord(value.permissions)
      ? {
          ignored: Array.isArray(value.permissions.ignored)
            ? value.permissions.ignored.filter((item): item is string => typeof item === "string")
            : undefined,
          readonly: Array.isArray(value.permissions.readonly)
            ? value.permissions.readonly.filter((item): item is string => typeof item === "string")
            : undefined,
        }
      : undefined,
  );

  if (!createdAt || !createdBy) {
    return null;
  }

  return {
    id,
    ...(name ? { name } : {}),
    relaycastApiKey,
    relayfileWorkspaceId: id,
    relayauthWorkspaceId: id,
    createdAt,
    createdBy,
    permissions,
  };
}

export function mintWorkspaceToken(options: MintWorkspaceTokenOptions): Promise<string> {
  return mintRelayfileToken({
    workspaceId: options.workspaceId,
    agentName: options.agentName,
    relayAuthUrl: options.relayAuthUrl,
    relayAuthApiKey: options.relayAuthApiKey,
    scopes: normalizeScopes(options.scopes),
    ttlSeconds: options.ttlSeconds,
  });
}

export class InMemoryWorkspaceRegistryStore implements WorkspaceRegistryPersistence {
  private readonly entries = new Map<string, WorkspaceEntry>();

  async create(entry: WorkspaceEntry): Promise<WorkspaceEntry> {
    this.entries.set(entry.id, entry);
    return entry;
  }

  async get(id: string): Promise<WorkspaceEntry | null> {
    return this.entries.get(id) ?? null;
  }
}

class JsonFileWorkspaceRegistryStore implements WorkspaceRegistryPersistence {
  private writeLock: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async create(entry: WorkspaceEntry): Promise<WorkspaceEntry> {
    // Serialize file writes to prevent lost updates from concurrent create() calls
    return this.withLock(async () => {
      const file = await this.readRegistryFile();
      file.workspaces[entry.id] = entry;
      await this.writeRegistryFile(file);
      return entry;
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLock;
    let resolve!: () => void;
    this.writeLock = new Promise<void>((r) => { resolve = r; });
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }

  async get(id: string): Promise<WorkspaceEntry | null> {
    const file = await this.readRegistryFile();
    return file.workspaces[id] ?? null;
  }

  private async readRegistryFile(): Promise<WorkspaceRegistryFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed.workspaces)) {
        return { version: 1, workspaces: {} };
      }

      const workspaces = Object.fromEntries(
        Object.entries(parsed.workspaces)
          .map(([id, value]) => [id, asWorkspaceEntry(value)] as const)
          .filter((entry): entry is [string, WorkspaceEntry] => entry[1] !== null),
      );

      return { version: 1, workspaces };
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        return { version: 1, workspaces: {} };
      }
      throw error;
    }
  }

  private async writeRegistryFile(file: WorkspaceRegistryFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(file, null, 2) + "\n", "utf8");
  }
}

export class CloudWorkspaceRegistry implements WorkspaceRegistry {
  private readonly relaycastBaseUrl: string;
  private readonly relayfileBaseUrl: string;
  private readonly relayauthBaseUrl: string;
  private readonly relayauthApiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly persistence: WorkspaceRegistryPersistence;
  private readonly createRelaycastWorkspaceImpl: (
    input: { workspaceId: string; name: string },
  ) => Promise<{ apiKey: string }>;
  private readonly joinAccessFactory?: CloudWorkspaceRegistryOptions["joinAccessFactory"];
  private readonly workspaceIdFactory: () => string;
  private readonly now: () => Date;
  private readonly joinScopes: string[];
  private readonly tokenTtlSeconds: number;

  constructor(
    relaycastBaseUrl: string,
    relayfileBaseUrl: string,
    relayauthApiKey: string,
    options: CloudWorkspaceRegistryOptions = {},
  ) {
    this.relaycastBaseUrl = stripTrailingSlash(relaycastBaseUrl);
    this.relayfileBaseUrl = stripTrailingSlash(relayfileBaseUrl);
    this.relayauthBaseUrl = stripTrailingSlash(options.relayauthBaseUrl ?? DEFAULT_RELAYAUTH_URL);
    this.relayauthApiKey = relayauthApiKey.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.persistence = options.persistence ?? new InMemoryWorkspaceRegistryStore();
    this.joinAccessFactory = options.joinAccessFactory;
    this.workspaceIdFactory = options.workspaceIdFactory ?? generateWorkspaceId;
    this.now = options.now ?? (() => new Date());
    this.joinScopes = normalizeScopes(options.joinScopes);
    this.tokenTtlSeconds = options.tokenTtlSeconds ?? 7_200;
    this.createRelaycastWorkspaceImpl =
      options.createRelaycastWorkspace ??
      (async ({ name }) => {
        const response = await this.fetchImpl(buildUrl(this.relaycastBaseUrl, "/v1/workspaces"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(
            `Relaycast workspace creation failed (${response.status} ${response.statusText})${body ? `: ${body.slice(0, 500)}` : ""}`,
          );
        }

        return {
          apiKey: extractRelaycastApiKey(await response.json()),
        };
      });
  }

  async create(opts: {
    name?: string;
    createdBy: string;
    permissions?: Partial<WorkspacePermissions>;
  }): Promise<WorkspaceEntry> {
    const id = this.workspaceIdFactory();
    const resolvedName = opts.name?.trim() || id;
    const entry: WorkspaceEntry = {
      id,
      name: resolvedName,
      relaycastApiKey: (await this.createRelaycastWorkspaceImpl({
        workspaceId: id,
        name: resolvedName,
      })).apiKey,
      relayfileWorkspaceId: id,
      relayauthWorkspaceId: id,
      createdAt: this.now().toISOString(),
      createdBy: opts.createdBy,
      permissions: normalizeWorkspacePermissions(opts.permissions),
    };

    return this.persistence.create(entry);
  }

  async get(id: string): Promise<WorkspaceEntry | null> {
    if (!isValidWorkspaceId(id)) {
      return null;
    }

    return this.persistence.get(id);
  }

  async join(
    id: string,
    agentName: string,
    options?: {
      permissions?: Partial<WorkspacePermissions>;
      requestedScopes?: string[];
    },
  ): Promise<WorkspaceJoinResult> {
    const entry = await this.get(id);
    if (!entry) {
      throw new Error(`Workspace not found: ${id}`);
    }

    const permissions = mergeWorkspacePermissions(entry.permissions, options?.permissions);

    if (this.joinAccessFactory) {
      const access = await this.joinAccessFactory({
        entry,
        agentName,
        permissions,
        requestedScopes: options?.requestedScopes,
      });

      return {
        entry,
        token: access.token,
        tokenIssuedAt: access.tokenIssuedAt ?? null,
        tokenExpiresAt: access.tokenExpiresAt ?? null,
        suggestedRefreshAt: access.suggestedRefreshAt ?? null,
        relaycastApiKey: entry.relaycastApiKey,
        relayfileUrl: stripTrailingSlash(access.relayfileUrl ?? this.relayfileBaseUrl),
        relayauthUrl: stripTrailingSlash(access.relayauthUrl ?? this.relayauthBaseUrl),
        wsUrl:
          access.wsUrl ??
          toRelayfileWebSocketUrl(this.relayfileBaseUrl, entry.relayfileWorkspaceId),
        scopes: access.scopes ?? normalizeScopes(options?.requestedScopes ?? this.joinScopes),
      };
    }

    return {
      entry,
      token: await mintWorkspaceToken({
        workspaceId: entry.relayfileWorkspaceId,
        agentName,
        relayAuthUrl: this.relayauthBaseUrl,
        relayAuthApiKey: this.relayauthApiKey,
        scopes: options?.requestedScopes ?? this.joinScopes,
        ttlSeconds: this.tokenTtlSeconds,
      }),
      tokenIssuedAt: null,
      tokenExpiresAt: null,
      suggestedRefreshAt: null,
      relaycastApiKey: entry.relaycastApiKey,
      relayfileUrl: this.relayfileBaseUrl,
      relayauthUrl: this.relayauthBaseUrl,
      wsUrl: toRelayfileWebSocketUrl(this.relayfileBaseUrl, entry.relayfileWorkspaceId),
      scopes: normalizeScopes(options?.requestedScopes ?? this.joinScopes),
    };
  }
}

export class LocalWorkspaceRegistry implements WorkspaceRegistry {
  private readonly relaycastBaseUrl: string;
  private readonly relayfileBaseUrl: string;
  private readonly relayauthBaseUrl: string;
  private readonly relayauthApiKey: string;
  private readonly relayApiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly persistence: WorkspaceRegistryPersistence;
  private readonly now: () => Date;
  private readonly joinScopes: string[];
  private readonly tokenTtlSeconds: number;

  constructor(options: LocalWorkspaceRegistryOptions = {}) {
    const rootDir = options.rootDir ?? process.cwd();
    this.relaycastBaseUrl = normalizeOptionalString(options.relaycastBaseUrl) ?? "";
    this.relayfileBaseUrl = normalizeOptionalString(options.relayfileBaseUrl) ?? "";
    this.relayauthBaseUrl = normalizeOptionalString(options.relayauthBaseUrl) ?? DEFAULT_RELAYAUTH_URL;
    this.relayauthApiKey =
      normalizeOptionalString(options.relayauthApiKey)
      ?? normalizeOptionalString(options.jwtSecret)
      ?? "";
    this.relayApiKey = normalizeOptionalString(options.relayApiKey) ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.persistence = new JsonFileWorkspaceRegistryStore(
      options.filePath ?? path.join(rootDir, ".relay", "workspaces.json"),
    );
    this.now = options.now ?? (() => new Date());
    this.joinScopes = normalizeScopes(options.joinScopes);
    this.tokenTtlSeconds = options.tokenTtlSeconds ?? 7_200;
  }

  async create(opts: {
    name?: string;
    createdBy: string;
    permissions?: Partial<WorkspacePermissions>;
  }): Promise<WorkspaceEntry> {
    const id = generateWorkspaceId();
    const resolvedName = opts.name?.trim() || id;
    const entry: WorkspaceEntry = {
      id,
      name: resolvedName,
      relaycastApiKey: await this.createRelaycastWorkspace(resolvedName),
      relayfileWorkspaceId: id,
      relayauthWorkspaceId: id,
      createdAt: this.now().toISOString(),
      createdBy: opts.createdBy,
      permissions: normalizeWorkspacePermissions(opts.permissions),
    };

    return this.persistence.create(entry);
  }

  async get(id: string): Promise<WorkspaceEntry | null> {
    if (!isValidWorkspaceId(id)) {
      return null;
    }

    return this.persistence.get(id);
  }

  async join(
    id: string,
    agentName: string,
    options?: {
      permissions?: Partial<WorkspacePermissions>;
      requestedScopes?: string[];
    },
  ): Promise<WorkspaceJoinResult> {
    const entry = await this.get(id);
    if (!entry) {
      throw new Error(`Workspace not found: ${id}`);
    }

    // TODO: Local mode does not enforce workspace permissions (ignored/readonly lists).
    // CloudWorkspaceRegistry delegates to joinAccessFactory for enforcement; local has
    // no equivalent mechanism yet. Permissions are computed here so they are available
    // once local enforcement is implemented.
    const _permissions = mergeWorkspacePermissions(entry.permissions, options?.permissions);

    return {
      entry,
      token: await mintWorkspaceToken({
        workspaceId: entry.relayfileWorkspaceId,
        agentName,
        relayAuthUrl: this.relayauthBaseUrl,
        relayAuthApiKey: this.relayauthApiKey,
        scopes: options?.requestedScopes ?? this.joinScopes,
        ttlSeconds: this.tokenTtlSeconds,
      }),
      relaycastApiKey: entry.relaycastApiKey,
      relayfileUrl: this.relayfileBaseUrl,
      relayauthUrl: this.relayauthBaseUrl,
      wsUrl: toRelayfileWebSocketUrl(this.relayfileBaseUrl, entry.relayfileWorkspaceId),
      scopes: normalizeScopes(options?.requestedScopes ?? this.joinScopes),
    };
  }

  private async createRelaycastWorkspace(name: string): Promise<string> {
    if (!this.relaycastBaseUrl || !this.relayApiKey) {
      return "";
    }

    const response = await this.fetchImpl(buildUrl(this.relaycastBaseUrl, "/v1/workspaces"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.relayApiKey}`,
        "Content-Type": "application/json",
        "X-API-Key": this.relayApiKey,
      },
      body: JSON.stringify({ name }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Relaycast workspace creation failed (${response.status} ${response.statusText})${body ? `: ${body.slice(0, 500)}` : ""}`,
      );
    }

    return extractRelaycastApiKey(await response.json());
  }
}
