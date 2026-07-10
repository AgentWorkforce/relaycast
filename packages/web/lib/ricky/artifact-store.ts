import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import * as tar from "tar";
import { createWorkflowStorageS3Client, readWorkflowStorageBucket as readConfiguredWorkflowStorageBucket } from "@/lib/storage";

type ArchiveIO = {
  readObject(key: string): Promise<Buffer>;
  writeObject(key: string, body: Buffer): Promise<void>;
};

function normalizeRelativePath(value: string): string {
  const trimmed = value.trim();
  const parts = trimmed.split("/");
  if (
    !trimmed ||
    trimmed.startsWith("/") ||
    trimmed.includes("\\") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe workflow path for Ricky repair: ${value}`);
  }
  return parts.join("/");
}

async function assertArchivePathCanBeRewritten(root: string, relativePath: string): Promise<void> {
  const parts = relativePath.split("/");
  let current = root;

  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);

    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Unsafe workflow path for Ricky repair: archive symlink at ${parts.slice(0, index + 1).join("/")}`);
      }
      if (index < parts.length - 1 && !stat.isDirectory()) {
        throw new Error(`Unsafe workflow path for Ricky repair: archive parent is not a directory at ${parts.slice(0, index + 1).join("/")}`);
      }
      if (index === parts.length - 1 && stat.isDirectory()) {
        throw new Error(`Unsafe workflow path for Ricky repair: archive target is a directory at ${relativePath}`);
      }
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }
}

function joinS3Key(...parts: string[]): string {
  return parts
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function readWorkflowStorageBucket(): string {
  const bucket = readConfiguredWorkflowStorageBucket();
  if (!bucket) {
    throw new Error("Workflow storage bucket is not configured for Ricky artifact isolation.");
  }
  return bucket;
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function createS3ArchiveIO(bucket = readWorkflowStorageBucket()): ArchiveIO {
  const s3 = createWorkflowStorageS3Client();

  return {
    async readObject(key) {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return bodyToBuffer(response.Body);
    },
    async writeObject(key, body) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: "application/gzip",
        }),
      );
    },
  };
}

export async function createRepairedSourceArchive(input: {
  archive: Buffer;
  workflowPath: string;
  repairedWorkflow: string;
}): Promise<{ archive: Buffer; digest: string }> {
  const workflowPath = normalizeRelativePath(input.workflowPath);
  const workDir = await mkdtemp(path.join(tmpdir(), "ricky-source-"));
  const archivePath = path.join(workDir, "code.tar.gz");
  const extractDir = path.join(workDir, "extract");
  const outputPath = path.join(workDir, "repaired-code.tar.gz");

  try {
    await mkdir(extractDir, { recursive: true });
    await writeFile(archivePath, input.archive);
    await tar.extract({ file: archivePath, cwd: extractDir, strict: true });
    await assertArchivePathCanBeRewritten(extractDir, workflowPath);
    const workflowTargetPath = path.join(extractDir, workflowPath);
    await mkdir(path.dirname(workflowTargetPath), { recursive: true });
    await writeFile(workflowTargetPath, input.repairedWorkflow);
    await tar.create({ gzip: true, file: outputPath, cwd: extractDir }, ["."]);
    const repairedArchive = await readFile(outputPath);
    return {
      archive: repairedArchive,
      digest: createHash("sha256").update(repairedArchive).digest("hex"),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function uploadIsolatedRepairedSourceArchive(input: {
  userId: string;
  sourceRunId: string;
  sourceS3CodeKey: string;
  targetRunId: string;
  workflowPath: string;
  repairedWorkflow: string;
  targetS3CodeKey?: string;
  archiveIO?: ArchiveIO;
}): Promise<{
  s3CodeKey: string;
  objectKey: string;
  digest: string;
}> {
  const archiveIO = input.archiveIO ?? createS3ArchiveIO();
  const sourceS3CodeKey = normalizeRelativePath(input.sourceS3CodeKey);
  const targetS3CodeKey =
    input.targetS3CodeKey ??
    `ricky/attempt-${input.targetRunId}/code.tar.gz`;
  const normalizedTargetKey = normalizeRelativePath(targetS3CodeKey);
  const sourceObjectKey = joinS3Key(input.userId, input.sourceRunId, sourceS3CodeKey);
  const targetObjectKey = joinS3Key(input.userId, input.targetRunId, normalizedTargetKey);

  const sourceArchive = await archiveIO.readObject(sourceObjectKey);
  const repaired = await createRepairedSourceArchive({
    archive: sourceArchive,
    workflowPath: input.workflowPath,
    repairedWorkflow: input.repairedWorkflow,
  });
  await archiveIO.writeObject(targetObjectKey, repaired.archive);

  return {
    s3CodeKey: normalizedTargetKey,
    objectKey: targetObjectKey,
    digest: repaired.digest,
  };
}
