import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ConformanceManifest,
  validateManifest,
} from "./manifest-schema.ts";

const MANIFEST_DIR = fileURLToPath(new URL("./manifest", import.meta.url));

export interface LoadedManifest {
  /** Absolute path to the manifest JSON file. */
  file: string;
  /** File basename without extension (used for filtering, e.g. "slack"). */
  name: string;
  manifest: ConformanceManifest;
}

export class ManifestValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid conformance manifest(s):\n  - ${errors.join("\n  - ")}`);
    this.name = "ManifestValidationError";
  }
}

/** Parse + validate a single manifest file. Throws on validation failure. */
export function loadManifestFile(file: string): LoadedManifest {
  const name = basename(file).replace(/\.json$/i, "");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ManifestValidationError([
      `${name}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const result = validateManifest(raw, name);
  if (!result.valid) {
    throw new ManifestValidationError(result.errors);
  }
  return { file, name, manifest: raw as ConformanceManifest };
}

/**
 * Load every manifest under ./manifest. Validates all of them and aggregates
 * errors so one bad file does not hide others.
 */
export function loadAllManifests(): LoadedManifest[] {
  let entries: string[];
  try {
    entries = readdirSync(MANIFEST_DIR);
  } catch {
    return [];
  }
  const files = entries
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .sort()
    .map((f) => join(MANIFEST_DIR, f));

  const loaded: LoadedManifest[] = [];
  const allErrors: string[] = [];
  for (const file of files) {
    try {
      loaded.push(loadManifestFile(file));
    } catch (error) {
      if (error instanceof ManifestValidationError) {
        allErrors.push(...error.errors);
      } else {
        allErrors.push(
          `${basename(file)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  if (allErrors.length > 0) {
    throw new ManifestValidationError(allErrors);
  }
  return loaded;
}

/** Load a single manifest by provider name (basename of the file). */
export function loadManifestByName(name: string): LoadedManifest {
  const file = join(MANIFEST_DIR, `${name}.json`);
  return loadManifestFile(file);
}

export { MANIFEST_DIR };
