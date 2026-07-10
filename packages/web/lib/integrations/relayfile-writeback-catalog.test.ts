import { describe, expect, it, vi } from "vitest";

import {
  CLOUD_ONLY_WRITEBACK_MOUNTS,
  catalogProviders,
  inferWritebackProviderForPath,
  isCatalogProvider,
} from "./relayfile-writeback-catalog";
import {
  compareCatalogs,
  findCatalogSource,
} from "../../../../scripts/check-relayfile-writeback-catalog.mjs";

// The bridge module transitively imports Nango/workspace-integration modules;
// mock them the same way relayfile-writeback-bridge.test.ts does so importing
// BRIDGE_WRITEBACK_PROVIDERS stays side-effect free.
vi.mock("./nango-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nango-service")>()),
  getNangoClient: vi.fn(),
  getProviderConfigKey: vi.fn(),
}));
vi.mock("./workspace-integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace-integrations")>()),
  getWorkspaceIntegrationByProviderAlias: vi.fn(),
}));

/** The vendored runtime catalog is limited to bridge-recognized providers. */
const CATALOG_PROVIDERS_NOT_BRIDGED: Record<string, string> = {
};

async function loadBridgeProviders(): Promise<readonly string[]> {
  const bridge = await import("./relayfile-writeback-bridge");
  return bridge.BRIDGE_WRITEBACK_PROVIDERS;
}

describe("relayfile writeback catalog drift", () => {
  it("every bridge provider is in the adapters catalog or documented as cloud-only", async () => {
    const bridgeProviders = await loadBridgeProviders();
    const undocumented = bridgeProviders.filter(
      (provider) =>
        !isCatalogProvider(provider) &&
        !Object.hasOwn(CLOUD_ONLY_WRITEBACK_MOUNTS, provider),
    );
    expect(undocumented).toEqual([]);
  });

  it("every catalog provider is bridged or explicitly allowlisted with a reason", async () => {
    const bridgeProviders = new Set(await loadBridgeProviders());
    const unaccounted = catalogProviders().filter(
      (provider) =>
        !bridgeProviders.has(provider) &&
        !Object.hasOwn(CATALOG_PROVIDERS_NOT_BRIDGED, provider),
    );
    expect(unaccounted).toEqual([]);
  });

  it("the not-bridged allowlist contains no stale or contradictory entries", async () => {
    const bridgeProviders = new Set(await loadBridgeProviders());
    for (const provider of Object.keys(CATALOG_PROVIDERS_NOT_BRIDGED)) {
      // Stale: the catalog no longer has the provider.
      expect(isCatalogProvider(provider), `allowlist entry "${provider}" is not in the catalog`).toBe(true);
      // Contradictory: the bridge now executes it, so the entry must go.
      expect(
        bridgeProviders.has(provider),
        `allowlist entry "${provider}" is now bridged; remove it from CATALOG_PROVIDERS_NOT_BRIDGED`,
      ).toBe(false);
    }
  });

  it("documented cloud-only mounts stay absent from the catalog", () => {
    for (const mount of Object.keys(CLOUD_ONLY_WRITEBACK_MOUNTS)) {
      expect(
        isCatalogProvider(mount),
        `"${mount}" is now in the adapters catalog; drop it from CLOUD_ONLY_WRITEBACK_MOUNTS`,
      ).toBe(false);
    }
  });

  it("infers providers from mount paths via the catalog", () => {
    expect(inferWritebackProviderForPath("/github/repos/o/r/issues/1.json")).toBe("github");
    expect(inferWritebackProviderForPath("/confluence/pages/page-1.json")).toBe("confluence");
    expect(inferWritebackProviderForPath("/google-mail/labels/Label_1.json")).toBe("google-mail");
    expect(inferWritebackProviderForPath("/linear/labels/label-1.json")).toBe("linear");
    expect(inferWritebackProviderForPath("/telegram/chats/8587455921/messages/draft.json")).toBe("telegram");
    expect(inferWritebackProviderForPath("/not-a-provider/x.json")).toBeNull();
    expect(inferWritebackProviderForPath("relative/path.json")).toBeNull();
  });

  it("vendored catalog matches the installed adapters catalog", async () => {
    const source = findCatalogSource();
    expect(source).not.toBeNull();
    expect(compareCatalogs(await source!.load()), `drift against ${source!.label}`).toEqual([]);
  });
});
