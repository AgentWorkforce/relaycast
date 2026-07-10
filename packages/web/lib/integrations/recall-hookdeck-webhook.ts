import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { dispatchIntegrationWatchEvent } from "@/lib/proactive-runtime/integration-watch-dispatcher";
import { logger } from "@/lib/logger";
import { claimWebhookDelivery, releaseWebhookDelivery } from "@/lib/ricky/webhook-dedup";
import {
  findWorkspaceIntegrationByConnection,
  listWorkspaceIntegrationsForProvider,
} from "@/lib/integrations/workspace-integrations";
import { createGitHubRelayfileClient } from "@/lib/integrations/github-relayfile";
import { optionalEnv, tryResourceValue } from "@/lib/env";

const RECALL_PROVIDER = "recall" as const;
const RECALL_API_BASE_DEFAULT = "https://us-west-2.recall.ai";
// Svix's documented default tolerance for webhook-timestamp skew/replay.
const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

// Recall uses Svix to sign webhooks. We detect them by the body's `event` field
// starting with "sdk_upload". Two verification layers apply: the Hookdeck
// signature (verified upstream in the route handler) and Recall's own Svix
// workspace signature (verified here when RecallWorkspaceVerificationSecret
// is configured — see verifyRecallSvixSignature).
type RecallHookdeckResult =
  | { handled: false }
  | { handled: true; response: NextResponse };

type RecallWebhookPayload = {
  event?: string;
  data?: {
    data?: {
      code?: string | null;
      sub_code?: string | null;
      updated_at?: string | null;
    };
    id?: string;
    recording_id?: string;
    object?: {
      id?: string;
      recording_id?: string | null;
      created_at?: string | null;
      status?: { code?: string | null } | null;
    };
    recording?: { id?: string; metadata?: Record<string, unknown> };
    sdk_upload?: { id?: string; metadata?: Record<string, unknown> };
    bot?: { id?: string; metadata?: Record<string, unknown> };
    metadata?: Record<string, unknown>;
  };
};

type RecallRecording = {
  id?: string;
  started_at?: string;
  ended_at?: string;
  meeting_metadata?: {
    title?: string;
    meeting_url?: string;
  };
  metadata?: Record<string, unknown> | null;
  desktop_sdk_upload?: { id?: string | null; metadata?: Record<string, unknown> | null } | null;
  participants?: unknown[];
  meeting_participants?: unknown[];
  media_shortcuts?: {
    audio_mixed?: { data?: { download_url?: string } };
    video_mixed?: { data?: { download_url?: string } };
  };
};

type RecallWorkspaceResolutionInput = {
  workspaceId?: string | null;
  connectionId?: string | null;
  accountId?: string | null;
};

type RecallSourceIdentity = {
  workspaceId?: string;
  connectionId?: string;
  accountId?: string;
};

export const RECALL_RELAY_WORKSPACE_METADATA_KEY = "relay_workspace_id";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringKey(
  record: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) return value;
  }
  return undefined;
}

const RECALL_CONNECTION_METADATA_KEYS = [
  "recall_connection_id",
  "recallConnectionId",
  "connection_id",
  "connectionId",
  "nango_connection_id",
  "nangoConnectionId",
] as const;

const RECALL_WORKSPACE_METADATA_KEYS = [
  RECALL_RELAY_WORKSPACE_METADATA_KEY,
  "relayWorkspaceId",
] as const;

const RECALL_ACCOUNT_METADATA_KEYS = [
  "recall_account_id",
  "recallAccountId",
  "account_id",
  "accountId",
  "workspace_account_id",
  "workspaceAccountId",
] as const;

