import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { optionalEnv, tryResourceValue } from "@/lib/env";
import {
  deliverRecallTranscriptNote,
  resolveRecallWorkspaceId,
} from "@/lib/integrations/recall-hookdeck-webhook";
import { logger } from "@/lib/logger";

/**
 * Transcripts ingest — the last-mile link for the desktop recorder's bot-free
 * path. The transcription-worker (Cloudflare) transcribes a Recall recording
 * via Modal NB-Whisper, then POSTs the resulting granola-shaped note here. We
 * write it into the customer workspace VFS at `/recall/recordings/<id>.json`
 * and dispatch the meeting-actions watch event — the same delivery the hookdeck
 * webhook does, minus transcription (the worker already did it).
 *
 * Auth: the shared RecorderTranscribeToken (the same token the recorder uses
 * for /transcribe + /recall/create-upload), presented as a Bearer.
 *
 * Workspace routing is tenant-scoped when the worker forwards Recall source
 * identity from webhook/recording metadata: relay_workspace_id is validated
 * against the Recall workspace integration row, with RECALL_WORKSPACE_ID only
 * as an optional single-tenant override/fallback.
 */

type IngestNote = {
  id?: unknown;
  mode?: unknown;
  title?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  web_url?: unknown;
  participants?: unknown;
  transcript_text?: unknown;
  summary_text?: unknown;
  source?: {
    recording_id?: unknown;
    relay_workspace_id?: unknown;
    connection_id?: unknown;
    recall_connection_id?: unknown;
    account_id?: unknown;
    recall_account_id?: unknown;
  } | null;
};

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getIngestToken(): string | null {
  return (
    tryResourceValue("RecorderTranscribeToken") ??
    optionalEnv("RECORDER_TRANSCRIBE_TOKEN") ??
    null
  );
}

/** Constant-time bearer compare to avoid leaking the token via timing. */
function bearerMatches(header: string | null, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const want = Buffer.from(expected);
  if (provided.length !== want.length) return false;
  return timingSafeEqual(provided, want);
}

export async function POST(request: NextRequest) {
  const expected = getIngestToken();
  if (!expected) {
    await logger.warn("transcripts ingest not configured (no RecorderTranscribeToken)", {
      area: "transcripts-ingest",
    });
    return NextResponse.json(
      { accepted: false, error: "Transcripts ingest not configured" },
      { status: 503 },
    );
  }
  if (!bearerMatches(request.headers.get("authorization"), expected)) {
    return NextResponse.json({ accepted: false, error: "Unauthorized" }, { status: 401 });
  }

  let note: IngestNote;
  try {
    note = (await request.json()) as IngestNote;
  } catch {
    return NextResponse.json({ accepted: false, error: "Invalid JSON" }, { status: 400 });
  }

  const recordingId = readString(note.source?.recording_id) ?? readString(note.id);
  const transcriptText = readString(note.transcript_text);
  if (!recordingId || !transcriptText) {
    return NextResponse.json(
      { accepted: false, error: "Missing recording id or transcript_text" },
      { status: 422 },
    );
  }

  const sourceConnectionId =
    readString(note.source?.recall_connection_id) ?? readString(note.source?.connection_id);
  const sourceAccountId =
    readString(note.source?.recall_account_id) ?? readString(note.source?.account_id);
  const sourceWorkspaceId = readString(note.source?.relay_workspace_id);
  const workspaceId = await resolveRecallWorkspaceId({
    workspaceId: sourceWorkspaceId,
    connectionId: sourceConnectionId,
    accountId: sourceAccountId,
  });
  if (!workspaceId) {
    await logger.warn("transcripts ingest: no recall workspace configured", {
      area: "transcripts-ingest",
      recordingId,
      hasWorkspaceId: Boolean(sourceWorkspaceId),
      hasConnectionId: Boolean(sourceConnectionId),
      hasAccountId: Boolean(sourceAccountId),
    });
    return NextResponse.json(
      { accepted: false, error: "No recall workspace configured" },
      { status: 503 },
    );
  }

  const participants = Array.isArray(note.participants) ? note.participants : [];
  const mode = readString(note.mode);
  const { noteId, notePath } = await deliverRecallTranscriptNote({
    workspaceId,
    connectionId: sourceConnectionId,
    recordingId,
    deliveryId: `transcripts-ingest-${recordingId}`,
    title: readString(note.title) ?? "Meeting",
    createdAt: readString(note.created_at) ?? null,
    updatedAt: readString(note.updated_at) ?? null,
    webUrl: readString(note.web_url) ?? "",
    participants,
    transcriptText,
    summaryText: readString(note.summary_text) ?? transcriptText,
    mode,
  });

  await logger.info("transcripts ingest processed", {
    area: "transcripts-ingest",
    workspaceId,
    recordingId,
    noteId,
    transcriptChars: transcriptText.length,
  });

  return NextResponse.json({
    accepted: true,
    workspace_id: workspaceId,
    note_id: noteId,
    note_path: notePath,
    transcript_chars: transcriptText.length,
  });
}
