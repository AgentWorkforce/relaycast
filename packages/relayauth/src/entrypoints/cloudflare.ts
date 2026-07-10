import type { CloudflareStorageBindings } from "../storage/cloudflare/index.js";
import { createCloudflareStorage } from "../storage/cloudflare/index.js";
import { createApp } from "@relayauth/server";

export { IdentityDO } from "../durable-objects/identity-do.js";

export default {
  async fetch(request: Request, env: CloudflareStorageBindings, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    const storage = createCloudflareStorage(env);
    const app = createApp({
      defaultBindings: env,
      storage,
    });

    return app.fetch(request, env, ctx);
  },
};
