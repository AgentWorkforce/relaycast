/**
 * Overlay substrate — shared types + key builders for the RelayFile durable
 * architecture. See docs/relayfile-overlay-substrate.md.
 *
 * Model (locked through architecture review; contract converged claude-2 ⇄ codex-3):
 *   - Immutable BASE in R2, content-addressed, OFF the DO. Serves the ~99% of
 *     reads that are unchanged files; never touches the hot isolate.
 *   - Slim mutable OVERLAY of deltas in the DO. LWW, near-real-time cursor sync,
 *     no CRDT / no per-file locking (divide-and-conquer, mostly-different-files).
 *
 * Two invariants this module encodes by construction:
 *   1. DELTAS ARE METADATA-ONLY. A delta is a POINTER (blobRef); bodies are
 *      put-by-hash to R2 under the SAME immutable blob scheme as the base. There
 *      is deliberately NO inline-bytes field — inline bytes would re-melt the DO
 *      on writes exactly like the per-file base rows melted it on import. The DO
 *      stays pure metadata/coordination on writes as well as reads.
 *   2. LWW KEY = DO-ASSIGNED MONOTONIC REVISION, never wall-clock. The DO is the
 *      single write-coordinator, so it assigns a monotonic `revision` per write.
 *      That revision IS the LWW order (highest-rev-wins) AND doubles as the
 *      near-real-time sync cursor (clients pull deltas since cursor N). Wall-clock
 *      LWW would be non-deterministic under cross-sandbox clock skew.
 *
 * This (revision, contentHash) pairing is exactly what the daytona daemon already
 * cross-checks (relayfile PR #90): `tracked.Revision == event.Revision &&
 * tracked.Hash != event.ContentHash → force re-fetch`. So both fields are
 * load-bearing on every delta.
 */
import { hashContent, bytesToHex } from "./durable-objects/content-hash.js";

/** Content encoding shared by base entries AND overlay deltas, so the resolver
 *  returns bytes uniformly regardless of source. Matches content-hash.ts. */
export type ContentEncoding = "utf-8" | "base64";

/** SHA-256 hex of the RAW bytes — the single content-address used by both base
 *  blobs and overlay-delta blobs. Mirrors the daemon's hashBytes (content-hash.ts)
 *  so the mount tree-verify cross-check agrees. */
export type ContentHash = string; // sha256 hex (64 chars)

/** R2 object key for an immutable, content-addressed blob (raw bytes). The same
 *  scheme backs base blobs and overlay-delta blobs. */
export type BlobRef = string; // = blobKey(hash)

// --- R2 / D1 key builders --------------------------------------------------

/**
 * Immutable content-addressed blob key. Globally dedup'd — no workspace or path
 * in the key, so identical bytes across workspaces / snapshots / deltas share one
 * object. Idempotent put-by-hash. 2-char fanout on the hash prefix for R2 hygiene.
 * e.g. `immutable/github/blobs/sha256/ab/abcd…`
 */
export function blobKey(hash: ContentHash): BlobRef {
  return `immutable/github/blobs/sha256/${hash.slice(0, 2)}/${hash}`;
}

/**
 * Base manifest (NDJSON, sorted by RelayFile `path`) for one workspace's github
 * base snapshot. `headSha` IS the snapshotId for github.
 */
export function baseManifestKey(
  workspaceId: string,
  owner: string,
  repo: string,
  headSha: string,
): string {
  return `workspaces/${workspaceId}/bases/github/repos/${owner}/${repo}/${headSha}/manifest.v1.ndjson`;
}

/**
 * Optional path-index sidecar for O(1) point/prefix lookup on /fs/file + /fs/tree
 * (added when those overlay-resolve, P1b+). Same prefix as the manifest.
 */
export function basePathsIndexKey(
  workspaceId: string,
  owner: string,
  repo: string,
  headSha: string,
): string {
  return `workspaces/${workspaceId}/bases/github/repos/${owner}/${repo}/${headSha}/paths.v1.json`;
}

/**
 * The clone-ready sentinel row (`.relayfile/clone.json`) the persona preflight
 * waits on via `waitForSentinel`. It is the ONLY row the base import writes to
 * the DO — NO per-file base rows. The AUTHORITATIVE base-ref is the D1
 * github_base_snapshots row (read by headSha, off the hot DO); this sentinel is
 * the readiness marker, not the base pointer.
 */
export function cloneSentinelPath(owner: string, repo: string): string {
  return `/github/repos/${owner}/${repo}/.relayfile/clone.json`;
}

// --- Base snapshot ---------------------------------------------------------

