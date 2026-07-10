import test from "node:test";
import assert from "node:assert/strict";

import { LocalHttpRuntime } from "../src/runtime/local-http.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("LocalHttpRuntime forwards launch metadata using local sandbox API payload fields", async () => {
  const requests: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ url, init, body });

    return new Response(JSON.stringify({
      sandboxId: "sandbox-1",
      homeDir: "/home/daytona",
      workdir: body.workdir,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const runtime = new LocalHttpRuntime({ baseUrl: "http://127.0.0.1:8787/" });

  const handle = await runtime.launch({
    label: "implement",
    name: "implement-run-1-abc-1",
    labels: { run: "run-1" },
    env: { TOKEN: "secret" },
    workdir: "/project",
    createTimeoutSeconds: 120,
  });

  assert.equal(handle.id, "sandbox-1");
  assert.equal(handle.workdir, "/project");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "http://127.0.0.1:8787/sandboxes");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.deepEqual(requests[0]?.body, {
    name: "implement-run-1-abc-1",
    labels: { run: "run-1", step: "implement" },
    env: { TOKEN: "secret" },
    envVars: { TOKEN: "secret" },
    workdir: "/project",
    timeoutSeconds: 120,
  });
  assert.equal(
    Object.hasOwn(requests[0]?.body ?? {}, "createTimeoutSeconds"),
    false,
  );
});
