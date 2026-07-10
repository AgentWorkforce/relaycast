import { describe, expect, it } from "vitest";

import { redactBody, redactHeaders, shouldRecord } from "../src/redact.js";

describe("router redaction", () => {
  it("redacts deny-listed and sensitive headers", () => {
    const headers = redactHeaders({
      authorization: "Bearer secret-token",
      "x-api-key": "topsecret",
      "x-signature": "sig-123",
      "content-type": "application/json",
    });

    expect(headers).toEqual({
      authorization: "[REDACTED:19]",
      "x-api-key": "[REDACTED:9]",
      "x-signature": "[REDACTED:7]",
      "content-type": "application/json",
    });
  });

  it("fully redacts bodies for deny-listed paths", () => {
    expect(
      redactBody(
        "/api/v1/workspaces/ws_123/secrets",
        JSON.stringify({ apiKey: "secret-value" }),
        "application/json",
      ),
    ).toBe("[REDACTED:25]");
  });

  it("fully redacts the recorder transcript ingest body (with and without /cloud prefix)", () => {
    const body = JSON.stringify({ transcript_text: "private meeting words", summary_text: "x" });
    expect(redactBody("/api/v1/webhooks/transcripts", body, "application/json")).toBe(
      `[REDACTED:${body.length}]`,
    );
    expect(redactBody("/cloud/api/v1/webhooks/transcripts", body, "application/json")).toBe(
      `[REDACTED:${body.length}]`,
    );
  });

  it("scrubs sensitive keys from JSON bodies", () => {
    expect(
      redactBody(
        "/api/v1/messages",
        JSON.stringify({
          ok: true,
          nested: {
            token: "secret-token",
            profile: {
              password: "swordfish",
            },
          },
          items: [
            {
              refreshToken: "refresh-me",
            },
          ],
        }),
        "application/json; charset=utf-8",
      ),
    ).toBe(
      JSON.stringify({
        ok: true,
        nested: {
          token: "[REDACTED:12]",
          profile: {
            password: "[REDACTED:9]",
          },
        },
        items: [
          {
            refreshToken: "[REDACTED:10]",
          },
        ],
      }),
    );
  });

  it("applies shouldRecord route rules", () => {
    expect(shouldRecord("/favicon.ico")).toBe(false);
    expect(shouldRecord("/api/health")).toBe(false);
    expect(shouldRecord("/observer")).toBe(false);
    expect(shouldRecord("/observer/session/123")).toBe(false);
    expect(shouldRecord("/observer-files")).toBe(true);
    expect(shouldRecord("/cloud/dashboard")).toBe(true);
  });
});
