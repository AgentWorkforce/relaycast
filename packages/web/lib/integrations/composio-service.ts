import { BackendNotConfiguredError, resolveProviderBackendConfig } from "./backend-config";

const DEFAULT_COMPOSIO_BASE_URL = "https://backend.composio.dev/api/v3";

export type ComposioConnectedAccount = Record<string, unknown>;

export type ComposioAuthConfig = {
  id?: string;
  toolkit?: {
    slug?: string;
    name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type ComposioToolkit = {
  slug?: string;
  name?: string;
  [key: string]: unknown;
};

export type ComposioConnectionRequest = {
  link_token?: string;
  redirect_url?: string;
  expires_at?: string;
  connected_account_id?: string;
  [key: string]: unknown;
};

type ComposioListResponse<T> = {
  items?: T[];
  data?: T[];
  [key: string]: unknown;
};

export class ComposioRequestError extends Error {
  constructor(
    public readonly action: string,
    public readonly status: number,
    message: string,
    public readonly payload: unknown,
  ) {
    super(message);
    this.name = "ComposioRequestError";
  }
}

const COMPOSIO_TOOLKIT_SLUG_ALIASES: Record<string, string> = {
  dockerhub: "docker_hub",
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function getComposioClientConfig(): { baseUrl: string; apiKey: string } | null {
  try {
    const config = resolveProviderBackendConfig("composio");
    return {
      baseUrl: trimTrailingSlash(config.baseUrl ?? DEFAULT_COMPOSIO_BASE_URL),
      apiKey: config.apiKey,
    };
  } catch (error) {
    if (error instanceof BackendNotConfiguredError) {
      return null;
    }

    throw error;
  }
}

export function getComposioBaseUrl(): string {
  return getComposioClientConfig()?.baseUrl ?? trimTrailingSlash(DEFAULT_COMPOSIO_BASE_URL);
}

export function getComposioApiKey(): string | null {
  return getComposioClientConfig()?.apiKey ?? null;
}

function headers(apiKey: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
}

async function readJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function listItems<T>(payload: unknown): T[] {
  const list = payload as ComposioListResponse<T> | null;
  if (Array.isArray(list?.items)) {
    return list.items;
  }
  if (Array.isArray(list?.data)) {
    return list.data;
  }
  return [];
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readToolkit(payload: unknown): ComposioToolkit | null {
  const record = readRecord(payload);
  if (!record) {
    return null;
  }
  if (typeof record.slug === "string" || typeof record.name === "string") {
    return record;
  }
  const data = readRecord(record.data);
  if (data && (typeof data.slug === "string" || typeof data.name === "string")) {
    return data;
  }
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function composioRequestError(action: string, response: Response, payload: unknown): Error {
  const record = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : null;
  const error = record?.error && typeof record.error === "object"
    ? record.error as Record<string, unknown>
    : null;
  const message =
    readString(error?.message) ??
    (Array.isArray(error?.errors) ? error.errors.filter((entry): entry is string => typeof entry === "string").join("; ") : null) ??
    (typeof payload === "string" ? payload : null);
  return new ComposioRequestError(
    action,
    response.status,
    `Composio ${action} failed with ${response.status}${message ? `: ${message}` : ""}`,
    payload,
  );
}

export function isComposioManagedAuthUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("default auth config not found") ||
    message.includes("does not have managed credentials") ||
    message.includes("no composio managed auth")
  );
}

export async function listComposioAuthConfigs(
  toolkitSlug: string,
): Promise<ComposioAuthConfig[]> {
  const clientConfig = getComposioClientConfig();
  if (!clientConfig) {
    throw new BackendNotConfiguredError("composio");
  }

  const url = new URL("auth_configs", `${clientConfig.baseUrl}/`);
  url.searchParams.set("toolkit_slug", toolkitSlug);

  const response = await globalThis.fetch(url, {
    headers: headers(clientConfig.apiKey),
    cache: "no-store",
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw composioRequestError("auth config lookup", response, payload);
  }

  return listItems<ComposioAuthConfig>(payload);
}

export async function createComposioAuthConfig(
  toolkitSlug: string,
): Promise<ComposioAuthConfig> {
  const clientConfig = getComposioClientConfig();
  if (!clientConfig) {
    throw new BackendNotConfiguredError("composio");
  }

  const response = await globalThis.fetch(
    new URL("auth_configs", `${clientConfig.baseUrl}/`),
    {
      method: "POST",
      headers: headers(clientConfig.apiKey),
      body: JSON.stringify({
        toolkit: {
          slug: toolkitSlug,
        },
      }),
      cache: "no-store",
    },
  );
  const payload = await readJson(response);
  if (!response.ok) {
    throw composioRequestError("auth config creation", response, payload);
  }

  return (payload ?? {}) as ComposioAuthConfig;
}

export async function listComposioToolkits(input: {
  search?: string;
  limit?: number;
} = {}): Promise<ComposioToolkit[]> {
  const clientConfig = getComposioClientConfig();
  if (!clientConfig) {
    throw new BackendNotConfiguredError("composio");
  }

  const url = new URL("toolkits", `${clientConfig.baseUrl}/`);
  if (input.search?.trim()) {
    url.searchParams.set("search", input.search.trim());
  }
  url.searchParams.set("limit", String(input.limit ?? 25));

  const response = await globalThis.fetch(url, {
    headers: headers(clientConfig.apiKey),
    cache: "no-store",
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw composioRequestError("toolkit lookup", response, payload);
  }

  return listItems<ComposioToolkit>(payload);
}

export async function getComposioToolkit(
  slug: string,
): Promise<ComposioToolkit | null> {
  const clientConfig = getComposioClientConfig();
  if (!clientConfig) {
    throw new BackendNotConfiguredError("composio");
  }

  const trimmedSlug = slug.trim();
  if (!trimmedSlug) {
    return null;
  }

  const response = await globalThis.fetch(
    new URL(
      `toolkits/${encodeURIComponent(trimmedSlug)}`,
      `${clientConfig.baseUrl}/`,
    ),
    {
      headers: headers(clientConfig.apiKey),
      cache: "no-store",
    },
  );
  const payload = await readJson(response);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw composioRequestError("toolkit lookup", response, payload);
  }

  return readToolkit(payload);
}

function normalizeLookupKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function slugifyToolkitCandidate(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function toolkitSlugCandidates(value: string): string[] {
  const compact = normalizeLookupKey(value);
  const slugified = slugifyToolkitCandidate(value);
  return uniqueStrings([
    COMPOSIO_TOOLKIT_SLUG_ALIASES[compact] ?? "",
    slugified,
    value.trim().toLowerCase(),
  ]);
}

function toolkitSearchQueries(value: string): string[] {
  return uniqueStrings([
    value.trim(),
    ...toolkitSlugCandidates(value),
  ]);
}

export async function resolveComposioToolkit(
  value: string,
): Promise<ComposioToolkit | null> {
  const requested = value.trim();
  if (!requested) {
    return null;
  }

  const normalized = normalizeLookupKey(requested);
  for (const slug of toolkitSlugCandidates(requested)) {
    const toolkit = await getComposioToolkit(slug);
    if (toolkit?.slug?.trim()) {
      return toolkit;
    }
  }

  for (const query of toolkitSearchQueries(requested)) {
    const toolkits = await listComposioToolkits({
      search: query,
      limit: 25,
    });

    const match = toolkits.find((toolkit) => {
      const slug = typeof toolkit.slug === "string" ? toolkit.slug : "";
      const name = typeof toolkit.name === "string" ? toolkit.name : "";
      return normalizeLookupKey(slug) === normalized || normalizeLookupKey(name) === normalized;
    });
    if (match) {
      return match;
    }
  }

  return null;
}

export async function createComposioConnectionLink(input: {
  userId: string;
  authConfigId: string;
  callbackUrl?: string | null;
  connectionData?: Record<string, unknown>;
}): Promise<ComposioConnectionRequest> {
  const clientConfig = getComposioClientConfig();
  if (!clientConfig) {
    throw new BackendNotConfiguredError("composio");
  }

  const response = await globalThis.fetch(
    new URL("connected_accounts/link", `${clientConfig.baseUrl}/`),
    {
      method: "POST",
      headers: headers(clientConfig.apiKey),
      body: JSON.stringify({
        auth_config_id: input.authConfigId,
        user_id: input.userId,
        ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
        ...(input.connectionData ? { connection_data: input.connectionData } : {}),
      }),
      cache: "no-store",
    },
  );
  const payload = await readJson(response);
  if (!response.ok) {
    throw composioRequestError("connection link creation", response, payload);
  }

  return (payload ?? {}) as ComposioConnectionRequest;
}

export async function getComposioConnectedAccount(
  connectedAccountId: string,
): Promise<ComposioConnectedAccount | null> {
  const clientConfig = getComposioClientConfig();
  if (!clientConfig) {
    throw new BackendNotConfiguredError("composio");
  }

  const response = await globalThis.fetch(
    new URL(
      `connected_accounts/${encodeURIComponent(connectedAccountId)}`,
      `${clientConfig.baseUrl}/`,
    ),
    {
      headers: headers(clientConfig.apiKey),
      cache: "no-store",
    },
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Composio connected account lookup failed with ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  return (await response.json().catch(() => null)) as ComposioConnectedAccount | null;
}

export async function deleteComposioConnectedAccount(
  connectedAccountId: string,
): Promise<boolean> {
  const clientConfig = getComposioClientConfig();
  if (!clientConfig) {
    throw new BackendNotConfiguredError("composio");
  }

  const response = await globalThis.fetch(
    new URL(
      `connected_accounts/${encodeURIComponent(connectedAccountId)}`,
      `${clientConfig.baseUrl}/`,
    ),
    {
      method: "DELETE",
      headers: headers(clientConfig.apiKey),
      cache: "no-store",
    },
  );

  return response.ok || response.status === 404;
}
