import type { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  createSessionClaims,
  decodeSessionToken,
  encodeSessionToken,
  type SessionClaims,
} from "@cloud/core/session/jwt.js";

export {
  SESSION_COOKIE_NAME,
  createSessionClaims,
  decodeSessionToken,
  encodeSessionToken,
};

export function readSessionFromRequest(
  request: Pick<NextRequest, "cookies">,
  secret: string,
): SessionClaims | null {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }
  return decodeSessionToken(token, secret);
}

export function setSessionCookie(
  response: NextResponse,
  claims: SessionClaims,
  secret: string,
): void {
  const domain = sessionCookieDomain();
  response.cookies.set(SESSION_COOKIE_NAME, encodeSessionToken(claims, secret), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    ...(domain ? { domain } : {}),
  });
}

export function clearSessionCookie(response: NextResponse): void {
  const domain = sessionCookieDomain();
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(0),
    ...(domain ? { domain } : {}),
  });
}

function sessionCookieDomain(): string | undefined {
  return process.env.SESSION_COOKIE_DOMAIN?.trim() || undefined;
}
