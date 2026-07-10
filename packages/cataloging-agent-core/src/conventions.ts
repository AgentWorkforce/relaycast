/**
 * Convention fragment shape and write lifecycle.
 *
 * Cataloging agents publish per-provider VFS path conventions to
 * `/_conventions/<provider>.json`. Assistant runtimes list that path at
 * turn-start and compose a just-in-time skill showing only the providers
 * the workspace has synced. One skill, always current, zero runtime
 * discovery.
 */

import { RelayFileApiError, type RelayFileClient, type FileSemantics } from "@relayfile/sdk";

export interface VfsConventionFragment {
  /** Provider identifier (matches the cataloging agent domain) — e.g. `'github'`. */
  provider: string;
  /** Adapter package version this fragment was generated against. */
  version: string;
  /** ISO timestamp set when the fragment is built. Excluded from idempotency hash. */
  generatedAt: string;
  paths: VfsConventionPath[];
  typicalQueries?: VfsConventionQuery[];
}

export interface VfsConventionPath {
  /** e.g. `'/github/repos/{owner}/{repo}/pulls/{n}/metadata.json'`. */
  pattern: string;
  description: string;
  /** Maps to the adapter's object type registry — e.g. `'pull_request'`. */
  objectType?: string;
}

export interface VfsConventionQuery {
  /** Human-readable intent — e.g. `'list open PRs in a repo'`. */
  intent: string;
  /** Ordered tool-call description steps. */
  steps: string[];
}

/** Root path under which `<provider>.json` fragments live. */
export const CONVENTIONS_VFS_ROOT = "/_conventions";

/** Resolve the canonical fragment path for a provider. */
export function conventionPath(provider: string): string {
  const normalized = provider.trim();
  if (!normalized) {
    throw new Error("conventionPath() requires a non-empty provider");
  }
  return `${CONVENTIONS_VFS_ROOT}/${normalized}.json`;
}

/**
 * Fingerprint that excludes `generatedAt` so timestamp churn alone never
 * triggers a redundant write. Stored on the file's semantics so subsequent
 * cold-starts can hash-compare without re-reading the body.
 */
export async function fingerprintConventionFragment(
  fragment: VfsConventionFragment,
): Promise<string> {
  const stable = stableStringify({
    provider: fragment.provider,
    version: fragment.version,
    paths: fragment.paths,
    typicalQueries: fragment.typicalQueries ?? [],
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stable),
  );
  return `sha256:${bytesToBase64Url(new Uint8Array(digest))}`;
}

const CONTENT_FINGERPRINT_PROPERTY = "cataloging.conventionFingerprint";
const CONVENTION_PROVIDER_PROPERTY = "cataloging.conventionProvider";

export interface WriteConventionResult {
  status: "written" | "skipped";
  path: string;
  provider: string;
  fingerprint: string;
}

/**
 * Idempotently emit a convention fragment to RelayFile.
 *
 * On every invocation:
 *  1. Read `/_conventions/<provider>.json` (404 = first write).
 *  2. Compare the existing `cataloging.conventionFingerprint` semantics
 *     property to the freshly-computed fingerprint.
 *  3. Skip the write when fingerprints match — `generatedAt` is excluded
 *     from the fingerprint, so timestamp churn never triggers a redundant
 *     write.
 */
export async function writeConventionFragment(input: {
  client: RelayFileClient;
  workspaceId: string;
  fragment: VfsConventionFragment;
  signal?: AbortSignal;
}): Promise<WriteConventionResult> {
  const { client, workspaceId, fragment, signal } = input;
  const path = conventionPath(fragment.provider);
  const fingerprint = await fingerprintConventionFragment(fragment);

  let baseRevision = "0";
  try {
    const existing = await client.readFile(workspaceId, path, undefined, signal);
    baseRevision = existing.revision;
    const existingFingerprint = existing.semantics?.properties?.[CONTENT_FINGERPRINT_PROPERTY];
    if (existingFingerprint === fingerprint) {
      return { status: "skipped", path, provider: fragment.provider, fingerprint };
    }
  } catch (error) {
    if (!(error instanceof RelayFileApiError) || error.status !== 404) {
      throw error;
    }
  }

  const semantics: FileSemantics = {
    properties: {
      [CONVENTION_PROVIDER_PROPERTY]: fragment.provider,
      [CONTENT_FINGERPRINT_PROPERTY]: fingerprint,
    },
  };

  await client.writeFile({
    workspaceId,
    path,
    baseRevision,
    content: `${JSON.stringify(fragment, null, 2)}\n`,
    contentType: "application/json",
    encoding: "utf-8",
    semantics,
    correlationId: `conventions:${fragment.provider}`,
    signal,
  });

  return { status: "written", path, provider: fragment.provider, fingerprint };
}

/** Stable JSON stringify — keys sorted at every nesting level. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
