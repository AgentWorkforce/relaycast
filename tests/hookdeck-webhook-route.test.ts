import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const {
  captureErrorMock,
  getNangoSecretKeyMock,
  isRickySlackForwardEnvelopeMock,
  loggerInfoMock,
  parseNangoWebhookEnvelopeMock,
  routeNangoWebhookMock,
  verifyNangoWebhookSignatureMock,
} = vi.hoisted(() => ({
  captureErrorMock: vi.fn(),
  getNangoSecretKeyMock: vi.fn(),
  isRickySlackForwardEnvelopeMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  parseNangoWebhookEnvelopeMock: vi.fn(),
  routeNangoWebhookMock: vi.fn(),
  verifyNangoWebhookSignatureMock: vi.fn(),
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  createConnectSession: vi.fn(),
  deleteNangoConnection: vi.fn(),
  getNangoConnection: vi.fn(),
  getNangoSecretKey: getNangoSecretKeyMock,
  triggerNangoSyncs: vi.fn(),
  upsertNangoComposioBridgeConnection: vi.fn(),
}));

vi.mock("@/lib/integrations/nango-webhook-router", () => ({
  isRickySlackForwardEnvelope: isRickySlackForwardEnvelopeMock,
  parseNangoWebhookEnvelope: parseNangoWebhookEnvelopeMock,
  routeNangoWebhook: routeNangoWebhookMock,
  verifyNangoWebhookSignature: verifyNangoWebhookSignatureMock,
}));

vi.mock("@/lib/logger", () => ({
  captureError: captureErrorMock,
  logger: {
    info: loggerInfoMock,
  },
}));

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://cloud.test/api/v1/webhooks/hookdeck", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function nangoSignatureHeaders(): Record<string, string> {
  return { "x-nango-signature": "nango-signature" };
}

function hookdeckSignature(body: unknown, secret: string): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(body), "utf8")
    .digest("base64");
}

function dropboxSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");
}

