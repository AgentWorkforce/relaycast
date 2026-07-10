import { createServer } from "node:http";

type StoredFile = {
  content: string;
  encoding: string;
  contentType?: string;
};

type WriteRecord = {
  path: string;
  content: string;
  encoding: string;
  contentType?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(
  response: import("node:http").ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

export async function startMockRelayfile(): Promise<{
  url: string;
  writes: WriteRecord[];
  seed: (path: string, content: string) => void;
  setErrorOnBulkNumber: (n: number, errorCount: number) => void;
  concurrentPeak: () => number;
  close: () => Promise<void>;
}> {
  const writes: WriteRecord[] = [];
  const storedFiles = new Map<string, StoredFile>();
  const readPaths: string[] = [];

  let bulkCallNumber = 0;
  let errorBulkNumber = 0;
  let configuredErrorCount = 0;
  let inFlightBulkCalls = 0;
  let peakConcurrentBulkCalls = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname.match(/^\/v1\/workspaces\/[^/]+\/fs\/bulk$/) && request.method === "POST") {
      const body = await readJsonBody(request);
      const files = Array.isArray(body.files) ? body.files : [];

      bulkCallNumber += 1;
      inFlightBulkCalls += 1;
      peakConcurrentBulkCalls = Math.max(peakConcurrentBulkCalls, inFlightBulkCalls);

      try {
        await sleep(25);

        if (bulkCallNumber === errorBulkNumber && configuredErrorCount > 0) {
          const errors = files.slice(0, configuredErrorCount).map((file, index) => {
            const path = typeof (file as { path?: unknown }).path === "string"
              ? (file as { path: string }).path
              : `unknown-${index}`;
            return {
              path,
              code: "mock_failure",
              message: "Simulated relayfile bulk failure",
            };
          });

          sendJson(response, 200, {
            written: Math.max(0, files.length - errors.length),
            errorCount: errors.length,
            errors,
            correlationId: "rf_mock_bulk_error",
          });
          return;
        }

        for (const file of files) {
          if (!file || typeof file !== "object") {
            continue;
          }

          const record = file as {
            path?: unknown;
            content?: unknown;
            encoding?: unknown;
            contentType?: unknown;
          };

          if (typeof record.path !== "string" || typeof record.content !== "string") {
            continue;
          }

          const encoding = typeof record.encoding === "string" ? record.encoding : "utf-8";
          const contentType = typeof record.contentType === "string" ? record.contentType : undefined;

          writes.push({
            path: record.path,
            content: record.content,
            encoding,
            contentType,
          });
          storedFiles.set(record.path, {
            content: record.content,
            encoding,
            contentType,
          });
        }

        sendJson(response, 200, {
          written: files.length,
          errorCount: 0,
          errors: [],
          correlationId: "rf_mock_bulk_ok",
        });
      } finally {
        inFlightBulkCalls -= 1;
      }

      return;
    }

    const isSingleWrite =
      pathname.match(/^\/v1\/workspaces\/[^/]+\/fs\/write$/)
      || pathname.match(/^\/v1\/workspaces\/[^/]+\/fs\/file$/);
    if (isSingleWrite && (request.method === "POST" || request.method === "PUT")) {
      const body = await readJsonBody(request);
      const path =
        typeof body.path === "string"
          ? body.path
          : url.searchParams.get("path");

      if (!path || typeof body.content !== "string") {
        sendJson(response, 400, { code: "bad_request", message: "path and content are required" });
        return;
      }

      const encoding = typeof body.encoding === "string" ? body.encoding : "utf-8";
      const contentType = typeof body.contentType === "string" ? body.contentType : undefined;

      writes.push({
        path,
        content: body.content,
        encoding,
        contentType,
      });
      storedFiles.set(path, {
        content: body.content,
        encoding,
        contentType,
      });

      sendJson(response, 200, {
        path,
        revision: `rev_${writes.length}`,
        contentType: contentType ?? "application/json",
        content: body.content,
        encoding,
      });
      return;
    }

    const isRead =
      pathname.match(/^\/v1\/workspaces\/[^/]+\/fs\/read$/)
      || pathname.match(/^\/v1\/workspaces\/[^/]+\/fs\/file$/);
    if (isRead && request.method === "GET") {
      const path = url.searchParams.get("path");
      if (!path) {
        sendJson(response, 400, { code: "bad_request", message: "path is required" });
        return;
      }

      readPaths.push(path);
      const stored = storedFiles.get(path);
      if (!stored) {
        sendJson(response, 404, { code: "not_found", message: "file not found" });
        return;
      }

      sendJson(response, 200, {
        path,
        revision: "rev_seeded",
        contentType: stored.contentType ?? "application/json",
        content: stored.content,
        encoding: stored.encoding,
      });
      return;
    }

    sendJson(response, 404, { code: "not_found", message: "unknown mock relayfile route" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock Relayfile server failed to bind to a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    writes,
    seed: (path: string, content: string) => {
      storedFiles.set(path, {
        content,
        encoding: "utf-8",
        contentType: "application/json",
      });
    },
    setErrorOnBulkNumber: (n: number, errorCount: number) => {
      errorBulkNumber = n;
      configuredErrorCount = errorCount;
    },
    concurrentPeak: () => peakConcurrentBulkCalls,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    // Extra introspection for contract tests; callers can cast when needed.
    bulkCallCount: () => bulkCallNumber,
    readPaths: () => [...readPaths],
  } as {
    url: string;
    writes: WriteRecord[];
    seed: (path: string, content: string) => void;
    setErrorOnBulkNumber: (n: number, errorCount: number) => void;
    concurrentPeak: () => number;
    close: () => Promise<void>;
  };
}
