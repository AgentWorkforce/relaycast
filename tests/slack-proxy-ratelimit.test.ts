import { beforeEach, describe, expect, it } from "vitest";

import {
  checkSlackProxyRateLimit,
  resetSlackProxyRateLimit,
} from "../packages/web/lib/integrations/slack-proxy-ratelimit";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  resetSlackProxyRateLimit();
});

describe("slack proxy rate limit", () => {
  it("rejects the second same-channel request within 1100ms with channel scope", () => {
    expect(
      checkSlackProxyRateLimit({
        workspaceId: WORKSPACE_ID,
        channel: "C_FIRST",
        now: 1_000,
      }),
    ).toEqual({ ok: true });

    expect(
      checkSlackProxyRateLimit({
        workspaceId: WORKSPACE_ID,
        channel: "C_FIRST",
        now: 2_000,
      }),
    ).toEqual({
      ok: false,
      retryAfterMs: 100,
      scope: "channel",
    });
  });

  it("allows different channels in the same workspace", () => {
    expect(
      checkSlackProxyRateLimit({
        workspaceId: WORKSPACE_ID,
        channel: "C_FIRST",
        now: 10_000,
      }),
    ).toEqual({ ok: true });

    expect(
      checkSlackProxyRateLimit({
        workspaceId: WORKSPACE_ID,
        channel: "C_SECOND",
        now: 10_100,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects the 51st request inside one minute for the same workspace", () => {
    for (let index = 0; index < 50; index += 1) {
      expect(
        checkSlackProxyRateLimit({
          workspaceId: WORKSPACE_ID,
          now: index,
        }),
      ).toEqual({ ok: true });
    }

    expect(
      checkSlackProxyRateLimit({
        workspaceId: WORKSPACE_ID,
        now: 50,
      }),
    ).toEqual({
      ok: false,
      retryAfterMs: 59_950,
      scope: "workspace",
    });
  });

  it("resetSlackProxyRateLimit clears stored state", () => {
    expect(
      checkSlackProxyRateLimit({
        workspaceId: WORKSPACE_ID,
        channel: "C_RESET",
        now: 1_000,
      }),
    ).toEqual({ ok: true });

    expect(
      checkSlackProxyRateLimit({
        workspaceId: WORKSPACE_ID,
        channel: "C_RESET",
        now: 1_500,
      }),
    ).toEqual({
      ok: false,
      retryAfterMs: 600,
      scope: "channel",
    });

    resetSlackProxyRateLimit();

    expect(
      checkSlackProxyRateLimit({
        workspaceId: WORKSPACE_ID,
        channel: "C_RESET",
        now: 1_500,
      }),
    ).toEqual({ ok: true });
  });

  it("uses the explicit now parameter deterministically at the window boundary", () => {
    expect(
      checkSlackProxyRateLimit({
        workspaceId: WORKSPACE_ID,
        channel: "C_BOUNDARY",
        now: 25_000,
      }),
    ).toEqual({ ok: true });

    expect(
      checkSlackProxyRateLimit({
        workspaceId: WORKSPACE_ID,
        channel: "C_BOUNDARY",
        now: 26_100,
      }),
    ).toEqual({ ok: true });
  });
});
