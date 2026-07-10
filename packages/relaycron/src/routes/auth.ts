import { Hono } from "hono";
import { nanoid } from "nanoid";
import { apiKeys } from "../db/schema.js";
import { hashKey } from "../middleware/auth.js";
import type { Env } from "../types.js";

const auth = new Hono<{ Bindings: Env }>();

// Create a new API key (bootstrap endpoint - no auth required)
auth.post("/keys", async (c) => {
  const body = await c.req.json<{ name: string }>();
  if (!body.name || typeof body.name !== "string") {
    return c.json(
      {
        ok: false,
        error: { code: "bad_request", message: "name is required" },
      },
      400
    );
  }

  const id = nanoid();
  const rawKey = `ac_${nanoid(32)}`;
  const keyHash = await hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 10);

  const db = c.get("db");
  await db.insert(apiKeys).values({
    id,
    name: body.name,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    created_at: new Date().toISOString(),
  });

  return c.json(
    {
      ok: true,
      data: {
        id,
        name: body.name,
        api_key: rawKey,
        key_prefix: keyPrefix,
        created_at: new Date().toISOString(),
        _note:
          "Save this API key now. It cannot be retrieved again.",
      },
    },
    201
  );
});

export default auth;