function extractRecallSourceIdentity(
  ...records: Array<Record<string, unknown> | null | undefined>
): RecallSourceIdentity {
  for (const record of records) {
    const workspaceId = readStringKey(record, RECALL_WORKSPACE_METADATA_KEYS);
    if (workspaceId) {
      return {
        workspaceId,
        connectionId: readStringKey(record, RECALL_CONNECTION_METADATA_KEYS),
        accountId: readStringKey(record, RECALL_ACCOUNT_METADATA_KEYS),
      };
    }
  }

  for (const record of records) {
    const connectionId = readStringKey(record, RECALL_CONNECTION_METADATA_KEYS);
    if (connectionId) {
      return {
        connectionId,
        accountId: readStringKey(record, RECALL_ACCOUNT_METADATA_KEYS),
      };
    }
  }

  for (const record of records) {
    const accountId = readStringKey(record, RECALL_ACCOUNT_METADATA_KEYS);
    if (accountId) return { accountId };
  }

  return {};
}

function mergeRecallSourceIdentity(
  ...identities: RecallSourceIdentity[]
): RecallSourceIdentity {
  return identities.reduce<RecallSourceIdentity>(
    (merged, identity) => ({
      workspaceId: identity.workspaceId ?? merged.workspaceId,
      connectionId: identity.connectionId ?? merged.connectionId,
      accountId: identity.accountId ?? merged.accountId,
    }),
    {},
  );
}

function payloadSourceIdentity(payload: RecallWebhookPayload): RecallSourceIdentity {
  return extractRecallSourceIdentity(
    payload.data?.metadata,
    payload.data?.recording?.metadata,
    payload.data?.sdk_upload?.metadata,
    payload.data?.bot?.metadata,
  );
}

function sdkUploadCompleteRecordingId(payload: RecallWebhookPayload): string | undefined {
  return (
    readString(payload.data?.recording?.id) ??
    readString(payload.data?.object?.recording_id) ??
    readString(payload.data?.recording_id) ??
    readString(payload.data?.id)
  );
}

function recordingSourceIdentity(recording: RecallRecording): RecallSourceIdentity {
  return extractRecallSourceIdentity(
    recording.metadata,
    recording.desktop_sdk_upload?.metadata,
  );
}

export function looksLikeRecallWebhook(rawBody: string): boolean {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!isRecord(parsed)) return false;
    const event = readString(parsed.event);
    return Boolean(event && event.startsWith("sdk_upload"));
  } catch {
    return false;
  }
}

function getRecallApiKey(): string | null {
  return tryResourceValue("RecallApiKey") ?? optionalEnv("RECALL_API_KEY") ?? null;
}

