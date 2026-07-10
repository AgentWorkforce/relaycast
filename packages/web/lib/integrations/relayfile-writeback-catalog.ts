/**
 * Catalog-driven view of the relayfile-adapters writeback surface.
 *
 * The source of truth is the generated catalog shipped by
 * `@relayfile/adapter-core/writeback-paths`, emitted by
 * `adapter-core writeback-paths generate` from each adapter's `resources.ts`.
 *
 * This module intentionally imports a checked-in JSON copy instead of the
 * package export. The package export currently pulls too much adapter-core
 * implementation into the OpenNext worker bundle, while the bridge only needs
 * static path templates for providers it can dispatch. `scripts/check-relayfile-writeback-catalog.mjs`
 * keeps the JSON in sync with the installed adapters catalog bridge subset.
 *
 * The bridge (`relayfile-writeback-bridge.ts`) consumes this module instead
 * of hardcoding per-provider path prefixes, so the cloud and the adapters
 * repo cannot silently disagree about which providers expose writeback paths.
 */
import catalogJson from "./relayfile-writeback-paths.catalog.json" with { type: "json" };

export type WritebackPathTemplate = {
  path: string;
  params: readonly string[];
};

export type WritebackPathCatalog = Readonly<
  Record<string, Readonly<Record<string, readonly WritebackPathTemplate[]>>>
>;

export const WRITEBACK_PATH_CATALOG: WritebackPathCatalog = catalogJson;

/**
 * Writeback mounts the cloud bridges that are intentionally absent from the
 * adapters-repo catalog. Every entry must carry a reason; the drift test in
 * `relayfile-writeback-catalog.test.ts` rejects bridge providers that are
 * neither in the catalog nor listed here.
 */
export const CLOUD_ONLY_WRITEBACK_MOUNTS: Readonly<Record<string, string>> = {
  // The cloud's Gmail mount lives at /google-mail (the Nango provider key)
  // and bridges labels/filters/send-as/messages/threads directly against the
  // Gmail REST API. The adapters repo has a separate `gmail` adapter with a
  // different mount root (/gmail) and resource set (drafts/threads/watches)
  // that the cloud does not bridge yet.
  "google-mail": "Cloud-specific Gmail mount handled via Nango; distinct from the adapters-repo `gmail` adapter",
};

const CATALOG_PROVIDERS: readonly string[] = Object.freeze(
  Object.keys(WRITEBACK_PATH_CATALOG).sort(),
);

export function catalogProviders(): readonly string[] {
  return CATALOG_PROVIDERS;
}

export function isCatalogProvider(provider: string): boolean {
  return Object.hasOwn(WRITEBACK_PATH_CATALOG, provider);
}

/**
 * Infer the provider that owns a relayfile mount path. Every adapter mounts
 * under `/{provider}/...`, so the first path segment identifies the provider
 * when it matches a catalog entry or a documented cloud-only mount.
 */
export function inferWritebackProviderForPath(path: string): string | null {
  const segment = /^\/([^/]+)\//u.exec(path)?.[1];
  if (!segment) {
    return null;
  }
  if (isCatalogProvider(segment) || Object.hasOwn(CLOUD_ONLY_WRITEBACK_MOUNTS, segment)) {
    return segment;
  }
  return null;
}

/**
 * Flattened writeback path templates for a provider, e.g.
 * `/github/repos/{owner}/{repo}/issues`. Returns an empty array for unknown
 * providers rather than throwing; callers decide whether that is an error.
 */
export function writebackPathTemplates(provider: string): readonly WritebackPathTemplate[] {
  if (!isCatalogProvider(provider)) {
    return [];
  }
  return Object.values(WRITEBACK_PATH_CATALOG[provider]).flat();
}
