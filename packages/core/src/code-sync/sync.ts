/**
 * Sync engine — uploads/deletes files to a sandbox based on a diff plan.
 */

import path from "node:path";
import * as tar from "tar";
import type { SyncOptions, SyncResult } from "./types.js";
import { MANIFEST_FILENAME, TMP_TAR_PATH } from "./types.js";
import { serializeManifest } from "./manifest.js";
import { exec } from "./sandbox.js";
import { SandboxCommandError } from "./errors.js";

/**
 * Sync files to a Daytona sandbox based on a diff plan.
 * Uses tar+upload+extract for bulk file transfer.
 */
export async function syncToSandbox(options: SyncOptions): Promise<SyncResult> {
  const {
    rootDir,
    sandboxDir,
    sandbox,
    manifest,
    plan,
  } = options;

  const absRoot = path.resolve(rootDir);
  const errors: Array<{ file: string; error: string }> = [];
  let uploaded = 0;
  let deleted = 0;

  // Upload added and modified files via tar archive
  const toUpload = [...plan.added, ...plan.modified];
  if (toUpload.length > 0) {
    try {
      const tarStream = tar.create(
        { gzip: true, cwd: absRoot, portable: true },
        toUpload
      );

      const chunks: Buffer[] = [];
      for await (const chunk of tarStream) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      const tarBuffer = Buffer.concat(chunks);

      await sandbox.fs.uploadFile(tarBuffer, TMP_TAR_PATH);

      try {
        await exec(sandbox, `tar xzf ${TMP_TAR_PATH} -C ${sandboxDir}`);
      } catch (err) {
        if (err instanceof SandboxCommandError) {
          throw new Error(`tar extract failed (exit ${err.exitCode}): ${err.output}`);
        }
        throw err;
      }

      uploaded = toUpload.length;
    } catch (err: any) {
      for (const file of toUpload) {
        errors.push({ file, error: err.message ?? String(err) });
      }
    }
  }

  // Delete removed files in a single batch
  if (plan.deleted.length > 0) {
    const remotePaths = plan.deleted.map((f) => path.posix.join(sandboxDir, f));
    try {
      try {
        await exec(sandbox, `rm -f ${remotePaths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" ")}`);
      } catch (err) {
        if (err instanceof SandboxCommandError) {
          throw new Error(`rm failed (exit ${err.exitCode}): ${err.output}`);
        }
        throw err;
      }
      deleted = plan.deleted.length;
    } catch (err: any) {
      for (const file of plan.deleted) {
        errors.push({ file, error: err.message ?? String(err) });
      }
    }
  }

  // Upload manifest for future incremental syncs
  const serialized = serializeManifest(manifest, sandboxDir);
  const manifestRemotePath = path.posix.join(sandboxDir, MANIFEST_FILENAME);
  try {
    await sandbox.fs.uploadFile(
      Buffer.from(JSON.stringify(serialized, null, 2)),
      manifestRemotePath
    );
  } catch (err: any) {
    errors.push({ file: MANIFEST_FILENAME, error: err.message ?? String(err) });
  }

  return { uploaded, deleted, errors, manifest };
}
