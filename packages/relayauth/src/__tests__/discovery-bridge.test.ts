import assert from "node:assert/strict";
import test from "node:test";
import type { AgentConfiguration } from "@relayauth/types";
import { createTestApp, createTestRequest, generateTestToken } from "./test-helpers.js";

const AGENT_CARD_PATH = "/v1/discovery/agent-card";
const BRIDGE_PATH = "/v1/discovery/bridge";

function bridgeHeaders(): HeadersInit {
  return { Authorization: `Bearer ${generateTestToken({ scopes: ["relayauth:identity:read:*"] })}` };
}

function assertBridgeConfiguration(body: unknown): asserts body is AgentConfiguration {
  assert.equal(typeof body, "object");
  assert.ok(body !== null);
  assert.equal(typeof (body as AgentConfiguration).issuer, "string");
  assert.equal(typeof (body as AgentConfiguration).token_endpoint, "string");
  assert.ok(Array.isArray((body as AgentConfiguration).scope_definitions));
}

test("GET /v1/discovery/agent-card returns relayauth as an A2A card", async () => {
  const app = createTestApp();
  const response = await app.request(
    createTestRequest("GET", AGENT_CARD_PATH),
    undefined,
    app.bindings,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /\bmax-age=3600\b/i);

  const body = await response.json();
  assert.equal(body.name, "relayauth");
  assert.equal(body.url, "http://localhost/v1/tokens");
  assert.ok(Array.isArray(body.skills));
  assert.ok(body.skills.length > 0);
});

test("POST /v1/discovery/bridge fetches an external agent card and returns AgentConfiguration", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.toString() : input.toString();
    assert.equal(url, "https://agent.example.com/.well-known/agent-card.json");

    return new Response(
      JSON.stringify({
        name: "agent",
        url: "https://agent.example.com/rpc",
        skills: [{ id: "search", name: "Search" }],
        authentication: { schemes: ["bearer"] },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const app = createTestApp();
    const response = await app.request(
      createTestRequest("POST", BRIDGE_PATH, { url: "https://agent.example.com" }, bridgeHeaders()),
      undefined,
      app.bindings,
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assertBridgeConfiguration(body);
    assert.equal(body.service_name, "agent");
    assert.equal(body.token_endpoint, "https://agent.example.com/rpc");
    assert.equal(body.scope_definitions[0]?.pattern, "a2a:search:invoke:*");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /v1/discovery/bridge returns 400 for an invalid request body", async () => {
  const app = createTestApp();
  const response = await app.request(
    createTestRequest("POST", BRIDGE_PATH, { nope: true }, bridgeHeaders()),
    undefined,
    app.bindings,
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "url is required" });
});

test("POST /v1/discovery/bridge rejects private hosts", async () => {
  const app = createTestApp();
  const response = await app.request(
    createTestRequest("POST", BRIDGE_PATH, { url: "http://127.0.0.1:8787" }, bridgeHeaders()),
    undefined,
    app.bindings,
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Private or loopback hosts are not allowed" });
});

test("POST /v1/discovery/bridge blocks redirects to private hosts before following them", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    const url = input instanceof URL ? input.toString() : input.toString();

    if (calls === 1) {
      assert.equal(url, "https://agent.example.com/.well-known/agent-card.json");
      assert.equal(init?.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: {
          location: "http://127.0.0.1:8787/.well-known/agent-card.json",
        },
      });
    }

    assert.fail(`fetch should not follow private redirect to ${url}`);
  }) as typeof fetch;

  try {
    const app = createTestApp();
    const response = await app.request(
      createTestRequest("POST", BRIDGE_PATH, { url: "https://agent.example.com" }, bridgeHeaders()),
      undefined,
      app.bindings,
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Private or loopback hosts are not allowed" });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /v1/discovery/bridge returns 422 for invalid agent cards", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ url: "https://agent.example.com/rpc" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const app = createTestApp();
    const response = await app.request(
      createTestRequest("POST", BRIDGE_PATH, { url: "https://agent.example.com" }, bridgeHeaders()),
      undefined,
      app.bindings,
    );

    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /name/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /v1/discovery/bridge returns 502 when the upstream agent card cannot be reached", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as typeof fetch;

  try {
    const app = createTestApp();
    const response = await app.request(
      createTestRequest("POST", BRIDGE_PATH, { url: "https://agent.example.com" }, bridgeHeaders()),
      undefined,
      app.bindings,
    );

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: "Unable to reach the specified agent card URL",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
