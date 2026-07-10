import { Headers } from "undici";
import type {
  BodyInit as UndiciBodyInit,
  HeadersInit as UndiciHeadersInit,
  RequestInit as UndiciRequestInit,
  Response as UndiciResponse,
} from "undici";
import { expect } from "vitest";
import { request } from "../../helpers/server";
import { authHeaders } from "./auth";
import { acceptanceEnv } from "./env";

export type AuthMode =
  | "none"
  | "user"
  | "worker"
  | "callback"
  | "sage"
  | "specialist";

type ApiRequestOptions = Omit<UndiciRequestInit, "body" | "headers"> & {
  auth?: AuthMode;
  headers?: UndiciHeadersInit;
  json?: unknown;
  body?: UndiciBodyInit | null;
  noRetryStatuses?: number[];
};

export function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function envFirst(...names: string[]): string | undefined {
  for (const name of names) {
    const value = env(name);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function envJson<T>(name: string): T | undefined {
  const value = env(name);
  if (!value) {
    return undefined;
  }

  return JSON.parse(value) as T;
}

export function hasUserAuth(): boolean {
  const shared = acceptanceEnv();
  return Boolean(shared.sessionCookie || shared.cliToken);
}

export function hasSessionAuth(): boolean {
  return Boolean(acceptanceEnv().sessionCookie);
}

export function hasBearerAuth(): boolean {
  return Boolean(acceptanceEnv().cliToken);
}

export function hasWorkerAuth(): boolean {
  return Boolean(env("ACCEPTANCE_WORKER_TOKEN"));
}

export function hasSageAuth(): boolean {
  return Boolean(
    envFirst("ACCEPTANCE_SAGE_CLOUD_API_TOKEN", "SAGE_CLOUD_API_TOKEN"),
  );
}

export function hasSpecialistAuth(): boolean {
  return Boolean(
    envFirst(
      "ACCEPTANCE_SPECIALIST_CLOUD_API_TOKEN",
      "SPECIALIST_CLOUD_API_TOKEN",
    ),
  );
}

export function buildHeaders(
  auth: AuthMode = "none",
  initHeaders?: UndiciHeadersInit,
): Headers {
  const headers = new Headers(initHeaders);

  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  if (auth === "user") {
    for (const [name, value] of Object.entries(authHeaders())) {
      if (!headers.has(name)) {
        headers.set(name, value);
      }
    }
  }

  if (auth === "worker") {
    const workerToken = env("ACCEPTANCE_WORKER_TOKEN");
    if (workerToken) {
      headers.set("authorization", `Bearer ${workerToken}`);
    }
  }

  if (auth === "callback") {
    const callbackToken = env("ACCEPTANCE_WORKFLOW_CALLBACK_TOKEN");
    if (callbackToken) {
      headers.set("x-callback-token", callbackToken);
    }
  }

  if (auth === "sage") {
    const sageToken = envFirst(
      "ACCEPTANCE_SAGE_CLOUD_API_TOKEN",
      "SAGE_CLOUD_API_TOKEN",
    );
    if (sageToken) {
      headers.set("authorization", `Bearer ${sageToken}`);
    }
  }

  if (auth === "specialist") {
    const specialistToken = envFirst(
      "ACCEPTANCE_SPECIALIST_CLOUD_API_TOKEN",
      "SPECIALIST_CLOUD_API_TOKEN",
    );
    if (specialistToken) {
      headers.set("authorization", `Bearer ${specialistToken}`);
    }
  }

  return headers;
}

export async function requestApi(
  route: string,
  options: ApiRequestOptions = {},
): Promise<UndiciResponse> {
  const { noRetryStatuses, ...requestOptions } = options;
  const headers = buildHeaders(options.auth, options.headers);
  let body = options.body ?? null;

  if (options.json !== undefined) {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    body = JSON.stringify(options.json);
  }

  const method = options.method ?? (body !== null ? "POST" : "GET");
  return request(
    method,
    route,
    {
      ...requestOptions,
      headers,
      body,
    },
    {
      noRetryStatuses,
    },
  );
}

export async function readJson<T>(response: UndiciResponse): Promise<T> {
  return (await response.json()) as T;
}

export function expectStatus(response: UndiciResponse, allowed: number[]): void {
  expect(
    allowed,
    `expected ${response.url} to return one of ${allowed.join(", ")}, got ${response.status}`,
  ).toContain(response.status);
}

export async function expectJsonError(
  route: string,
  options: ApiRequestOptions & { allowedStatus: number[] },
): Promise<Record<string, unknown> & { error?: string }> {
  const response = await requestApi(route, options);
  expectStatus(response, options.allowedStatus);
  expect(response.headers.get("content-type") ?? "").toContain("application/json");
  return readJson<Record<string, unknown> & { error?: string }>(response);
}

export function expectErrorLike(body: Record<string, unknown>): void {
  expect(body).toBeTruthy();
  expect(typeof body).toBe("object");
  expect(
    body.error ?? body.message ?? body.Reason ?? Object.keys(body).length,
  ).toBeTruthy();
}

export async function expectSseShape(
  route: string,
  options: { auth?: AuthMode; firstEventDeadlineMs?: number; idleWindowMs?: number } = {},
): Promise<void> {
  const response = await requestApi(route, {
    auth: options.auth ?? "user",
    headers: { accept: "text/event-stream" },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type") ?? "").toMatch(/^text\/event-stream/i);
  expect(response.body).toBeTruthy();

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawEventLine = false;
  const firstEventDeadline = Date.now() + (options.firstEventDeadlineMs ?? 10_000);

  try {
    while (Date.now() < firstEventDeadline && !sawEventLine) {
      const remaining = Math.max(1, firstEventDeadline - Date.now());
      const result = await Promise.race([
        reader.read().then((value) => ({ type: "read" as const, value })),
        sleep(remaining).then(() => ({ type: "timeout" as const })),
      ]);

      if (result.type === "timeout") {
        break;
      }

      if (result.value.done) {
        throw new Error("SSE stream closed before any event/data line arrived");
      }

      buffer += decoder.decode(result.value.value, { stream: true });
      sawEventLine = buffer
        .split(/\r?\n/)
        .some((line) => line.startsWith("event: ") || line.startsWith("data: "));
    }

    expect(sawEventLine).toBe(true);

    const idleDeadline = Date.now() + (options.idleWindowMs ?? 30_000);
    while (Date.now() < idleDeadline) {
      const remaining = Math.max(1, idleDeadline - Date.now());
      const result = await Promise.race([
        reader.read().then((value) => ({ type: "read" as const, value })),
        sleep(remaining).then(() => ({ type: "timeout" as const })),
      ]);

      if (result.type === "timeout") {
        break;
      }

      if (result.value.done) {
        throw new Error("SSE stream closed during the required idle survival window");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function liveFixturePresent(...names: string[]): boolean {
  return names.every((name) => Boolean(env(name)));
}

export function fixtureSummary(): string {
  return `baseUrl=${acceptanceEnv().baseUrl}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
