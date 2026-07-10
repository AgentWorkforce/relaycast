import { describe, expect, it } from "vitest";
import { APP_BASE_PATH } from "@/lib/app-path";
import { buildDeployLoginHref } from "./deploy-login-href";

describe("buildDeployLoginHref", () => {
  it("returns anonymous deploy users to the current persona URL after Google auth", () => {
    const personaUrl = "https://github.com/AgentWorkforce/agents/blob/main/hn-monitor/persona.ts";
    const query = new URLSearchParams({ persona: personaUrl });
    const href = buildDeployLoginHref(
      "/deploy",
      query,
    );

    const expectedNext = encodeURIComponent(`/deploy?${query.toString()}`);
    expect(href).toBe(
      `${APP_BASE_PATH}/api/auth/google/start?next=${expectedNext}`,
    );
  });

  it("strips the app base path before encoding the post-auth deploy target", () => {
    const href = buildDeployLoginHref(
      `${APP_BASE_PATH}/deploy`,
      new URLSearchParams("persona=https%3A%2F%2Fexample.test%2Fpersona.ts&live=1"),
    );

    const expectedNext = encodeURIComponent(
      "/deploy?persona=https%3A%2F%2Fexample.test%2Fpersona.ts&live=1",
    );
    expect(href).toBe(
      `${APP_BASE_PATH}/api/auth/google/start?next=${expectedNext}`,
    );
  });
});
