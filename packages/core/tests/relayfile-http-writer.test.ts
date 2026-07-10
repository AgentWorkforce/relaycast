import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RELAYFILE_WRITER_AGENT_NAME,
  RelayfileHttpWriter,
  RelayfileHttpWriteError,
} from "../src/sync/relayfile-http-writer.js";
import { errorLogFields } from "../src/observability/error-cause.js";

describe("RelayfileHttpWriter", () => {
  it("preserves the nango-sync-worker agent identity and optimistic concurrency headers", async () => {
    const requests: Request[] = [];
    const writer = new RelayfileHttpWriter({
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_test",
      token: "token-1",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response("{}", {
          status: 200,
          headers: { etag: "rev-1" },
        });
      },
    });

    const result = await writer.writeFile({
      path: "/integrations/confluence/spaces/space-1.json",
      contents: "{}",
      baseRevision: "rev-0",
    });

    assert.equal(RELAYFILE_WRITER_AGENT_NAME, "nango-sync-worker");
    assert.equal(result.revision, "rev-1");
    assert.equal(requests[0]?.method, "PUT");
    assert.equal(requests[0]?.headers.get("x-relayfile-agent-name"), "nango-sync-worker");
    assert.equal(requests[0]?.headers.get("if-match"), "rev-0");
    assert.equal(requests[0]?.headers.get("authorization"), "Bearer token-1");
  });

  it("uses wildcard base revision by default and treats missing deletes as idempotent", async () => {
    const requests: Request[] = [];
    const writer = new RelayfileHttpWriter({
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_test",
      token: async () => "token-2",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response("not found", { status: 404 });
      },
    });

    await writer.deleteFile({ path: "/integrations/confluence/spaces/missing.json" });

    assert.equal(requests[0]?.method, "DELETE");
    assert.equal(requests[0]?.headers.get("if-match"), "*");
    assert.equal(requests[0]?.headers.get("x-relayfile-agent-name"), "nango-sync-worker");
  });

  it("reads files so provider auxiliary alias emission can reconcile prior state", async () => {
    const requests: Request[] = [];
    const writer = new RelayfileHttpWriter({
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_default",
      token: "token-3",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(
          JSON.stringify({
            path: "/linear/issues/by-uuid/issue-1.json",
            content: "{}",
            contentType: "application/json; charset=utf-8",
          }),
          {
            status: 200,
            headers: { etag: "rev-3" },
          },
        );
      },
    });

    const result = await writer.readFile(
      "rw_test",
      "/linear/issues/by-uuid/issue-1.json",
      "corr-1",
    );

    assert.equal(result.path, "/linear/issues/by-uuid/issue-1.json");
    assert.equal(result.content, "{}");
    assert.equal(result.revision, "rev-3");
    assert.equal(requests[0]?.method, "GET");
    assert.equal(
      requests[0]?.url,
      "https://relayfile.example/v1/workspaces/rw_test/fs/file?path=%2Flinear%2Fissues%2Fby-uuid%2Fissue-1.json",
    );
    assert.equal(requests[0]?.headers.get("authorization"), "Bearer token-3");
    assert.equal(requests[0]?.headers.get("x-correlation-id"), "corr-1");
    assert.equal(requests[0]?.headers.get("x-relayfile-agent-name"), "nango-sync-worker");
  });

  it("surfaces HTTP status, response body, and pseudo-`code` on non-2xx write — the #743 trap fix", async () => {
    const writer = new RelayfileHttpWriter({
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_test",
      token: "token-1",
      fetch: async () =>
        new Response('{"error":"insufficient_storage"}', {
          status: 507,
          headers: { "content-type": "application/json" },
        }),
    });

    let caught: unknown;
    try {
      await writer.writeFile({
        path: "/integrations/confluence/spaces/space-1.json",
        contents: "{}",
      });
    } catch (error) {
      caught = error;
    }

    // The pre-fix throw was `new Error("Relayfile write failed (507) ...")`
    // with no structured fields, so a downstream log of `error.message`
    // alone hid the status and body. The post-fix error exposes BOTH.
    assert.ok(caught instanceof RelayfileHttpWriteError);
    const err = caught as RelayfileHttpWriteError;
    assert.equal(err.status, 507);
    assert.equal(err.method, "PUT");
    assert.equal(err.path, "/integrations/confluence/spaces/space-1.json");
    assert.equal(err.responseBody, '{"error":"insufficient_storage"}');
    assert.equal(err.code, "relayfile_http_507");

    // And when handed to `errorLogFields`, the surfaced shape is uniform
    // with drizzle/PG errors — `errorCode` is non-empty.
    const surface = errorLogFields(caught);
    assert.equal(surface.errorCode, "relayfile_http_507");
    assert.ok(
      typeof surface.errorCode === "string" && surface.errorCode.length > 0,
      "RelayfileHttpWriteError must expose a non-empty `code` on the log surface",
    );
    assert.ok(surface.errorMessage.includes("507"));
  });

  it("wraps a network/DNS failure with `cause` set so the underlying error is loggable end-to-end", async () => {
    const networkError = new Error("fetch failed");
    Object.assign(networkError, { code: "ENOTFOUND" });

    const writer = new RelayfileHttpWriter({
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_test",
      token: "token-1",
      fetch: async () => {
        throw networkError;
      },
    });

    let caught: unknown;
    try {
      await writer.writeFile({
        path: "/integrations/confluence/spaces/space-1.json",
        contents: "{}",
      });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof RelayfileHttpWriteError);
    // The underlying network error MUST be reachable as `.cause`.
    const inner = (caught as { cause?: unknown }).cause;
    assert.equal(inner, networkError);

    // …and the log surface MUST carry the inner code (ENOTFOUND) so a
    // CloudWatch query can distinguish DNS from auth from rate-limit.
    const surface = errorLogFields(caught);
    assert.equal(surface.errorCauseChain.length, 2);
    assert.equal(surface.errorCauseChain[1].code, "ENOTFOUND");
  });
});
