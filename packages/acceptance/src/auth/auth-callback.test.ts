// @route GET /api/auth/callback/google

import { z } from "zod";
import { describe, expect, it } from "vitest";
import { findSetCookie } from "../../helpers/auth";
import { request } from "../../helpers/server";

const redirectSchema = z.string().url();

describe("/api/auth/callback/google", () => {
  it("GET /api/auth/callback/google rejects missing or mismatched state with a state redirect", async () => {
    const response = await request("GET", "/api/auth/callback/google", {
      redirect: "manual",
    });

    expect(response.status).toBe(307);

    const location = redirectSchema.parse(response.headers.get("location"));
    expect(new URL(location).searchParams.get("authError")).toBe("state");
  });

  it("GET /api/auth/callback/google redirects with authError=google when code exchange fails", async () => {
    const response = await request(
      "GET",
      "/api/auth/callback/google?code=bogus-code&state=acceptance-state",
      {
        redirect: "manual",
        headers: {
          cookie: [
            "agent_relay_google_state=acceptance-state",
            "agent_relay_post_auth_next=%2Fdashboard",
          ].join("; "),
        },
      },
    );

    expect(response.status).toBe(307);

    const location = redirectSchema.parse(response.headers.get("location"));
    expect(new URL(location).searchParams.get("authError")).toBe("google");
  });

  // The happy path requires a real, single-use Google authorization code: the
  // server exchanges `code` with Google's token endpoint server-side, so no
  // recorded fixture can stand in for it in this black-box suite. To run this
  // test, complete the Google consent flow for an internal-tester account
  // with the redirect intercepted (e.g. devtools network pause on the
  // /api/auth/callback/google request), then within the code's TTL export:
  //   ACCEPTANCE_GOOGLE_OAUTH_CODE  — the `code` query param from the redirect
  //   ACCEPTANCE_GOOGLE_OAUTH_STATE — the matching `state` query param
  const googleOauthCode = env("ACCEPTANCE_GOOGLE_OAUTH_CODE");
  const googleOauthState = env("ACCEPTANCE_GOOGLE_OAUTH_STATE");
  (googleOauthCode && googleOauthState ? it : it.skip)(
    "GET /api/auth/callback/google happy path issues a session and redirects to the post-auth next path",
    async () => {
      const query = new URLSearchParams({
        code: String(googleOauthCode),
        state: String(googleOauthState),
      });
      const response = await request(
        "GET",
        `/api/auth/callback/google?${query.toString()}`,
        {
          redirect: "manual",
          headers: {
            cookie: [
              `agent_relay_google_state=${googleOauthState}`,
              "agent_relay_post_auth_next=%2Fdashboard",
            ].join("; "),
          },
        },
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/dashboard");
      expect(findSetCookie(response, "agent_relay_session")).toBeTruthy();
    },
  );

  // Not covered here: the `authError=schema` redirect. That branch only fires
  // when the deployment's database is missing the `auth_identities` table
  // *and* the Google code exchange succeeded first — a mis-migrated
  // deployment state that a black-box suite pointed at a healthy environment
  // can never observe. Coverage for it belongs in an in-process handler test
  // where the database can be faked.
});

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
