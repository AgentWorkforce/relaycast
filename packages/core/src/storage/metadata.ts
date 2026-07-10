import type { ScopedS3Client } from './client.js';

export interface StepMetadata {
  stepName: string;
  agent: string;
  preset: string;
  cli: string;
  startTime: string; // ISO
  endTime: string; // ISO
  durationMs: number;
  exitCode: number;
  sandboxId: string;
  outputSummary: string; // first 1000 chars
  error?: string;
}

interface StepInput {
  name: string;
  agent?: string;
  preset?: string;
  cli?: string;
}

interface BuildMetadataInput {
  agent?: string;
  preset?: string;
  cli?: string;
  startTime?: string | Date;
  endTime?: string | Date;
  durationMs?: number;
  exitCode?: number;
  sandboxId: string;
  output?: string;
  outputSummary?: string;
  error?: string;
}

function toIsoDate(value: string | Date | number): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toSummary(value: BuildMetadataInput): string {
  const raw = value.outputSummary ?? value.output ?? '';
  return String(raw).slice(0, 1000);
}

/**
 * Build normalized step metadata with bounded summary and derived duration.
 */
export function buildMetadata(step: StepInput, result: BuildMetadataInput): StepMetadata {
  const startTimeRaw = result.startTime ?? new Date();
  const endTimeRaw = result.endTime ?? new Date();

  const startDate = new Date(startTimeRaw);
  const endDate = new Date(endTimeRaw);

  const computedDurationMs = endDate.getTime() - startDate.getTime();
  const durationMs = Number.isFinite(result.durationMs ?? computedDurationMs)
    ? (result.durationMs ?? computedDurationMs)
    : 0;

  return {
    stepName: step.name,
    agent: result.agent ?? step.agent ?? 'unknown',
    preset: result.preset ?? step.preset ?? 'unknown',
    cli: result.cli ?? step.cli ?? 'unknown',
    startTime: toIsoDate(startDate),
    endTime: toIsoDate(endDate),
    durationMs,
    exitCode: result.exitCode ?? 0,
    sandboxId: result.sandboxId,
    outputSummary: toSummary(result),
    error: result.error,
  };
}

/**
 * Write per-sandbox step metadata to `{sandboxId}/metadata.json`.
 */
export async function writeMetadata(
  client: ScopedS3Client,
  sandboxId: string,
  metadata: StepMetadata,
): Promise<void> {
  await client.putObject(
    `${sandboxId}/metadata.json`,
    JSON.stringify(metadata, null, 2),
    'application/json',
  );
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface RunManifest {
  runId: string;
  userId: string;
  workspaceId: string;
  workflowName: string;
  startTime: string; // ISO
  status: RunStatus;
  steps: StepMetadata[];
}

/**
 * Write run-level manifest to `manifest.json` at run root.
 */
export async function writeRunManifest(
  client: ScopedS3Client,
  manifest: RunManifest,
): Promise<void> {
  await client.putObject(
    'manifest.json',
    JSON.stringify(manifest, null, 2),
    'application/json',
  );
}
