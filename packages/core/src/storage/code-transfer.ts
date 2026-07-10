import path from 'node:path';
import { readFile } from 'node:fs/promises';
import ignore from 'ignore';
import * as tar from 'tar';

import type { ScopedS3Client } from './client.js';
import type { SandboxLike } from '../code-sync/types.js';

const CODE_TAR_KEY = 'code.tar.gz';
const SANDBOX_TAR_PATH = '/tmp/code.tar.gz';

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeEntryPath(entryPath: string): string {
  return entryPath.replace(/^\.\//, '').replace(/\\/g, '/');
}

async function buildIgnore(rootDir: string): Promise<ignore.Ignore> {
  const ig = ignore();

  // Always match code-sync scanner behavior.
  ig.add(['.git', 'node_modules']);

  try {
    const gitignoreContent = await readFile(path.join(rootDir, '.gitignore'), 'utf-8');
    ig.add(gitignoreContent);
  } catch {
    // No .gitignore file is a valid case.
  }

  return ig;
}

/**
 * Tar a local directory and upload a gzip'd archive to S3.
 */
export async function uploadCode(s3Client: ScopedS3Client, localDir: string): Promise<string> {
  const absRoot = path.resolve(localDir);
  const ig = await buildIgnore(absRoot);

  const tarStream = tar.create(
    {
      gzip: true,
      cwd: absRoot,
      portable: true,
      filter: (entryPath: string): boolean => !ig.ignores(normalizeEntryPath(entryPath)),
    },
    ['.'],
  );

  const chunks: Buffer[] = [];
  for await (const chunk of tarStream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  const tarBuffer = Buffer.concat(chunks);

  await s3Client.putObject(CODE_TAR_KEY, tarBuffer, 'application/gzip');
  return CODE_TAR_KEY;
}

/**
 * Download gzip'd tar from S3, upload into sandbox, extract, then clean up.
 */
export async function downloadAndExtractCode(
  s3Client: ScopedS3Client,
  s3Key: string,
  sandbox: SandboxLike,
  targetDir: string,
): Promise<void> {
  const tarBuffer = await s3Client.getObject(s3Key);
  const escapedTarPath = shellEscape(SANDBOX_TAR_PATH);
  const escapedTargetDir = shellEscape(targetDir);

  await sandbox.fs.uploadFile(tarBuffer, SANDBOX_TAR_PATH);
  // Extract to local disk first, then copy to target — tar's per-file
  // create+write+close+utime is extremely slow on FUSE/S3-backed volumes.
  const localStaging = '/tmp/code-staging';
  const extractResult = await sandbox.process.executeCommand(
    `rm -rf ${localStaging} && mkdir -p ${localStaging} && tar xzf ${escapedTarPath} --no-same-owner --no-same-permissions -C ${localStaging} 2>/dev/null`,
  );
  // tar exit 2 = warnings (e.g. utime on volumes), not fatal errors
  if (extractResult.exitCode !== 0 && extractResult.exitCode !== 2) {
    throw new Error(`Code extraction failed (exit ${extractResult.exitCode}): ${extractResult.result}`);
  }
  const copyResult = await sandbox.process.executeCommand(
    `mkdir -p ${escapedTargetDir} && cp -a ${localStaging}/. ${escapedTargetDir}/ && rm -rf ${localStaging} ${escapedTarPath}`,
  );
  if (copyResult.exitCode !== 0) {
    throw new Error(`Code copy to volume failed (exit ${copyResult.exitCode}): ${copyResult.result}`);
  }
}
