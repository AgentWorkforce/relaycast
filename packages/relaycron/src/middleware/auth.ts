import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { apiKeys } from "../db/schema.js";
import type { Env } from "../types.js";

async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const requireAuth = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json(
        {
          ok: false,
          error: {
            code: "unauthorized",
            message: "Missing or invalid Authorization header",
          },
        },
        401
      );
    }

    const token = authHeader.slice(7);
    if (!token.startsWith("ac_")) {
      return c.json(
        {
          ok: false,
          error: { code: "unauthorized", message: "Invalid API key format" },
        },
        401
      );
    }

    const keyHash = await hashKey(token);
    const db = c.get("db");
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.key_hash, keyHash))
      .limit(1);

    if (!key) {
      return c.json(
        {
          ok: false,
          error: { code: "unauthorized", message: "Invalid API key" },
        },
        401
      );
    }

    // Update last_used_at (fire and forget)
    c.executionCtx.waitUntil(
      db
        .update(apiKeys)
        .set({ last_used_at: new Date().toISOString() })
        .where(eq(apiKeys.id, key.id))
    );

    c.set("auth", { apiKeyId: key.id });
    await next();
  }
);

export { hashKey };
