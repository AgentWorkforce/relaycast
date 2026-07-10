import "server-only";
import type { Nango } from "@nangohq/node";
import * as nangoService from "@/lib/integrations/nango-service";
import type { SlackConnectionIdentity } from "@/lib/integrations/slack-identity";

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  numMembers?: number;
  topic: string;
  purpose: string;
}

type ProxyMethod = "GET" | "POST";

type ProxyRequestConfig = {
  method: ProxyMethod;
  endpoint: string;
  providerConfigKey: string;
  connectionId: string;
  params?: Record<string, string>;
  data?: unknown;
};

type SlackListChannelsResponse = {
  ok: boolean;
  error?: string;
  channels?: Array<{
    id: string;
    name: string;
    is_private?: boolean;
    is_member?: boolean;
    num_members?: number;
    topic?: { value?: string | null };
    purpose?: { value?: string | null };
  }>;
  response_metadata?: {
    next_cursor?: string;
  };
};

type SlackJoinChannelResponse = {
  ok: boolean;
  error?: string;
  channel?: {
    id: string;
    name: string;
  };
};

type SlackAuthTestResponse = {
  ok: boolean;
  error?: string;
  team?: string;
  team_id?: string | null;
  enterprise_id?: string | null;
  user_id?: string | null;
  url?: string | null;
};

type NangoServiceWithClient = typeof nangoService & {
  getNangoClient?: () => Nango;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getNangoClientOrNull(): Nango | null {
  // `nango-service.ts` owns the singleton. If that accessor is exported later,
  // this helper will pick it up without needing a second client here.
  const getClient = (nangoService as NangoServiceWithClient).getNangoClient;
  return typeof getClient === "function" ? getClient() : null;
}

function getProxyUrl(
  endpoint: string,
  params?: Record<string, string>,
): string {
  const url = new URL(
    `/proxy${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`,
    `${nangoService.getNangoHost()}/`,
  );

  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

async function parseProxyResponse<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

function getErrorPayload(error: unknown): Record<string, unknown> | null {
  if (!isRecord(error)) {
    return null;
  }

  const response = error.response;
  if (!isRecord(response)) {
    return null;
  }

  const data = response.data;
  return isRecord(data) ? data : null;
}

function getProxyErrorMessage(
  payload: Record<string, unknown> | null,
  fallback: string,
): string {
  const error = payload?.error;
  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  const message = payload?.message;
  if (typeof message === "string" && message.length > 0) {
    return message;
  }

  return fallback;
}

function toProxyError(error: unknown, endpoint: string): Error {
  const fallback =
    error instanceof Error && error.message.length > 0
      ? error.message
      : "unknown error";
  const errorMessage = getProxyErrorMessage(getErrorPayload(error), fallback);
  return new Error(`Nango proxy ${endpoint} failed: ${errorMessage}`);
}

export async function proxyRequest<T>({
  method,
  endpoint,
  providerConfigKey,
  connectionId,
  params,
  data,
}: ProxyRequestConfig): Promise<T> {
  const client = getNangoClientOrNull();
  if (client) {
    try {
      const response = await client.proxy({
        method,
        endpoint,
        providerConfigKey,
        connectionId,
        ...(params ? { params } : {}),
        ...(data === undefined ? {} : { data }),
      });
      const payload = response.data as T | null;
      if (!payload) {
        throw new Error(`Nango proxy ${endpoint} returned an empty response.`);
      }

      return payload;
    } catch (error) {
      throw toProxyError(error, endpoint);
    }
  }

  const secretKey = nangoService.getNangoSecretKey();
  if (!secretKey) {
    throw new Error("NANGO_SECRET_KEY is not configured.");
  }

  const headers = new Headers({
    Authorization: `Bearer ${secretKey}`,
    Accept: "application/json",
    "Connection-Id": connectionId,
    "Provider-Config-Key": providerConfigKey,
  });

  let body: string | undefined;
  if (data !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(data);
  }

  const response = await fetch(getProxyUrl(endpoint, params), {
    method,
    headers,
    ...(body ? { body } : {}),
    cache: "no-store",
  });

  const payload = await parseProxyResponse<T & Record<string, unknown>>(response);
  if (!response.ok) {
    throw toProxyError(
      {
        message: `${response.status} ${response.statusText}`.trim(),
        response: {
          data: payload,
        },
      },
      endpoint,
    );
  }

  if (!payload) {
    throw new Error(`Nango proxy ${endpoint} returned an empty response.`);
  }

  return payload as T;
}

export async function listChannels(
  connectionId: string,
  providerConfigKey: string,
  opts?: {
    types?: string;
    limit?: number;
    cursor?: string;
    excludeArchived?: boolean;
  },
): Promise<{ channels: SlackChannel[]; nextCursor?: string }> {
  const params: Record<string, string> = {
    types: opts?.types ?? "public_channel,private_channel",
    limit: String(opts?.limit ?? 200),
    exclude_archived: String(opts?.excludeArchived ?? true),
  };

  if (opts?.cursor) {
    params.cursor = opts.cursor;
  }

  const data = await proxyRequest<SlackListChannelsResponse>({
    method: "GET",
    endpoint: "/conversations.list",
    providerConfigKey,
    connectionId,
    params,
  });

  if (!data.ok) {
    throw new Error(
      `Slack conversations.list failed: ${data.error ?? "unknown"}`,
    );
  }

  return {
    channels: (data.channels ?? []).map((channel) => ({
      id: channel.id,
      name: channel.name,
      isPrivate: channel.is_private ?? false,
      isMember: channel.is_member ?? false,
      numMembers: channel.num_members,
      topic: channel.topic?.value ?? "",
      purpose: channel.purpose?.value ?? "",
    })),
    nextCursor: data.response_metadata?.next_cursor || undefined,
  };
}

export async function joinChannel(
  connectionId: string,
  providerConfigKey: string,
  channelId: string,
): Promise<{ ok: boolean; channel?: { id: string; name: string }; error?: string }> {
  return proxyRequest<SlackJoinChannelResponse>({
    method: "POST",
    endpoint: "/conversations.join",
    providerConfigKey,
    connectionId,
    data: {
      channel: channelId,
    },
  });
}

export async function getSlackConnectionIdentity(
  connectionId: string,
  providerConfigKey: string,
): Promise<SlackConnectionIdentity> {
  const data = await proxyRequest<SlackAuthTestResponse>({
    method: "GET",
    endpoint: "/auth.test",
    providerConfigKey,
    connectionId,
  });

  if (!data.ok) {
    throw new Error(`Slack auth.test failed: ${data.error ?? "unknown"}`);
  }

  return {
    teamId: data.team_id?.trim() || null,
    enterpriseId: data.enterprise_id?.trim() || null,
    botUserId: data.user_id?.trim() || null,
    workspaceName: data.team?.trim() || null,
    workspaceUrl: data.url?.trim() || null,
  };
}
