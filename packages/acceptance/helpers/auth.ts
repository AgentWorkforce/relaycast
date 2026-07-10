import { randomUUID } from "node:crypto";
import { Headers } from "undici";
import type { RequestInit as UndiciRequestInit, Response as UndiciResponse } from "undici";

import { acceptanceEnv, readRequiredEnv } from "./env";
import { request } from "./server";

export const testCtx = {
  get workspaceId() {
    return readRequiredEnv("ACCEPTANCE_WORKSPACE_ID");
  },
  get userId() {
    return readRequiredEnv("ACCEPTANCE_USER_ID");
  },
} satisfies { workspaceId: string; userId: string };

export type AuthMode = "cli" | "session" | false;

export interface SignedRequestInit extends UndiciRequestInit {
  auth?: AuthMode;
  json?: unknown;
}

export interface ProvisionedWorkspace {
  id: string;
  name?: string;
  slug?: string;
  created: boolean;
}

export interface CliLoginTokenSet {
  callbackUrl: URL;
  state: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  apiUrl: string;
}

function loadSessionCookie(): string {
  return readRequiredEnv("ACCEPTANCE_SESSION_COOKIE");
}

export function loadCliToken(): string {
  return readRequiredEnv("ACCEPTANCE_CLI_TOKEN");
}

export function cliAuthHeader(): Record<string, string> {
  return { authorization: `Bearer ${loadCliToken()}` };
}

export function sessionAuthHeader(): Record<string, string> {
  return { cookie: loadSessionCookie() };
}

export function unauthHeader(): Record<string, string> {
  return {};
}

export function forgedTokenHeader(): Record<string, string> {
  return {
    authorization: `Bearer ${readRequiredEnv("ACCEPTANCE_BEARER_NO_CLI_AUTH_TOKEN")}`,
  };
}

export function authHeaders(mode: Exclude<AuthMode, false> = "cli"): Record<string, string> {
  if (mode === "cli") {
    return cliAuthHeader();
  }

  return sessionAuthHeader();
}

type ResponseWithSetCookie = {
  headers: {
    getSetCookie?: () => string[];
  };
};

export function getSetCookieHeaders(response: ResponseWithSetCookie): string[] {
  return response.headers.getSetCookie?.() ?? [];
}

export function findSetCookie(
  response: ResponseWithSetCookie,
  cookieName: string,
): string | undefined {
  return getSetCookieHeaders(response).find((cookie) => cookie.startsWith(`${cookieName}=`));
}

export function cookieJar() {
  const jar = new Map<string, string>();

  return {
    get(name: string): string | undefined {
      return jar.get(name);
    },
    setFromResponse(res: UndiciResponse): void {
      const cookies = res.headers.getSetCookie?.() ?? [];

      for (const cookie of cookies) {
        const [pair] = cookie.split(";", 1);
        const eqIndex = pair.indexOf("=");
        if (eqIndex <= 0) continue;
        jar.set(pair.slice(0, eqIndex), pair.slice(eqIndex + 1));
      }
    },
    toHeader(): string {
      return Array.from(jar.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    },
  };
}

export async function signedRequest(
  method: string,
  route: string,
  init: SignedRequestInit = {},
): Promise<UndiciResponse> {
  const headers = new Headers(init.headers);
  const authMode = init.auth ?? "cli";

  if (authMode) {
    for (const [name, value] of Object.entries(authHeaders(authMode))) {
      if (!headers.has(name)) {
        headers.set(name, value);
      }
    }
  }

  let body = init.body;
  if (init.json !== undefined) {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    body = JSON.stringify(init.json);
  }

  return request(method, route, {
    ...init,
    body,
    headers,
  });
}

export async function provisionTestWorkspace(
  name = `acceptance-${randomUUID().slice(0, 8)}`,
): Promise<ProvisionedWorkspace> {
  const env = acceptanceEnv();
  if (env.workspaceId) {
    return {
      id: env.workspaceId,
      name,
      created: false,
    };
  }

  const authMode: AuthMode = env.sessionCookie ? "session" : env.cliToken ? "cli" : false;
  const response = await signedRequest("POST", "/api/v1/workspaces", {
    auth: authMode,
    json: { name },
  });

  if (response.status !== 201) {
    const body = await response.text();
    throw new Error(`Failed to provision acceptance workspace (${response.status}): ${body}`);
  }

  const payload = await response.json() as Record<string, unknown>;
  if (typeof payload.id !== "string") {
    throw new Error("Workspace create response did not include an id");
  }

  return {
    id: payload.id,
    name: typeof payload.name === "string" ? payload.name : name,
    slug: typeof payload.slug === "string" ? payload.slug : undefined,
    created: true,
  };
}

export async function teardownTestWorkspace(_workspace: ProvisionedWorkspace | string): Promise<void> {
  // No delete endpoint exists for acceptance-created workspaces yet.
}

function readRequiredSearchParam(url: URL, key: string): string {
  const value = url.searchParams.get(key)?.trim();
  if (!value) {
    throw new Error(`CLI login redirect did not include ${key}`);
  }
  return value;
}

export async function issueCliLoginTokenSet(
  redirectUri = "http://127.0.0.1:44123/callback",
  state = `acceptance-${randomUUID().slice(0, 8)}`,
): Promise<CliLoginTokenSet> {
  const response = await signedRequest(
    "GET",
    `/api/v1/cli/login?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`,
    {
      auth: "session",
      redirect: "manual",
    },
  );

  if (response.status !== 307) {
    const body = await response.text();
    throw new Error(`CLI login bootstrap failed (${response.status}): ${body}`);
  }

  const location = response.headers.get("location");
  if (!location) {
    throw new Error("CLI login redirect did not include a location header");
  }

  const callbackUrl = new URL(location);

  return {
    callbackUrl,
    state: readRequiredSearchParam(callbackUrl, "state"),
    accessToken: readRequiredSearchParam(callbackUrl, "access_token"),
    accessTokenExpiresAt: readRequiredSearchParam(callbackUrl, "access_token_expires_at"),
    refreshToken: readRequiredSearchParam(callbackUrl, "refresh_token"),
    refreshTokenExpiresAt: readRequiredSearchParam(callbackUrl, "refresh_token_expires_at"),
    apiUrl: readRequiredSearchParam(callbackUrl, "api_url"),
  };
}
