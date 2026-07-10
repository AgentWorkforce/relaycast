import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEGACY_RELAYFILE_FANOUT_PROVIDERS,
  registry,
} from ".";

const INTEGRATIONS_DIR = join(process.cwd(), "packages/web/lib/integrations");

function relayfileProviders(): string[] {
  return readdirSync(INTEGRATIONS_DIR)
    .filter((name) => name.endsWith("-relayfile.ts"))
    .map((name) => basename(name, "-relayfile.ts"))
    .sort();
}

describe("IntegrationFanout provider coverage", () => {
  it("registers every relayfile provider or explicitly defers it to the legacy path", () => {
    const registered = new Set(registry.providerKeys());
    const uncovered = relayfileProviders().filter(
      (provider) =>
        !registered.has(provider) &&
        !LEGACY_RELAYFILE_FANOUT_PROVIDERS.has(provider),
    );

    expect(uncovered).toEqual([]);
  });

  it("registers GitHub as the first concrete fanout provider", () => {
    expect(registry.providerKeys()).toContain("github");
    expect(registry.get("github").mountRoot).toBe("/github");
  });

  it("registers all adapter-fanout providers", () => {
    expect(registry.providerKeys()).toEqual(["fathom", "github", "linear", "recall", "slack"]);
  });

  it("defers notion and dropbox to the legacy path", () => {
    expect([...LEGACY_RELAYFILE_FANOUT_PROVIDERS].sort()).toEqual(["dropbox", "notion"]);
  });
});
