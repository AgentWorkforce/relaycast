import { describe, expect, it } from "vitest";
import {
  IntegrationFanoutRegistry,
  type IntegrationFanout,
} from "./registry";

function fanout(providerKey: string): IntegrationFanout<{ id: string }> {
  return {
    providerKey,
    mountRoot: `/${providerKey}`,
    normalizeWebhook: () => ({ id: "webhook" }),
    pathFor: (record) => `/${providerKey}/${record.id}.json`,
    shouldWrite: () => true,
  };
}

describe("IntegrationFanoutRegistry", () => {
  it("registers and returns a provider fanout", () => {
    const registry = new IntegrationFanoutRegistry();
    const github = fanout("github");

    registry.register(github);

    expect(registry.get("github")).toBe(github);
    expect(registry.has("github")).toBe(true);
    expect(registry.providerKeys()).toEqual(["github"]);
  });

  it("throws for a missing provider", () => {
    const registry = new IntegrationFanoutRegistry();

    expect(() => registry.get("github")).toThrow(
      "IntegrationFanout provider is not registered: github",
    );
  });

  it("throws when registering the same provider twice", () => {
    const registry = new IntegrationFanoutRegistry();

    registry.register(fanout("github"));

    expect(() => registry.register(fanout("github"))).toThrow(
      "IntegrationFanout provider already registered: github",
    );
  });

  it("rejects blank provider keys", () => {
    const registry = new IntegrationFanoutRegistry();

    expect(() => registry.register(fanout("  "))).toThrow(
      "IntegrationFanout providerKey is required.",
    );
  });
});
