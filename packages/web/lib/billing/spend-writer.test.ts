import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ execute: mocks.execute }),
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: mocks.warn },
}));

import { recordHarnessSpendEvent } from "./spend-writer";

describe("recordHarnessSpendEvent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.execute.mockResolvedValue({ rows: [{ total: "0" }] });
  });

  it("records relay-managed usage with markup", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "7800" }] });

    const result = await recordHarnessSpendEvent({
      providerCredentialId: "credential_1",
      modelProvider: "anthropic",
      authType: "relay_managed",
      userId: "00000000-0000-0000-0000-000000000001",
      model: "claude-sonnet-4-latest",
      inputTokens: 1_000,
      outputTokens: 200,
      occurredAt: new Date("2026-01-15T00:00:00Z"),
    });

    expect(result).toEqual({
      costUsdMicros: 6_000n,
      markupUsdMicros: 1_800n,
    });
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("does not mark up BYOK usage and warns above the monthly soft cap", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "100000001" }] });

    const result = await recordHarnessSpendEvent({
      providerCredentialId: "credential_1",
      modelProvider: "openai",
      authType: "byo_api_key",
      userId: "00000000-0000-0000-0000-000000000001",
      model: "gpt-5",
      inputTokens: 1_000,
      outputTokens: 100,
    });

    expect(result.markupUsdMicros).toBe(0n);
    expect(mocks.warn).toHaveBeenCalledWith(
      "Harness monthly spend soft cap exceeded",
      expect.objectContaining({
        area: "billing-soft-cap",
        currentSpendUsdMicros: "100000001",
      }),
    );
  });
});
