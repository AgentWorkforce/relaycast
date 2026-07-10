import { timingSafeEqual } from "node:crypto";
import { Resource } from "sst";
import {
  resolveRequestAuth,
  type RequestAuth,
} from "@/lib/auth/request-auth";

export type SlackProxyAuthErrorBody = {
  ok: false;
  error: string;
  code: "unauthorized";
};

export type SlackProxyAuthResult =
  | { ok: true; bearerToken: string; auth: RequestAuth }
  | { ok: false; status: 401 | 403; body: SlackProxyAuthErrorBody };

function toBuffer(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function constantTimeEqual(expectedValue: string, receivedValue: string): boolean {
  const expected = toBuffer(expectedValue);
  const received = toBuffer(receivedValue);

  if (expected.length !== received.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
}

export function readConfiguredCloudApiToken(): string | null {
  try {
    const resourceValue = Resource.SageCloudApiToken.value?.trim();
    return resourceValue || null;
  } catch {
    return null;
  }
}

export function readConfiguredSpecialistCloudApiToken(): string | null {
  try {
    const resources = Resource as typeof Resource & {
      SpecialistCloudApiToken?: { value?: string };
    };
    const resourceValue = resources.SpecialistCloudApiToken?.value?.trim();
    return resourceValue || null;
  } catch {
    return null;
  }
}

export function readBearerTokenFromRequest(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization) {
    return null;
  }

  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const bearerToken = authorization.slice(7).trim();
  return bearerToken || null;
}

function serviceAuth(bearerToken: string): RequestAuth {
  return {
    userId: "sage-service",
    workspaceId: "",
    organizationId: "",
    source: "service",
    bearerToken,
  };
}

export async function authenticateSlackProxyRequest(
  request: Request,
): Promise<SlackProxyAuthResult> {
  const bearerToken = readBearerTokenFromRequest(request);
  if (!bearerToken) {
    return {
      ok: false,
      status: 401,
      body: {
        ok: false,
        error: "Missing bearer token",
        code: "unauthorized",
      },
    };
  }

  const configuredToken = readConfiguredCloudApiToken();
  if (configuredToken && constantTimeEqual(configuredToken, bearerToken)) {
    return {
      ok: true,
      bearerToken,
      auth: serviceAuth(bearerToken),
    };
  }

  try {
    const auth = await resolveRequestAuth(
      request as Parameters<typeof resolveRequestAuth>[0],
    );
    if (auth) {
      return {
        ok: true,
        bearerToken,
        auth,
      };
    }
  } catch {
    // Fall through to the same invalid-token envelope used by the legacy
    // fixed-token proxy path. Some tests and local runs do not have a DB/JWKS
    // available for full request auth, and invalid bearer tokens should still
    // fail closed instead of surfacing infrastructure errors.
  }

  if (!configuredToken) {
    return {
      ok: false,
      status: 403,
      body: {
        ok: false,
        error: "Invalid bearer token",
        code: "unauthorized",
      },
    };
  }

  if (!constantTimeEqual(configuredToken, bearerToken)) {
    return {
      ok: false,
      status: 403,
      body: {
        ok: false,
        error: "Invalid bearer token",
        code: "unauthorized",
      },
    };
  }

  return {
    ok: false,
    status: 403,
    body: {
      ok: false,
      error: "Invalid bearer token",
      code: "unauthorized",
    },
  };
}
