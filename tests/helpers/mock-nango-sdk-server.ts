import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type NangoMockRequest = {
  authorization: string;
  connectionId: string;
  providerConfigKey: string;
  method: string;
  endpoint: string;
  query: Record<string, string>;
  body: unknown;
};

export type NangoMockSyncTrigger = {
  authorization: string;
  connectionId: string;
  providerConfigKey: string;
  syncName: string;
  syncMode?: string;
  body: unknown;
};

export type NangoMockResponder = (
  request: NangoMockRequest,
) =>
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>
  | null
  | undefined;

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    ...(headers ?? {}),
  });
  response.end(body === undefined ? "" : JSON.stringify(body));
}

export async function startMockNangoSdkServer(input: {
  secret: string;
  respond: NangoMockResponder;
}): Promise<{
  url: string;
  capturedRequests: NangoMockRequest[];
  syncTriggers: NangoMockSyncTrigger[];
  close: () => Promise<void>;
}> {
  const capturedRequests: NangoMockRequest[] = [];
  const syncTriggers: NangoMockSyncTrigger[] = [];

  const server = createServer(async (req, res) => {
    const authorization = String(req.headers.authorization ?? "");
    if (authorization !== `Bearer ${input.secret}`) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/sync/trigger" && (req.method ?? "GET").toUpperCase() === "POST") {
      const body = await readJsonBody(req);
      const record = body && typeof body === "object" && !Array.isArray(body)
        ? body as Record<string, unknown>
        : {};
      const connectionId = typeof record.connection_id === "string" ? record.connection_id : "";
      const providerConfigKey =
        typeof record.provider_config_key === "string" ? record.provider_config_key : "";
      const syncMode = typeof record.sync_mode === "string" ? record.sync_mode : undefined;
      const syncs = Array.isArray(record.syncs) ? record.syncs : [];
      for (const sync of syncs) {
        if (typeof sync !== "string" || sync.length === 0) continue;
        syncTriggers.push({
          authorization,
          connectionId,
          providerConfigKey,
          syncName: sync,
          ...(syncMode ? { syncMode } : {}),
          body,
        });
      }
      sendJson(res, 200, { success: true });
      return;
    }

    if (!url.pathname.startsWith("/proxy/")) {
      sendJson(res, 404, { error: "not_found", pathname: url.pathname });
      return;
    }

    const endpoint = url.pathname.substring("/proxy".length);
    const method = (req.method ?? "GET").toUpperCase();
    const connectionId = String(req.headers["connection-id"] ?? "");
    const providerConfigKey = String(req.headers["provider-config-key"] ?? "");
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      query[key] = value;
    }
    const body = await readJsonBody(req);

    const captured: NangoMockRequest = {
      authorization,
      connectionId,
      providerConfigKey,
      method,
      endpoint,
      query,
      body,
    };
    capturedRequests.push(captured);

    const result = await input.respond(captured);
    if (!result) {
      sendJson(res, 404, { error: "unhandled", endpoint, method });
      return;
    }
    sendJson(res, result.status, result.body ?? null, result.headers);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock Nango SDK server failed to bind.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    capturedRequests,
    syncTriggers,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
