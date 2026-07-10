import { createHmac } from "node:crypto";
import type { Response as UndiciResponse } from "undici";
import { z } from "zod";
import {
  env,
  envJson,
  hasSageAuth,
  hasSpecialistAuth,
  readJson,
} from "../helpers/runtime";
import { loadFixtureText } from "../helpers/fixtures";

export const errorSchema = z.object({
  error: z.string().min(1),
}).passthrough();

export const jsonValueSchema = z.union([
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
  z.null(),
]);

export function expectJsonContent(response: UndiciResponse): void {
  expect(response.headers.get("content-type") ?? "").toContain("application/json");
}

export async function parseJson<T>(
  response: UndiciResponse,
  schema: z.ZodType<T>,
): Promise<T> {
  expectJsonContent(response);
  return schema.parse(await readJson(response));
}

export function webhookFixture(name: string): string {
  return loadFixtureText(`webhooks/${name}`);
}

export function webhookSecret(): string | undefined {
  return env("ACCEPTANCE_WEBHOOK_SECRET");
}

export function hasWebhookSecret(): boolean {
  return Boolean(webhookSecret());
}

export function hmacHex(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function hmacBase64(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

export function hasGithubCloneAuth(): boolean {
  return hasSageAuth() || hasSpecialistAuth();
}

export function githubCloneAuthMode(): "sage" | "specialist" {
  return hasSageAuth() ? "sage" : "specialist";
}

export function envBody(name: string): Record<string, unknown> | undefined {
  const value = envJson<unknown>(name);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
