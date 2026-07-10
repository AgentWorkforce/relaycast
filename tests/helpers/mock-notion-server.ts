import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";

export type MockNotionRecordedRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
};

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function pageResponse(id: string): Record<string, unknown> {
  return {
    object: "page",
    id,
    archived: false,
    in_trash: false,
    properties: {},
    url: `https://www.notion.so/${id.replace(/-/g, "")}`,
  };
}

export async function startMockNotion(): Promise<{
  port: number;
  baseUrl: string;
  recorded: MockNotionRecordedRequest[];
  stop: () => Promise<void>;
}> {
  const recorded: MockNotionRecordedRequest[] = [];
  let stopped = false;

  const server = createServer(async (request, response) => {
    try {
      const method = (request.method ?? "GET").toUpperCase();
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = await readBody(request);

      recorded.push({
        method,
        path: `${url.pathname}${url.search}`,
        headers: request.headers,
        body,
      });

      const markdownMatch = url.pathname.match(/^\/v1\/pages\/([^/]+)\/markdown$/);
      if (method === "PATCH" && markdownMatch) {
        sendJson(response, 200, pageResponse(decodeURIComponent(markdownMatch[1] ?? "")));
        return;
      }

      const pageMatch = url.pathname.match(/^\/v1\/pages\/([^/]+)$/);
      if (method === "PATCH" && pageMatch) {
        sendJson(response, 200, pageResponse(decodeURIComponent(pageMatch[1] ?? "")));
        return;
      }

      sendJson(response, 404, { object: "error", code: "not_found", message: "unknown mock Notion route" });
    } catch (error) {
      sendJson(response, 500, {
        object: "error",
        code: "mock_error",
        message: error instanceof Error ? error.message : "unknown mock error",
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock Notion server failed to bind to a TCP port.");
  }

  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    recorded,
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
