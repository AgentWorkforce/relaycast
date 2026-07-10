import { describe, expect, it } from "vitest";
import {
  DISABLED_TRANSCRIPTS_INGEST_URL,
  PRODUCTION_TRANSCRIPTS_INGEST_URL,
  resolveTranscriptsIngestUrl,
} from "../infra/transcription-worker-config";

describe("resolveTranscriptsIngestUrl", () => {
  it("defaults production to the real transcripts ingest webhook", () => {
    expect(resolveTranscriptsIngestUrl({ isProd: true, env: {} })).toBe(
      PRODUCTION_TRANSCRIPTS_INGEST_URL,
    );
  });

  it("keeps non-production disabled unless explicitly overridden", () => {
    expect(resolveTranscriptsIngestUrl({ isProd: false, env: {} })).toBe(
      DISABLED_TRANSCRIPTS_INGEST_URL,
    );
  });

  it("allows explicit overrides for dev and staging", () => {
    expect(
      resolveTranscriptsIngestUrl({
        isProd: false,
        env: { TRANSCRIPTS_INGEST_URL: "https://dev.example.test/transcripts" },
      }),
    ).toBe("https://dev.example.test/transcripts");
  });
});
