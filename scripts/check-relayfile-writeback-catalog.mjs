#!/usr/bin/env node
/**
 * Guard the web runtime's checked-in Relayfile writeback path catalog.
 *
 * The adapters package export is the source of truth, but importing it from
 * Next/OpenNext code pulls adapter-core implementation into the worker bundle.
 * Cloud keeps a tiny JSON copy of the bridge-recognized provider subset at
 * the web boundary and this script checks or refreshes it from the first
 * installed package catalog that contains the providers Cloud expects.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const VENDORED_CATALOG_PATH = path.join(
  repoRoot,
  "packages/web/lib/integrations/relayfile-writeback-paths.catalog.json",
);

const PACKAGE_CATALOG_MODULE = "dist/src/writeback-paths/index.js";
const SOURCE_RELATIVE_PATH = "packages/core/src/writeback-paths/catalog.generated.json";
const RUNTIME_CATALOG_PROVIDERS = [
  "confluence",
  "dropbox",
  "github",
  "gitlab",
  "google-calendar",
  "hubspot",
  "jira",
  "linear",
  "notion",
  "slack",
  "telegram",
];

export function findCatalogSource() {
  const packageRoots = [
    path.join(repoRoot, "node_modules/@relayfile/adapter-telegram/node_modules/@relayfile/adapter-core"),
    path.join(repoRoot, "packages/core/node_modules/@relayfile/adapter-telegram/node_modules/@relayfile/adapter-core"),
    path.join(repoRoot, "packages/web/node_modules/@relayfile/adapter-telegram/node_modules/@relayfile/adapter-core"),
    path.join(repoRoot, "packages/core/node_modules/@relayfile/adapter-core"),
    path.join(repoRoot, "packages/web/node_modules/@relayfile/adapter-core"),
    path.join(repoRoot, "node_modules/@relayfile/adapter-core"),
  ];

  for (const packageRoot of packageRoots) {
    const moduleFile = path.join(packageRoot, PACKAGE_CATALOG_MODULE);
    if (!existsSync(moduleFile)) {
      continue;
    }
    const label = `installed @relayfile/adapter-core (${path.relative(repoRoot, packageRoot)})`;
    const load = async () => {
      const module = await import(pathToFileURL(moduleFile).href);
      if (!module.WRITEBACK_PATH_CATALOG) {
        throw new Error(`${moduleFile} does not export WRITEBACK_PATH_CATALOG`);
      }
      return module.WRITEBACK_PATH_CATALOG;
    };
    return { label, load };
  }

  const checkouts = [
    ...(process.env.RELAYFILE_ADAPTERS_DIR
      ? [{
          label: `RELAYFILE_ADAPTERS_DIR (${process.env.RELAYFILE_ADAPTERS_DIR})`,
          file: path.join(process.env.RELAYFILE_ADAPTERS_DIR, SOURCE_RELATIVE_PATH),
        }]
      : []),
    {
      label: "sibling relayfile-adapters checkout",
      file: path.join(repoRoot, "..", "relayfile-adapters", SOURCE_RELATIVE_PATH),
    },
  ];
  for (const checkout of checkouts) {
    if (existsSync(checkout.file)) {
      return {
        label: checkout.label,
        load: async () => JSON.parse(readFileSync(checkout.file, "utf8")),
      };
    }
  }
  return null;
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep(value[key])]),
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

function renderCatalog(catalog) {
  return `${stableStringify(catalog)}\n`;
}

function runtimeCatalogFromSource(catalog) {
  return Object.fromEntries(
    RUNTIME_CATALOG_PROVIDERS.map((provider) => [provider, catalog[provider]]),
  );
}

function missingRequiredProviders(catalog) {
  return RUNTIME_CATALOG_PROVIDERS.filter((provider) => !Object.hasOwn(catalog, provider));
}

export function compareCatalogs(source, vendoredFile = VENDORED_CATALOG_PATH) {
  const vendored = JSON.parse(readFileSync(vendoredFile, "utf8"));
  const findings = [];

  const missing = missingRequiredProviders(source);
  if (missing.length > 0) {
    findings.push(`source catalog is missing required providers: ${missing.join(", ")}`);
  }

  if (stableStringify(runtimeCatalogFromSource(source)) !== stableStringify(vendored)) {
    findings.push("vendored runtime catalog differs from source catalog bridge-provider subset");
  }

  return findings;
}

async function main() {
  const write = process.argv.includes("--write");
  const source = findCatalogSource();
  if (!source) {
    console.error("check-relayfile-writeback-catalog: no installed or checkout catalog source found.");
    process.exit(1);
  }

  const catalog = await source.load();
  const missing = missingRequiredProviders(catalog);
  if (missing.length > 0) {
    console.error(
      `check-relayfile-writeback-catalog: ${source.label} is missing required providers: ${missing.join(", ")}`,
    );
    process.exit(1);
  }

  if (write) {
    await writeFile(VENDORED_CATALOG_PATH, renderCatalog(runtimeCatalogFromSource(catalog)));
    console.log(`check-relayfile-writeback-catalog: wrote ${VENDORED_CATALOG_PATH} from ${source.label}.`);
    return;
  }

  const findings = compareCatalogs(catalog);
  if (findings.length === 0) {
    console.log(`check-relayfile-writeback-catalog: vendored catalog matches ${source.label}.`);
    return;
  }

  console.error(`check-relayfile-writeback-catalog: vendored catalog drifted from ${source.label}:`);
  for (const finding of findings) {
    console.error(`  - ${finding}`);
  }
  console.error("Run: node scripts/check-relayfile-writeback-catalog.mjs --write");
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
