import { createServer } from "node:http";
import { createReadStream } from "node:fs";

type CapturedRequest = {
  authorization: string;
  connectionId: string;
  providerConfigKey: string;
  method: string;
  endpoint: string;
};

type StartMockNangoProxyInput = {
  secret: string;
  fixturePath: string;
};

function json(
  statusCode: number,
  payload: unknown,
): { statusCode: number; body: string; headers: Record<string, string> } {
  return {
    statusCode,
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  };
}

export async function startMockNangoProxy(
  input: StartMockNangoProxyInput,
): Promise<{
  url: string;
  capturedRequests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const capturedRequests: CapturedRequest[] = [];

  const server = createServer(async (request, response) => {
    const authorization = request.headers.authorization ?? "";
    if (authorization !== `Bearer ${input.secret}`) {
      const result = json(401, { error: "unauthorized" });
      response.writeHead(result.statusCode, result.headers);
      response.end(result.body);
      return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    if (!pathname.startsWith("/proxy/")) {
      const result = json(404, { error: "not_found", pathname });
      response.writeHead(result.statusCode, result.headers);
      response.end(result.body);
      return;
    }

    const endpoint = pathname.substring("/proxy".length);
    const method = (request.method ?? "GET").toUpperCase();
    const connectionId = String(request.headers["connection-id"] ?? "");
    const providerConfigKey = String(request.headers["provider-config-key"] ?? "");

    capturedRequests.push({
      authorization,
      connectionId,
      providerConfigKey,
      method,
      endpoint,
    });

    if (/^\/repos\/[^/]+\/[^/]+\/tarball\/[^/]+$/.test(endpoint)) {
      response.writeHead(200, {
        "Content-Type": "application/x-gzip",
        "x-github-sha": "abc123",
      });
      createReadStream(input.fixturePath).pipe(response);
      return;
    }

    if (/^\/repos\/[^/]+\/[^/]+$/.test(endpoint)) {
      const result = json(200, {
        default_branch: "main",
        head_sha: "abc123",
      });
      response.writeHead(result.statusCode, result.headers);
      response.end(result.body);
      return;
    }

    if (/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+$/.test(endpoint)) {
      const result = json(200, { sha: "abc123" });
      response.writeHead(result.statusCode, result.headers);
      response.end(result.body);
      return;
    }

    const result = json(404, { error: "not_found", endpoint });
    response.writeHead(result.statusCode, result.headers);
    response.end(result.body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock Nango proxy failed to bind to a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    capturedRequests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