describe("Hookdeck Nango webhook ingress route", () => {
  const originalHookdeckSecret = process.env.HOOKDECK_SIGNING_SECRET;
  const originalDropboxAppSecret = process.env.DROPBOX_APP_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HOOKDECK_SIGNING_SECRET;
    getNangoSecretKeyMock.mockReturnValue("nango-secret");
    verifyNangoWebhookSignatureMock.mockReturnValue(true);
    parseNangoWebhookEnvelopeMock.mockReturnValue({
      from: "jira-relay",
      type: "forward",
      providerConfigKey: "jira-relay",
      connectionId: "conn-jira-123",
      payload: {},
    });
    routeNangoWebhookMock.mockResolvedValue(undefined);
    loggerInfoMock.mockResolvedValue(undefined);
    captureErrorMock.mockResolvedValue(undefined);
    isRickySlackForwardEnvelopeMock.mockReturnValue(false);
  });

  afterEach(() => {
    if (originalHookdeckSecret === undefined) {
      delete process.env.HOOKDECK_SIGNING_SECRET;
    } else {
      process.env.HOOKDECK_SIGNING_SECRET = originalHookdeckSecret;
    }
    if (originalDropboxAppSecret === undefined) {
      delete process.env.DROPBOX_APP_SECRET;
    } else {
      process.env.DROPBOX_APP_SECRET = originalDropboxAppSecret;
    }
    vi.restoreAllMocks();
  });

  it("echoes Dropbox verification challenges as text/plain with nosniff", async () => {
    const { GET } = await import("../packages/web/app/api/v1/webhooks/hookdeck/route.ts");

    const response = await GET(
      new Request("https://cloud.test/api/v1/webhooks/hookdeck?challenge=dropbox-check-123") as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.text()).resolves.toBe("dropbox-check-123");
  });

  it("returns method-not-allowed for GET requests without a Dropbox challenge", async () => {
    const { GET } = await import("../packages/web/app/api/v1/webhooks/hookdeck/route.ts");

    const response = await GET(
      new Request("https://cloud.test/api/v1/webhooks/hookdeck") as never,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("routes Hookdeck-delivered Nango envelopes through the shared webhook handler", async () => {
    const { POST } = await import("../packages/web/app/api/v1/webhooks/hookdeck/route.ts");

    const response = await POST(request({ type: "forward" }, nangoSignatureHeaders()) as never);

    await expect(response.json()).resolves.toEqual({
      accepted: true,
      type: "forward",
      ingress: "hookdeck",
    });
    expect(response.status).toBe(200);
    expect(routeNangoWebhookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "jira-relay",
        providerConfigKey: "jira-relay",
        connectionId: "conn-jira-123",
      }),
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "Nango webhook received",
      expect.objectContaining({
        ingress: "hookdeck",
        route: "/api/v1/webhooks/hookdeck",
        provider: "jira-relay",
      }),
    );
  });

  it("fails closed for Hookdeck-delivered Nango envelopes when the Nango secret is missing", async () => {
    getNangoSecretKeyMock.mockReturnValue(null);
    const { POST } = await import("../packages/web/app/api/v1/webhooks/hookdeck/route.ts");

    const response = await POST(request({ type: "forward" }, nangoSignatureHeaders()) as never);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Nango webhook secret is not configured",
    });
    expect(verifyNangoWebhookSignatureMock).not.toHaveBeenCalled();
    expect(parseNangoWebhookEnvelopeMock).not.toHaveBeenCalled();
    expect(routeNangoWebhookMock).not.toHaveBeenCalled();
  });

  it("requires a valid Hookdeck signature when the signing secret is configured", async () => {
    process.env.HOOKDECK_SIGNING_SECRET = "hookdeck-test-secret";
    const body = { type: "forward" };
    const { POST } = await import("../packages/web/app/api/v1/webhooks/hookdeck/route.ts");

    const invalid = await POST(
      request(body, { "x-hookdeck-signature": "invalid-signature" }) as never,
    );
    expect(invalid.status).toBe(401);
    await expect(invalid.json()).resolves.toEqual({
      error: "Invalid Hookdeck signature",
    });
    expect(routeNangoWebhookMock).not.toHaveBeenCalled();

    const valid = await POST(
      request(body, {
        "x-hookdeck-signature": hookdeckSignature(body, "hookdeck-test-secret"),
        ...nangoSignatureHeaders(),
      }) as never,
    );
    expect(valid.status).toBe(200);
    expect(routeNangoWebhookMock).toHaveBeenCalledTimes(1);
  });

  it("rejects Dropbox notifications with invalid signatures", async () => {
    process.env.DROPBOX_APP_SECRET = "dropbox-app-secret";
    const { POST } = await import("../packages/web/app/api/v1/webhooks/hookdeck/route.ts");

    const response = await POST(new Request("https://cloud.test/api/v1/webhooks/hookdeck", {
      method: "POST",
      headers: { "x-dropbox-signature": "invalid" },
      body: JSON.stringify({ list_folder: { accounts: ["dbid:1"] } }),
    }) as never);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      accepted: false,
      error: "Invalid Dropbox signature",
    });
    expect(routeNangoWebhookMock).not.toHaveBeenCalled();
  });

  it("accepts signed Dropbox notifications without passing them to the Nango router", async () => {
    process.env.DROPBOX_APP_SECRET = "dropbox-app-secret";
    const rawBody = JSON.stringify({ list_folder: { accounts: ["dbid:1"] } });
    const { POST } = await import("../packages/web/app/api/v1/webhooks/hookdeck/route.ts");

    const response = await POST(new Request("https://cloud.test/api/v1/webhooks/hookdeck", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dropbox-signature": dropboxSignature(rawBody, "dropbox-app-secret"),
      },
      body: rawBody,
    }) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      type: "dropbox",
      ingress: "hookdeck",
      routed: false,
    });
    expect(routeNangoWebhookMock).not.toHaveBeenCalled();
  });
});
