import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Response as UndiciResponse } from "undici";
import { expect } from "vitest";

import { acceptanceEnv } from "../../helpers/env";
import { request } from "../../helpers/server";
import { signedRequest, type AuthMode, type SignedRequestInit } from "../../helpers/auth";

export const errorSchema = z.object({
  error: z.string(),
}).passthrough();

export const jsonObjectSchema = z.record(z.string(), z.unknown());

export type WorkspaceHandle = {
  workspaceId: string;
  created: boolean;
  auth: AuthMode;
};

export function hasAcceptanceAuth(): boolean {
  const env = acceptanceEnv();
  return Boolean(env.cliToken || env.sessionCookie);
}

export function preferredAuthMode(): AuthMode {
  return acceptanceEnv().sessionCookie ? "session" : acceptanceEnv().cliToken ? "cli" : false;
}

export async function requestWithoutAuth(
  method: string,
  route: string,
  init: SignedRequestInit = {},
): Promise<UndiciResponse> {
  return request(method, route, init);
}

export async function requestWithAuth(
  method: string,
  route: string,
  init: SignedRequestInit = {},
): Promise<UndiciResponse> {
  const auth = preferredAuthMode();
  if (!auth) {
    throw new Error("Acceptance auth is not configured");
  }
  return signedRequest(method, route, {
    ...init,
    auth,
  });
}

export async function createWorkspace(options: {
  authenticated?: boolean;
  namePrefix?: string;
} = {}): Promise<WorkspaceHandle> {
  const route = "/api/v1/workspaces/create";
  const name = `${options.namePrefix ?? "acceptance-workspace"}-${randomUUID().slice(0, 8)}`;
  const authenticated = options.authenticated ?? hasAcceptanceAuth();
  const response = authenticated
    ? await requestWithAuth("POST", route, { json: { name } })
    : await requestWithoutAuth("POST", route, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });

  expect([201]).toContain(response.status);
  const body = workspaceCreateSchema.parse(await response.json());

  return {
    workspaceId: body.workspaceId,
    created: true,
    auth: authenticated ? preferredAuthMode() : false,
  };
}

export async function destroyWorkspace(workspace: WorkspaceHandle | null): Promise<void> {
  if (!workspace?.created) {
    return;
  }

  if (!workspace.auth) {
    return;
  }

  const response = await requestWithAuth(
    "DELETE",
    `/api/v1/workspaces/${encodeURIComponent(workspace.workspaceId)}`,
  );
  expect([200, 202, 204, 404, 405]).toContain(response.status);
}

export async function expectJson<T>(
  response: UndiciResponse,
  schema: z.ZodSchema<T>,
): Promise<T> {
  expect(response.headers.get("content-type") ?? "").toContain("application/json");
  return schema.parse(await response.json());
}

export async function expectHtml(response: UndiciResponse): Promise<string> {
  expect(response.headers.get("content-type") ?? "").toContain("text/html");
  return response.text();
}

export function expectHeaderShape(response: UndiciResponse): void {
  const requestId = response.headers.get("x-request-id");
  if (requestId !== null) {
    expect(requestId.trim().length).toBeGreaterThan(0);
  }

  const cacheControl = response.headers.get("cache-control");
  if (cacheControl !== null) {
    expect(cacheControl.trim().length).toBeGreaterThan(0);
  }

  const setCookie = response.headers.get("set-cookie");
  if (setCookie !== null) {
    expect(setCookie).toMatch(/^[^=;]+=/);
  }
}

export const workspaceCreateSchema = z.object({
  workspaceId: z.string().min(1),
  relaycastApiKey: z.string().min(1),
  relayfileUrl: z.string().url(),
  relayauthUrl: z.string().url(),
  joinCommand: z.string().min(1),
  createdAt: z.string().min(1),
  name: z.string().min(1).optional(),
}).passthrough();

export const workspaceListSchema = z.object({
  workspaces: z.array(z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    name: z.string().min(1),
  }).passthrough()),
}).passthrough();

export const genericOkSchema = z.object({
  ok: z.boolean().optional(),
}).passthrough();