/**
 * One line of the base manifest NDJSON. `path` stays the current logical RelayFile
 * path (`/github/repos/<owner>/<repo>/contents/<encodedRepoPath>@<headSha>.json`)
 * so existing decode rules stay compatible; `repoPath` is the working-tree-relative
 * path the resolver and the materialize tar use.
 */
export type BaseManifestEntry = {
  path: string;
  repoPath: string;
  contentHash: ContentHash;
  blobRef: BlobRef;
  size: number;
  encoding: ContentEncoding;
  contentType?: string;
  /** Unix mode for the working-tree exec bit (the github tree carries it).
   *  Optional until the import confirms availability. */
  mode?: number;
  headSha: string;
  updatedAt: string; // ISO-8601
};

/**
 * Parent-Worker D1 row pointing at a base snapshot. Lives in D1 (NOT the hot DO)
 * so base lookup never touches the isolate — the "base off-DO" goal. Unique on
 * (workspaceId, owner, repo, headSha).
 */
export type GithubBaseSnapshot = {
  workspaceId: string;
  owner: string;
  repo: string;
  headSha: string; // = snapshotId
  contentRoot: string; // e.g. /github/repos/<owner>/<repo>/contents
  manifestRef: string; // = baseManifestKey(...)
  fileCount: number;
  bytes: number;
  createdAt: string; // ISO-8601
  current: boolean;
};

/**
 * Payload of the clone-ready sentinel (`.relayfile/clone.json`). `headSha`
 * identifies the snapshot the preflight cloned. The base-ref fields are an
 * OPTIONAL convenience mirror of the D1 row (which is authoritative and read by
 * headSha); the gated import MAY stamp them but no reader depends on them.
 *
 * No sync-resume cursor is stamped in the sentinel for P1a. Clients resume off
 * the EXISTING /fs/events stream by its eventId STRING cursor (#213), so if P1b
 * ever stamps a position here it must be that eventId string — not a number.
 * The per-delta `revision` (number) is a separate axis: the LWW ordering key +
 * the #90 (Revision, ContentHash) cross-check, NOT the feed cursor
 * (codex-1 #1267 review).
 */
export type CloneSentinel = {
  headSha: string;
  manifestRef?: string;
  contentRoot?: string;
  fileCount?: number;
};

// --- Overlay (slim DO, metadata-only) --------------------------------------

/**
 * Overlay write-op — METADATA ONLY (invariant 1). The body lives in R2 at
 * `blobKey(contentHash)`; this carries only the POINTER. There is deliberately no
 * inline-bytes field.
 */
export type OverlayDelta = {
  /** Working-tree-relative path; the overlay key. (The resolver normalizes a
   *  requested logical path to this form via the existing decode rules.) */
  repoPath: string;
  blobRef: BlobRef; // = blobKey(contentHash); NO inline bytes
  contentHash: ContentHash; // daemon PR-#90 cross-check key (with revision)
  size: number;
  encoding: ContentEncoding;
  /** DO-assigned MONOTONIC revision (invariant 2): LWW order (highest wins) AND
   *  the near-real-time sync cursor. Never wall-clock. */
  revision: number;
  /** The base this delta was written against (= headSha). Lets a re-clone at a
   *  NEW headSha detect deltas relative to the OLD base (re-base detection)
   *  instead of silently mis-resolving against the wrong base. */
  baseSnapshotId: string;
};

/**
 * Overlay delete — a tombstone keyed by path + the same DO-assigned monotonic
 * revision sequence as {@link OverlayDelta}. Tombstone wins over base (LWW);
 * pruned at base-advance / compaction.
 */
export type OverlayTombstone = {
  repoPath: string;
  revision: number; // same monotonic sequence as OverlayDelta
  baseSnapshotId: string;
  deletedAt: string; // ISO-8601; audit only — ordering is `revision`
};

// --- Read resolution -------------------------------------------------------

/**
 * Resolver result. The resolution ORDER is load-bearing (invariant 3):
 *   1. overlay delta-hit → `delta`
 *   2. overlay tombstone → `deleted`  ← DISTINCT from not-found, and MUST be
 *      checked BEFORE the base or a delete resurrects the base file
 *   3. base manifest hit → `base`
 *   4. otherwise          → `not-found`
 */
export type ResolveResult =
  | { kind: "delta"; entry: OverlayDelta }
  | { kind: "deleted"; revision: number }
  | { kind: "base"; entry: BaseManifestEntry }
  | { kind: "not-found" };

/** Re-exported so import, read-path, and overlay all hash bytes identically. */
export { hashContent, bytesToHex };
