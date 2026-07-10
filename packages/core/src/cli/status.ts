import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import type { StepMetadata } from "../storage/metadata.js";

type RunStatus = "running" | "completed" | "failed" | "not_found";

export interface RunStatusResult {
  runId: string;
  status: RunStatus;
  workflowName?: string;
  startTime?: string;
  steps: Array<{
    stepName: string;
    agent: string;
    sandboxId: string;
    exitCode: number;
    durationMs: number;
    outputSummary: string;
    error?: string;
  }>;
  logKeys: string[];
}

export interface GetRunStatusOptions {
  bucket: string;
  userId: string;
  runId: string;
  region?: string;
}

interface RunManifestResponse {
  runId?: string;
  workflowName?: string;
  startTime?: string;
  status?: RunStatus;
}

function isNoSuchKeyError(error: unknown): boolean {
  return error instanceof NoSuchKey || (error as { name?: string })?.name === "NoSuchKey";
}

function toRunStatus(value: unknown): RunStatus {
  if (value === "completed" || value === "failed" || value === "running") {
    return value;
  }

  return "running";
}

async function readObjectText(body: NonNullable<GetObjectCommandOutput["Body"]>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf-8");
}

function normalizeStep(metadata: unknown): StepMetadata | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const m = metadata as Partial<StepMetadata>;
  if (typeof m.stepName !== "string" || typeof m.sandboxId !== "string") {
    return null;
  }

  const durationMs =
    typeof m.durationMs === "number" && Number.isFinite(m.durationMs)
      ? m.durationMs
      : 0;
  const exitCode =
    typeof m.exitCode === "number" && Number.isFinite(m.exitCode)
      ? m.exitCode
      : 0;
  const outputSummary = typeof m.outputSummary === "string" ? m.outputSummary : "";
  const agent = typeof m.agent === "string" ? m.agent : "unknown";

  return {
    stepName: m.stepName,
    agent,
    preset: m.preset ?? "unknown",
    cli: m.cli ?? "unknown",
    startTime: m.startTime ?? "",
    endTime: m.endTime ?? "",
    durationMs,
    exitCode,
    sandboxId: m.sandboxId,
    outputSummary,
    ...(typeof m.error === "string" && m.error ? { error: m.error } : {}),
  };
}

export async function getRunStatus(options: GetRunStatusOptions): Promise<RunStatusResult> {
  const region = options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const s3 = new S3Client({
    region: region ?? "us-east-1",
  });

  const runPrefix = `${options.userId}/${options.runId}`;
  const manifestKey = `${runPrefix}/manifest.json`;

  try {
    const manifestResponse = await s3.send(
      new GetObjectCommand({
        Bucket: options.bucket,
        Key: manifestKey,
      }),
    );

    if (!manifestResponse.Body) {
      throw new Error(`manifest response missing body: ${manifestKey}`);
    }

    const manifestText = await readObjectText(manifestResponse.Body);
    let manifest: RunManifestResponse;
    try {
      manifest = JSON.parse(manifestText) as RunManifestResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to parse run manifest ${manifestKey}: ${message}`);
      return {
        runId: options.runId,
        status: "running",
        steps: [],
        logKeys: [],
      };
    }

    const status: RunStatus = toRunStatus(manifest.status);
    const result: RunStatusResult = {
      runId: manifest.runId ?? options.runId,
      status,
      workflowName: manifest.workflowName,
      startTime: manifest.startTime,
      steps: [],
      logKeys: [],
    };

    let continuationToken: string | undefined;
    const metadataKeys: string[] = [];

    do {
      const listResponse = await s3.send(
        new ListObjectsV2Command({
          Bucket: options.bucket,
          Prefix: `${runPrefix}/`,
          ContinuationToken: continuationToken,
        }),
      );

      for (const object of listResponse.Contents ?? []) {
        if (!object.Key) {
          continue;
        }
        if (object.Key.endsWith("/metadata.json")) {
          metadataKeys.push(object.Key);
        }
        if (object.Key.endsWith("/agent.log")) {
          result.logKeys.push(object.Key);
        }
      }

      continuationToken = listResponse.NextContinuationToken;
    } while (continuationToken);

    for (const metadataKey of metadataKeys) {
      if (metadataKey === manifestKey) {
        continue;
      }

      try {
        const metadataResponse = await s3.send(
          new GetObjectCommand({
            Bucket: options.bucket,
            Key: metadataKey,
          }),
        );

        if (!metadataResponse.Body) {
          continue;
        }

        const metadataText = await readObjectText(metadataResponse.Body);
        const parsed = normalizeStep(JSON.parse(metadataText));
        if (!parsed) {
          continue;
        }

        result.steps.push({
          stepName: parsed.stepName,
          agent: parsed.agent,
          sandboxId: parsed.sandboxId,
          exitCode: parsed.exitCode,
          durationMs: parsed.durationMs,
          outputSummary: parsed.outputSummary,
          ...(parsed.error ? { error: parsed.error } : {}),
        });
      } catch (error) {
        // Ignore unreadable metadata files so a malformed step doesn't block status checks.
      }
    }

    result.steps = result.steps.sort((a, b) => {
      if (a.stepName < b.stepName) {
        return -1;
      }
      if (a.stepName > b.stepName) {
        return 1;
      }
      return 0;
    });

    return result;
  } catch (error) {
    if (isNoSuchKeyError(error)) {
      return {
        runId: options.runId,
        status: "not_found",
        steps: [],
        logKeys: [],
      };
    }

    throw error;
  }
}
