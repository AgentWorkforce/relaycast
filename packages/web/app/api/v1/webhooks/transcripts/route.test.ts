import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Transcripts ingest: the transcription-worker POSTs an already-transcribed
// granola note here; we write it to the customer workspace VFS + dispatch the
// meeting-actions watch event (delivery half of recall-hookdeck-webhook).

const mocks = vi.hoisted(() => ({
  optionalEnv: vi.fn(),
  tryResourceValue: vi.fn(),
  deliverRecallTranscriptNote: vi.fn(),
  resolveRecallWorkspaceId: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  optionalEnv: mocks.optionalEnv,
  tryResourceValue: mocks.tryResourceValue,
}));

vi.mock("@/lib/integrations/recall-hookdeck-webhook", () => ({
  deliverRecallTranscriptNote: mocks.deliverRecallTranscriptNote,
  resolveRecallWorkspaceId: mocks.resolveRecallWorkspaceId,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn },
}));

import { POST } from "./route";

const TOKEN = "recorder-token";
const WORKSPACE_ID = "rw_relay_123";
const CONNECTION_ID = "conn_recall_123";

function makeRequest(body?: unknown, token: string | null = TOKEN): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new NextRequest("https://app.test/api/v1/webhooks/transcripts", {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const validNote = {
  id: "not_abc",
  object: "note",
  title: "Standup",
  created_at: "2026-06-14T10:00:00.000Z",
  transcript_text: "hello world",
  summary_text: "hello",
  participants: [{ name: "Khaliq" }],
  source: {
    provider: "recall",
    recording_id: "rec_xyz",
    bot_id: null,
    relay_workspace_id: WORKSPACE_ID,
    connection_id: CONNECTION_ID,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tryResourceValue.mockImplementation((name: string) =>
    name === "RecorderTranscribeToken" ? TOKEN : undefined,
  );
  mocks.optionalEnv.mockReturnValue(undefined);
  mocks.resolveRecallWorkspaceId.mockResolvedValue(WORKSPACE_ID);
  mocks.deliverRecallTranscriptNote.mockResolvedValue({
    noteId: "rec_xyz",
    notePath: "/recall/recordings/rec_xyz.json",
  });
});

describe("POST /api/v1/webhooks/transcripts", () => {
  it("503 when the ingest token is not configured", async () => {
    mocks.tryResourceValue.mockReturnValue(undefined);
    mocks.optionalEnv.mockReturnValue(undefined);
    const res = await POST(makeRequest(validNote));
    expect(res.status).toBe(503);
    expect(mocks.deliverRecallTranscriptNote).not.toHaveBeenCalled();
  });

  it("401 on a missing/incorrect bearer", async () => {
    expect((await POST(makeRequest(validNote, null))).status).toBe(401);
    expect((await POST(makeRequest(validNote, "wrong"))).status).toBe(401);
    expect(mocks.deliverRecallTranscriptNote).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON", async () => {
    const req = new NextRequest("https://app.test/api/v1/webhooks/transcripts", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: "{not json",
    });
    expect((await POST(req)).status).toBe(400);
  });

  it("422 when recording id or transcript_text is missing", async () => {
    const res = await POST(makeRequest({ ...validNote, transcript_text: "", source: {} }));
    expect(res.status).toBe(422);
    expect(mocks.deliverRecallTranscriptNote).not.toHaveBeenCalled();
  });

  it("503 when no recall workspace resolves", async () => {
    mocks.resolveRecallWorkspaceId.mockResolvedValue(null);
    const res = await POST(makeRequest(validNote));
    expect(res.status).toBe(503);
    expect(mocks.resolveRecallWorkspaceId).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION_ID,
      accountId: undefined,
    });
    expect(mocks.deliverRecallTranscriptNote).not.toHaveBeenCalled();
  });

  it("delivers the note to the resolved workspace (happy path)", async () => {
    const res = await POST(makeRequest(validNote));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      accepted: true,
      workspace_id: WORKSPACE_ID,
      note_id: "rec_xyz",
      note_path: "/recall/recordings/rec_xyz.json",
    });
    expect(mocks.resolveRecallWorkspaceId).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION_ID,
      accountId: undefined,
    });
    expect(mocks.deliverRecallTranscriptNote).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        connectionId: CONNECTION_ID,
        recordingId: "rec_xyz",
        title: "Standup",
        transcriptText: "hello world",
        summaryText: "hello",
        mode: undefined,
      }),
    );
  });

  it("preserves top-level brainstorm mode for meeting-actions routing", async () => {
    const res = await POST(makeRequest({
      ...validNote,
      mode: "brainstorm",
      source: {
        provider: "recall",
        recording_id: "brainstorm-1781510400000-abcd1234",
        relay_workspace_id: WORKSPACE_ID,
      },
    }));

    expect(res.status).toBe(200);
    expect(mocks.deliverRecallTranscriptNote).toHaveBeenCalledWith(
      expect.objectContaining({
        recordingId: "brainstorm-1781510400000-abcd1234",
        mode: "brainstorm",
      }),
    );
  });

  it("routes distinct relay_workspace_id values to distinct workspaces", async () => {
    mocks.resolveRecallWorkspaceId.mockImplementation(
      async ({ workspaceId }: { workspaceId?: string }) => workspaceId ?? null,
    );

    const first = await POST(makeRequest({
      ...validNote,
      source: { provider: "recall", recording_id: "rec_a", relay_workspace_id: "rw_workspace_a" },
    }));
    const second = await POST(makeRequest({
      ...validNote,
      source: { provider: "recall", recording_id: "rec_b", relay_workspace_id: "rw_workspace_b" },
    }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mocks.deliverRecallTranscriptNote).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceId: "rw_workspace_a",
        connectionId: undefined,
        recordingId: "rec_a",
      }),
    );
    expect(mocks.deliverRecallTranscriptNote).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceId: "rw_workspace_b",
        connectionId: undefined,
        recordingId: "rec_b",
      }),
    );
  });

  it("falls back to note.id for the recording id when source.recording_id is absent", async () => {
    const res = await POST(makeRequest({ ...validNote, source: { provider: "recall" } }));
    expect(res.status).toBe(200);
    expect(mocks.deliverRecallTranscriptNote).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: "not_abc" }),
    );
  });
});
