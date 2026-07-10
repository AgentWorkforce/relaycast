import type { RelayAuthTokenClaims } from "@relayauth/types";

type AuthSuccess = {
  ok: true;
  claims: RelayAuthTokenClaims;
};

type AuthFailure = {
  ok: false;
  error: string;
  code: string;
  status: 401 | 403;
};

type JwtHeader = {
  alg?: string;
};

// TODO: replace this local copy once a public npm package export exists for these auth helpers.
export async function authenticate(
  authorization: string | undefined,
  signingKey: string,
): Promise<AuthSuccess | AuthFailure> {
  if (!authorization) {
    return {
      ok: false,
      error: "Missing Authorization header",
      code: "missing_authorization",
      status: 401,
    };
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    return {
      ok: false,
      error: "Invalid Authorization header",
      code: "invalid_authorization",
      status: 401,
    };
  }

  const claims = await verifyToken(token, signingKey);
  if (!claims) {
    return {
      ok: false,
      error: "Invalid access token",
      code: "invalid_token",
      status: 401,
    };
  }

  return { ok: true, claims };
}

export async function authenticateAndAuthorize(
  authorization: string | undefined,
  signingKey: string,
  requiredScope: string,
  matchScopeFn: (required: string, granted: string[]) => boolean,
): Promise<AuthSuccess | AuthFailure> {
  const auth = await authenticate(authorization, signingKey);
  if (!auth.ok) {
    return auth;
  }

  try {
    if (!matchScopeFn(requiredScope, auth.claims.scopes)) {
      return {
        ok: false,
        error: "insufficient_scope",
        code: "insufficient_scope",
        status: 403,
      };
    }
  } catch {
    return {
      ok: false,
      error: "insufficient_scope",
      code: "insufficient_scope",
      status: 403,
    };
  }

  return auth;
}

export function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    return JSON.parse(decodeBase64Url(value)) as T;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  return atob(padded);
}

function decodeBase64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = decodeBase64Url(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

async function verifyHs256Signature(
  value: string,
  signature: string,
  signingKey: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    return crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64UrlToBytes(signature),
      new TextEncoder().encode(value),
    );
  } catch {
    return false;
  }
}

async function verifyToken(
  token: string,
  signingKey: string,
): Promise<RelayAuthTokenClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
  const payload = decodeBase64UrlJson<Partial<RelayAuthTokenClaims>>(encodedPayload);

  if (!header || !payload || header.alg !== "HS256") {
    return null;
  }

  const isValidSignature = await verifyHs256Signature(
    `${encodedHeader}.${encodedPayload}`,
    signature,
    signingKey,
  );
  if (!isValidSignature) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    return null;
  }

  if (
    typeof payload.sub !== "string" ||
    typeof payload.org !== "string" ||
    typeof payload.wks !== "string" ||
    typeof payload.sponsorId !== "string" ||
    !Array.isArray(payload.sponsorChain) ||
    !payload.sponsorChain.every((sponsor) => typeof sponsor === "string") ||
    !Array.isArray(payload.scopes) ||
    !payload.scopes.every((scope) => typeof scope === "string")
  ) {
    return null;
  }

  return payload as RelayAuthTokenClaims;
}
