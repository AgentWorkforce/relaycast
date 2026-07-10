import { describe, expect, it } from "vitest";
import { createAdapterFanout } from "./create-adapter-fanout";
import { registry } from ".";

describe("createAdapterFanout factory", () => {
  it("creates a fanout with the correct providerKey and mountRoot", () => {
    const fanout = createAdapterFanout({
      providerKey: "test-provider",
      mountRoot: "/test",
      normalizeWebhook: (_payload, _headers) => ({ objectType: "item", objectId: "123" }),
      computePath: (objectType, objectId) => `/test/${objectType}/${objectId}`,
    });

    expect(fanout.providerKey).toBe("test-provider");
    expect(fanout.mountRoot).toBe("/test");
  });

  it("normalizeWebhook returns null when the adapter throws on bad payload", () => {
    const fanout = createAdapterFanout({
      providerKey: "throwing-provider",
      mountRoot: "/throw",
      normalizeWebhook: (_payload, _headers) => {
        throw new Error("bad payload");
      },
      computePath: (objectType, objectId) => `/throw/${objectType}/${objectId}`,
    });

    const result = fanout.normalizeWebhook({
      headers: {},
      payload: { bad: "data" },
      connectionId: "conn-1",
    });

    expect(result).toBeNull();
  });

  it("normalizeWebhook converts Headers instance to plain object", () => {
    const received: Record<string, string | undefined> = {};
    const fanout = createAdapterFanout({
      providerKey: "header-provider",
      mountRoot: "/headers",
      normalizeWebhook: (_payload, headers) => {
        Object.assign(received, headers);
        return { objectType: "obj", objectId: "1" };
      },
      computePath: (objectType, objectId) => `/headers/${objectType}/${objectId}`,
    });

    const headers = new Headers({ "x-custom": "value" });
    fanout.normalizeWebhook({ headers, payload: {}, connectionId: "conn-2" });

    expect(received["x-custom"]).toBe("value");
  });

  it("pathFor delegates to computePath with the record's objectType and objectId", () => {
    const fanout = createAdapterFanout({
      providerKey: "path-provider",
      mountRoot: "/path",
      normalizeWebhook: (_payload, _headers) => ({ objectType: "issue", objectId: "42" }),
      computePath: (objectType, objectId) => `/path/${objectType}/${objectId}`,
    });

    const result = fanout.pathFor({ objectType: "issue", objectId: "42" });
    expect(result).toBe("/path/issue/42");
  });

  it("shouldWrite defaults to true when no shouldWrite option is provided", () => {
    const fanout = createAdapterFanout({
      providerKey: "default-write-provider",
      mountRoot: "/default",
      normalizeWebhook: (_payload, _headers) => ({ objectType: "item", objectId: "1" }),
      computePath: (objectType, objectId) => `/default/${objectType}/${objectId}`,
    });

    expect(fanout.shouldWrite({ objectType: "item", objectId: "1" })).toBe(true);
  });

  it("shouldWrite uses provided shouldWrite when given", () => {
    const fanout = createAdapterFanout({
      providerKey: "custom-write-provider",
      mountRoot: "/custom",
      normalizeWebhook: (_payload, _headers) => ({ objectType: "item", objectId: "1" }),
      computePath: (objectType, objectId) => `/custom/${objectType}/${objectId}`,
      shouldWrite: (record) => record.objectId !== "skip",
    });

    expect(fanout.shouldWrite({ objectType: "item", objectId: "keep" })).toBe(true);
    expect(fanout.shouldWrite({ objectType: "item", objectId: "skip" })).toBe(false);
  });
});

describe("registered adapter-fanout providers smoke tests", () => {
  it("github provider is registered with correct mountRoot", () => {
    expect(registry.get("github").mountRoot).toBe("/github");
  });

  it("linear provider is registered with correct mountRoot", () => {
    expect(registry.get("linear").mountRoot).toBe("/linear");
  });

  it("slack provider is registered with correct mountRoot", () => {
    expect(registry.get("slack").mountRoot).toBe("/slack");
  });

  it("fathom provider is registered with correct mountRoot", () => {
    expect(registry.get("fathom").mountRoot).toBe("/fathom");
  });

  it("recall provider is registered with correct mountRoot", () => {
    expect(registry.get("recall").mountRoot).toBe("/recall");
  });
});