function getRecallWorkspaceVerificationSecret(): string | null {
  const value =
    tryResourceValue("RecallWorkspaceVerificationSecret") ??
    optionalEnv("RECALL_WORKSPACE_VERIFICATION_SECRET") ??
    null;
  return value && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Verify Recall's Svix webhook signature.
 *
 * Svix signs `${webhook-id}.${webhook-timestamp}.${rawBody}` with
 * HMAC-SHA256 keyed by the base64-decoded workspace secret (the `whsec_`
 * prefix is not part of the key). The `webhook-signature` header carries
 * space-delimited `v1,<base64sig>` entries; the delivery is authentic when
 * any entry matches under a timing-safe comparison.
 */
export function verifyRecallSvixSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
): boolean {
  const webhookId = headers.get("webhook-id");
  const webhookTimestamp = headers.get("webhook-timestamp");
  const signatureHeader = headers.get("webhook-signature");
  if (!webhookId || !webhookTimestamp || !signatureHeader) return false;

  const timestampSeconds = Number(webhookTimestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const skewSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
  if (skewSeconds > SVIX_TIMESTAMP_TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (key.length === 0) return false;

  const expected = createHmac("sha256", key)
    .update(`${webhookId}.${webhookTimestamp}.${rawBody}`, "utf8")
    .digest();

  for (const entry of signatureHeader.split(" ")) {
    const commaIndex = entry.indexOf(",");
    if (commaIndex === -1) continue;
    if (entry.slice(0, commaIndex) !== "v1") continue;
    const candidate = Buffer.from(entry.slice(commaIndex + 1), "base64");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return true;
    }
  }
  return false;
}

function getRecallApiBase(): string {
  return (
    tryResourceValue("RecallApiBase") ??
    optionalEnv("RECALL_API_BASE") ??
    RECALL_API_BASE_DEFAULT
  ).replace(/\/+$/, "");
}

function getNbWhisperUrl(): string | null {
  return tryResourceValue("NbWhisperUrl") ?? optionalEnv("NB_WHISPER_URL") ?? null;
}

function getNbWhisperToken(): string | null {
  return tryResourceValue("NbWhisperToken") ?? optionalEnv("NB_WHISPER_TOKEN") ?? null;
}

async function fetchRecordingFromRecall(
  recordingId: string,
  apiKey: string,
  apiBase: string,
): Promise<RecallRecording | null> {
  const res = await fetch(`${apiBase}/api/v1/recording/${recordingId}/`, {
    headers: { authorization: `Token ${apiKey}` },
  });
  if (!res.ok) {
    await logger.warn("Recall recording fetch failed", {
      area: "recall-webhook",
      recordingId,
      status: res.status,
    });
    return null;
  }
  return res.json() as Promise<RecallRecording>;
}

async function transcribeWithNbWhisper(
  audioUrl: string,
  whisperUrl: string,
  whisperToken: string,
): Promise<string | null> {
  const audioResponse = await fetch(audioUrl);
  if (!audioResponse.ok) {
    await logger.warn("Recall audio download failed", {
      area: "recall-webhook",
      status: audioResponse.status,
    });
    return null;
  }
  const audio = await audioResponse.arrayBuffer();
  const base = whisperUrl.replace(/\/+$/, "");
  const url = base.includes("?") ? base : `${base}?language=no`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${whisperToken}`,
      "content-type": audioResponse.headers.get("content-type") ?? "audio/wav",
    },
    body: audio,
  });
  if (!res.ok) {
    await logger.warn("NB-Whisper transcription failed", {
      area: "recall-webhook",
      status: res.status,
      responseText: await res.text().catch(() => "(unreadable)"),
    });
    return null;
  }
  const json = (await res.json()) as { text?: string };
  return readString(json.text) ?? null;
}

export async function resolveRecallWorkspaceId(
  input: RecallWorkspaceResolutionInput = {},
): Promise<string | null> {
  const workspaceId = readString(input.workspaceId);
  if (workspaceId) return workspaceId;

  const connectionId = readString(input.connectionId);
  if (connectionId) {
    try {
      const integration = await findWorkspaceIntegrationByConnection(
        RECALL_PROVIDER,
        connectionId,
      );
      if (integration?.workspaceId) return integration.workspaceId;
    } catch {
      return null;
    }
  }

  const accountId = readString(input.accountId);
  if (accountId) {
    try {
      const integrations = await listWorkspaceIntegrationsForProvider(RECALL_PROVIDER);
      const integration = integrations.find((candidate) =>
        RECALL_ACCOUNT_METADATA_KEYS.some(
          (key) => readString(candidate.metadata[key]) === accountId,
        ),
      );
      if (integration?.workspaceId) return integration.workspaceId;
    } catch {
      return null;
    }
  }

  // Optional single-tenant override/fallback for break-glass deployments only.
  const fromEnv =
    tryResourceValue("RecallWorkspaceId") ??
    optionalEnv("RECALL_WORKSPACE_ID") ??
    null;
  return readString(fromEnv) ?? null;
}

/**
 * Writes a transcribed recording note to the workspace VFS at
 * `/recall/recordings/<id>.json` and dispatches the meeting-actions watch event.
 * Shared by the hookdeck webhook (transcribes inline via NB-Whisper) and the
 * transcripts-ingest route (receives an already-transcribed note from the
 * transcription worker). Single source of truth for the VFS note shape.
 */
export async function deliverRecallTranscriptNote(input: {
  workspaceId: string;
  connectionId?: string | null;
  recordingId: string;
  deliveryId: string;
  title: string;
  transcriptText: string;
  summaryText?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  webUrl?: string;
  participants?: unknown[];
  mode?: string;
}): Promise<{ noteId: string; notePath: string }> {
  const noteId =
    input.recordingId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || input.recordingId;
  const noteRecord = {
    id: noteId,
    recording_id: noteId,
    object: "recording",
    title: input.title || "Meeting",
    created_at: input.createdAt ?? new Date().toISOString(),
    updated_at: input.updatedAt ?? null,
    web_url: input.webUrl ?? "",
    participants: input.participants ?? [],
    transcript_text: input.transcriptText,
    summary_text: input.summaryText ?? input.transcriptText,
    ...(input.mode ? { mode: input.mode } : {}),
  };
  const notePath = `/recall/recordings/${noteId}.json`;

  const client = createGitHubRelayfileClient(input.workspaceId);
  await client.bulkWrite({
    workspaceId: input.workspaceId,
    files: [
      {
        path: notePath,
        contentType: "application/json",
        content: JSON.stringify(noteRecord, null, 2),
      },
    ],
  });

  await dispatchIntegrationWatchEvent({
    workspaceId: input.workspaceId,
    provider: RECALL_PROVIDER,
    eventType: "recording.complete",
    connectionId: readString(input.connectionId) ?? input.workspaceId,
    deliveryId: input.deliveryId,
    paths: [notePath],
    payload: noteRecord,
  });

  return { noteId, notePath };
}

export async function handleRecallHookdeckWebhook(
  rawBody: string,
  headers: Headers,
): Promise<RecallHookdeckResult> {
  // Verify Recall's Svix workspace signature before any processing. The raw
  // body string is used exactly as received — re-serializing would break the
  // HMAC. When the secret is unset (e.g. stages where the operator has not
  // configured it yet) we keep the pre-existing behavior and rely on the
  // upstream Hookdeck signature alone, with a warning for visibility.
  const verificationSecret = getRecallWorkspaceVerificationSecret();
  if (verificationSecret) {
    if (!verifyRecallSvixSignature(rawBody, headers, verificationSecret)) {
      await logger.warn("Recall webhook rejected: Svix signature verification failed", {
        area: "recall-webhook",
        hasWebhookId: Boolean(headers.get("webhook-id")),
        hasTimestamp: Boolean(headers.get("webhook-timestamp")),
        hasSignature: Boolean(headers.get("webhook-signature")),
      });
      return {
        handled: true,
        response: NextResponse.json(
          { accepted: false, error: "Invalid webhook signature" },
          { status: 401 },
        ),
      };
    }
  } else {
    await logger.warn(
      "RecallWorkspaceVerificationSecret not configured — processing webhook without Svix verification",
      { area: "recall-webhook" },
    );
  }

  let payload: RecallWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as RecallWebhookPayload;
  } catch {
    return {
      handled: true,
      response: NextResponse.json(
        { accepted: false, error: "Invalid Recall webhook JSON" },
        { status: 400 },
      ),
    };
  }

  const event = readString(payload.event);
  if (!event) {
    return { handled: false };
  }
  const inboundSourceIdentity = payloadSourceIdentity(payload);

  if (event !== "sdk_upload.complete") {
    await logger.info("Recall webhook ignored", { area: "recall-webhook", event });
    return {
      handled: true,
      response: NextResponse.json({ accepted: true, ignored: event }),
    };
  }

  const recordingId = sdkUploadCompleteRecordingId(payload);
  if (!recordingId) {
    await logger.warn("Recall sdk_upload.complete missing recording id", {
      area: "recall-webhook",
    });
    return {
      handled: true,
      response: NextResponse.json(
        { accepted: false, error: "Missing recording id" },
        { status: 422 },
      ),
    };
  }

  const deliveryId = `recall-${recordingId}`;
  const claimed = await claimWebhookDelivery({ surface: "recall", deliveryId });
  if (!claimed) {
    await logger.info("Recall webhook dedupe hit", { area: "recall-webhook", recordingId });
    return {
      handled: true,
      response: NextResponse.json({ accepted: true, deduped: true }),
    };
  }

  try {
    const apiKey = getRecallApiKey();
    if (!apiKey) {
      await logger.warn("Recall API key not configured", { area: "recall-webhook" });
      await releaseWebhookDelivery({ surface: "recall", deliveryId });
      return {
        handled: true,
        response: NextResponse.json(
          { accepted: false, error: "Recall API key not configured" },
          { status: 503 },
        ),
      };
    }

    const whisperUrl = getNbWhisperUrl();
    const whisperToken = getNbWhisperToken();
    if (!whisperUrl || !whisperToken) {
      await logger.warn("NB-Whisper not configured", { area: "recall-webhook" });
      await releaseWebhookDelivery({ surface: "recall", deliveryId });
      return {
        handled: true,
        response: NextResponse.json(
          { accepted: false, error: "NB-Whisper not configured" },
          { status: 503 },
        ),
      };
    }

    const apiBase = getRecallApiBase();
    const recording = await fetchRecordingFromRecall(recordingId, apiKey, apiBase);
    if (!recording) {
      await releaseWebhookDelivery({ surface: "recall", deliveryId });
      return {
        handled: true,
        response: NextResponse.json(
          { accepted: false, error: "Failed to fetch recording" },
          { status: 502 },
        ),
      };
    }
    const sourceIdentity = mergeRecallSourceIdentity(
      inboundSourceIdentity,
      recordingSourceIdentity(recording),
    );
    const workspaceId = await resolveRecallWorkspaceId(sourceIdentity);
    if (!workspaceId) {
      await logger.warn("No recall workspace configured", {
        area: "recall-webhook",
        recordingId,
        hasConnectionId: Boolean(sourceIdentity.connectionId),
        hasAccountId: Boolean(sourceIdentity.accountId),
      });
      await releaseWebhookDelivery({ surface: "recall", deliveryId });
      return {
        handled: true,
        response: NextResponse.json(
          { accepted: false, error: "No recall workspace configured" },
          { status: 503 },
        ),
      };
    }

    const audioUrl =
      recording.media_shortcuts?.audio_mixed?.data?.download_url ??
      recording.media_shortcuts?.video_mixed?.data?.download_url;
    if (!audioUrl) {
      await logger.warn("Recall recording has no audio URL", {
        area: "recall-webhook",
        recordingId,
      });
      await releaseWebhookDelivery({ surface: "recall", deliveryId });
      return {
        handled: true,
        response: NextResponse.json(
          { accepted: false, error: "No audio download URL on recording" },
          { status: 422 },
        ),
      };
    }

    const transcriptText = await transcribeWithNbWhisper(audioUrl, whisperUrl, whisperToken);
    if (!transcriptText) {
      await releaseWebhookDelivery({ surface: "recall", deliveryId });
      return {
        handled: true,
        response: NextResponse.json(
          { accepted: false, error: "Transcription failed" },
          { status: 502 },
        ),
      };
    }

    const { noteId } = await deliverRecallTranscriptNote({
      workspaceId,
      connectionId: sourceIdentity.connectionId,
      recordingId,
      deliveryId,
      title: recording.meeting_metadata?.title ?? "Meeting",
      createdAt: recording.started_at ?? null,
      updatedAt: recording.ended_at ?? null,
      webUrl: recording.meeting_metadata?.meeting_url ?? "",
      participants: recording.participants ?? recording.meeting_participants ?? [],
      transcriptText,
      summaryText: transcriptText,
    });

    await logger.info("Recall webhook processed", {
      area: "recall-webhook",
      workspaceId,
      recordingId,
      noteId,
      transcriptChars: transcriptText.length,
    });

    return {
      handled: true,
      response: NextResponse.json({
        accepted: true,
        recording_id: recordingId,
        note_id: noteId,
        transcript_chars: transcriptText.length,
      }),
    };
  } catch (error) {
    await releaseWebhookDelivery({ surface: "recall", deliveryId }).catch(() => undefined);
    throw error;
  }
}
