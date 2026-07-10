import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { listComposioToolkits } from "@/lib/integrations/composio-service";
import {
  getProviderConfigKey,
  listNangoProviders,
  type NangoProviderSummary,
} from "@/lib/integrations/nango-service";
import {
  getAllowedBackends,
  listWorkspaceIntegrationCatalogEntries,
  type IntegrationBackend,
} from "@/lib/integrations/providers";

type IntegrationCatalogEntry = {
  id: string;
  displayName?: string;
  configKey?: string;
  vfsRoot: string;
  deprecated?: boolean;
  backend?: IntegrationBackend;
  backends?: IntegrationBackend[];
  sources?: string[];
  authMode?: string;
  categories?: string[];
  docs?: string;
};

function computeCatalogVersion(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 12);
}

function normalizeCatalogId(value: string): string {
  return value.trim().toLowerCase();
}

function vfsRootForProvider(id: string): string {
  return `/${id.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "")}`;
}

function upsertProvider(
  providers: Map<string, IntegrationCatalogEntry>,
  next: IntegrationCatalogEntry,
): void {
  const id = normalizeCatalogId(next.id);
  if (!id) {
    return;
  }
  const existing = providers.get(id);
  if (!existing) {
    providers.set(id, {
      ...next,
      id,
      vfsRoot: next.vfsRoot || vfsRootForProvider(id),
      backends: next.backends ?? (next.backend ? [next.backend] : undefined),
      sources: next.sources ? Array.from(new Set(next.sources)) : undefined,
    });
    return;
  }

  const backends = new Set([
    ...(existing.backends ?? (existing.backend ? [existing.backend] : [])),
    ...(next.backends ?? (next.backend ? [next.backend] : [])),
  ]);
  const sources = new Set([
    ...(existing.sources ?? []),
    ...(next.sources ?? []),
  ]);

  providers.set(id, {
    ...existing,
    displayName: existing.displayName ?? next.displayName,
    configKey: existing.configKey ?? next.configKey,
    vfsRoot: existing.vfsRoot || next.vfsRoot || vfsRootForProvider(id),
    deprecated: existing.deprecated || next.deprecated || undefined,
    backend: existing.backend ?? next.backend,
    backends: backends.size > 0
      ? (Array.from(backends).sort() as IntegrationBackend[])
      : undefined,
    sources: sources.size > 0 ? Array.from(sources).sort() : undefined,
    authMode: existing.authMode ?? next.authMode,
    categories: existing.categories ?? next.categories,
    docs: existing.docs ?? next.docs,
  });
}

function staticCatalogEntries(): IntegrationCatalogEntry[] {
  return listWorkspaceIntegrationCatalogEntries().map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    configKey: getProviderConfigKey(entry.id),
    vfsRoot: entry.vfsRoot,
    backend: entry.backend,
    backends: [...getAllowedBackends(entry.id)],
    sources: ["relayfile"],
    ...(entry.deprecated ? { deprecated: true } : {}),
  }));
}

async function dynamicNangoCatalogEntries(): Promise<IntegrationCatalogEntry[]> {
  const providers = await listNangoProviders();
  return providers.map((provider: NangoProviderSummary) => ({
    id: provider.id,
    displayName: provider.displayName,
    vfsRoot: vfsRootForProvider(provider.id),
    backend: "nango",
    backends: ["nango"],
    sources: ["nango"],
    ...(provider.authMode ? { authMode: provider.authMode } : {}),
    ...(provider.categories ? { categories: provider.categories } : {}),
    ...(provider.docs ? { docs: provider.docs } : {}),
  }));
}

async function dynamicComposioCatalogEntries(): Promise<IntegrationCatalogEntry[]> {
  const toolkits = await listComposioToolkits({ limit: 1000 });
  return toolkits.flatMap((toolkit): IntegrationCatalogEntry[] => {
    const id = typeof toolkit.slug === "string" ? toolkit.slug.trim() : "";
    if (!id) {
      return [];
    }
    return [{
      id,
      displayName:
        typeof toolkit.name === "string" && toolkit.name.trim()
          ? toolkit.name.trim()
          : id,
      vfsRoot: vfsRootForProvider(id),
      backend: "composio",
      backends: ["composio"],
      sources: ["composio"],
    }];
  });
}

async function buildCatalog(includeDynamic: boolean): Promise<IntegrationCatalogEntry[]> {
  const providers = new Map<string, IntegrationCatalogEntry>();
  for (const entry of staticCatalogEntries()) {
    upsertProvider(providers, entry);
  }

  if (includeDynamic) {
    const dynamicResults = await Promise.allSettled([
      dynamicNangoCatalogEntries(),
      dynamicComposioCatalogEntries(),
    ]);
    for (const result of dynamicResults) {
      if (result.status === "fulfilled") {
        for (const entry of result.value) {
          upsertProvider(providers, entry);
        }
      } else {
        console.warn("Dynamic integration catalog source failed:", result.reason);
      }
    }
  }

  return Array.from(providers.values()).sort((a, b) => {
    const left = a.displayName ?? a.id;
    const right = b.displayName ?? b.id;
    return left.localeCompare(right, "en", { sensitivity: "base" });
  });
}

function shouldIncludeDynamic(request: Request): boolean {
  const value = new URL(request.url).searchParams.get("dynamic") ?? "";
  return value === "1" || value.toLowerCase() === "true";
}

export async function GET(request: Request) {
  const providers = await buildCatalog(shouldIncludeDynamic(request));

  return NextResponse.json({
    providers,
    version: computeCatalogVersion(providers),
  });
}
