/**
 * Diff engine — compares local and remote manifests to produce a sync plan.
 */

import type { FileManifest, SyncPlan } from "./types.js";

/**
 * Compare local and remote manifests to produce a sync plan.
 */
export function diffManifests(
  local: FileManifest,
  remote: FileManifest
): SyncPlan {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const unchanged: string[] = [];

  for (const [filePath, localEntry] of local) {
    const remoteEntry = remote.get(filePath);
    if (!remoteEntry) {
      added.push(filePath);
    } else if (remoteEntry.hash !== localEntry.hash) {
      modified.push(filePath);
    } else {
      unchanged.push(filePath);
    }
  }

  for (const filePath of remote.keys()) {
    if (!local.has(filePath)) {
      deleted.push(filePath);
    }
  }

  added.sort();
  modified.sort();
  deleted.sort();
  unchanged.sort();

  return {
    added,
    modified,
    deleted,
    unchanged,
    stats: {
      toUpload: added.length + modified.length,
      toDelete: deleted.length,
      unchanged: unchanged.length,
    },
  };
}
