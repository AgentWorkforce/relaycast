import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { apiKeys } from "../db/schema.js";
import { hashKey } from "../middleware/auth.js";
import type { Env } from "../types.js";
import type { WsMessage } from "../schemas.js";

const wsRouter = new Hono<{ Bindings: Env }>();

wsRouter.get("/", async (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (upgradeHeader !== "websocket") {
    return c.json(
      {
        ok: false,
        error: {
          code: "bad_request",
          message: "Expected WebSocket upgrade",
        },
      },
      426
    );
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  server.accept();

  let authenticated = false;
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      server.send(
        JSON.stringify({
          type: "error",
          code: "auth_timeout",
          message: "Authentication timeout",
        })
      );
      server.close(4001, "Authentication timeout");
    }
  }, 10000);

  server.addEventListener("message", async (event) => {
    try {
      const msg = JSON.parse(
        typeof event.data === "string" ? event.data : ""
      ) as WsMessage;

      if (!authenticated) {
        if (msg.type === "auth" && "api_key" in msg) {
          const keyHash = await hashKey(msg.api_key);
          const db = c.get("db");
          const [key] = await db
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.key_hash, keyHash))
            .limit(1);

          if (!key) {
            server.send(
              JSON.stringify({
                type: "error",
                code: "unauthorized",
                message: "Invalid API key",
              })
            );
            server.close(4003, "Unauthorized");
            return;
          }

          authenticated = true;
          clearTimeout(authTimeout);

          server.send(
            JSON.stringify({ type: "auth_ok", agent_id: key.id })
          );
        }
        return;
      }

      if (msg.type === "ping") {
        server.send(JSON.stringify({ type: "pong" }));
      }
    } catch {
      server.send(
        JSON.stringify({
          type: "error",
          code: "parse_error",
          message: "Invalid message format",
        })
      );
    }
  });

  server.addEventListener("close", () => {
    clearTimeout(authTimeout);
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
});

export default wsRouter;
