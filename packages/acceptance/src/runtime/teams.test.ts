// @route POST /api/v1/workspaces/[workspaceId]/agents/[agentId]/team
// @route GET /api/v1/workspaces/[workspaceId]/teams
// @route PUT /api/v1/workspaces/[workspaceId]/teams
// @route GET /api/v1/workspaces/[workspaceId]/teams/[teamId]
// @route POST /api/v1/workspaces/[workspaceId]/teams/[teamId]/cancel
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  expectStatus,
  hasUserAuth,
  readJson,
  requestApi,
} from "../helpers/runtime";

const errorResponseSchema = z
  .object({
    error: z.string().min(1),
    code: z.string().min(1).optional(),
  })
  .passthrough();

const teamStatusResponseSchema = z
  .object({
    teamId: z.string().min(1),
    status: z.string().min(1),
    members: z.array(z.unknown()),
    results: z.record(z.string(), z.unknown()),
    summary: z.string(),
  })
  .passthrough();

const teamCancelResponseSchema = z
  .object({
    teamId: z.string().min(1),
    status: z.literal("cancelled"),
  })
  .passthrough();

const teamListResponseSchema = z
  .object({
    teams: z.array(
      z
        .object({
          teamId: z.string().min(1),
          slug: z.string(),
          members: z.array(z.unknown()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const teamBindResponseSchema = z
  .object({
    teamId: z.string().min(1),
    slug: z.string().min(1),
    leadMemberName: z.string().min(1),
    members: z.array(z.unknown()),
  })
  .passthrough();

function workspaceId(): string {
  return process.env.ACCEPTANCE_WORKSPACE_ID?.trim() || "ws_acceptance_missing";
}

describe("/api/v1/workspaces/:workspaceId team routes", () => {
  it("rejects unauthenticated standing team list requests", async () => {
    const response = await requestApi(
      `/api/v1/workspaces/${workspaceId()}/teams`,
    );

    expectStatus(response, [401, 404, 429, 500, 503]);
    if (
      (response.headers.get("content-type") ?? "").includes("application/json")
    ) {
      errorResponseSchema.parse(await readJson(response));
    } else {
      expect((await response.text()).length).toBeGreaterThan(0);
    }
  });

  it("rejects unauthenticated standing team binding requests", async () => {
    const response = await requestApi(
      `/api/v1/workspaces/${workspaceId()}/teams`,
      {
        method: "PUT",
        json: {
          id: "acceptance-team",
          lead: "lead",
          members: [{ name: "lead", persona: { slug: "acceptance-lead" } }],
        },
      },
    );

    expectStatus(response, [401, 404, 429, 500, 503]);
    if (
      (response.headers.get("content-type") ?? "").includes("application/json")
    ) {
      errorResponseSchema.parse(await readJson(response));
    } else {
      expect((await response.text()).length).toBeGreaterThan(0);
    }
  });

  it("rejects unauthenticated team spawn requests", async () => {
    const response = await requestApi(
      `/api/v1/workspaces/${workspaceId()}/agents/agent_missing/team`,
      {
        method: "POST",
        json: { task: "acceptance team route auth probe", members: [] },
      },
    );

    expectStatus(response, [401, 404, 429, 500, 503]);
    if (
      (response.headers.get("content-type") ?? "").includes("application/json")
    ) {
      errorResponseSchema.parse(await readJson(response));
    } else {
      expect((await response.text()).length).toBeGreaterThan(0);
    }
  });

  it("rejects unauthenticated team status reads", async () => {
    const response = await requestApi(
      `/api/v1/workspaces/${workspaceId()}/teams/team_missing`,
    );

    expectStatus(response, [401, 404, 429, 500, 503]);
    if (
      (response.headers.get("content-type") ?? "").includes("application/json")
    ) {
      errorResponseSchema.parse(await readJson(response));
    } else {
      expect((await response.text()).length).toBeGreaterThan(0);
    }
  });

  it("rejects unauthenticated team cancel requests", async () => {
    const response = await requestApi(
      `/api/v1/workspaces/${workspaceId()}/teams/team_missing/cancel`,
      { method: "POST" },
    );

    expectStatus(response, [401, 404, 429, 500, 503]);
    if (
      (response.headers.get("content-type") ?? "").includes("application/json")
    ) {
      errorResponseSchema.parse(await readJson(response));
    } else {
      expect((await response.text()).length).toBeGreaterThan(0);
    }
  });

  const parentAgentId = process.env.ACCEPTANCE_TEAM_PARENT_AGENT_ID?.trim();
  const teamId = process.env.ACCEPTANCE_TEAM_ID?.trim();
  const bindTeamSpec = process.env.ACCEPTANCE_TEAM_BIND_SPEC?.trim();

  (parentAgentId && hasUserAuth() ? it : it.skip)(
    "returns a scoped error or spawn response for the configured parent agent",
    async () => {
      const response = await requestApi(
        `/api/v1/workspaces/${workspaceId()}/agents/${parentAgentId}/team`,
        {
          method: "POST",
          auth: "user",
          json: {
            task: "acceptance team route contract",
            members: [
              {
                name: "impl",
                persona: "cloud-issue-impl",
                role: "worker",
              },
            ],
            ttlSeconds: 300,
          },
        },
      );

      expectStatus(response, [201, 400, 404, 429, 500, 503]);
      expect(response.headers.get("content-type") ?? "").toContain(
        "application/json",
      );
      const body = await readJson<Record<string, unknown>>(response);
      if (response.status === 201) {
        z.object({
          teamId: z.string().min(1),
          channel: z.string().min(1),
          sharedMountRoot: z.string().min(1),
          members: z.array(z.unknown()),
        })
          .passthrough()
          .parse(body);
        return;
      }
      errorResponseSchema.parse(body);
    },
  );

  (hasUserAuth() ? it : it.skip)(
    "lists standing team bindings for the configured workspace",
    async () => {
      const response = await requestApi(
        `/api/v1/workspaces/${workspaceId()}/teams`,
        { auth: "user" },
      );

      expectStatus(response, [200, 403, 404, 429, 500, 503]);
      expect(response.headers.get("content-type") ?? "").toContain(
        "application/json",
      );
      const body = await readJson<Record<string, unknown>>(response);
      if (response.status === 200) {
        teamListResponseSchema.parse(body);
        return;
      }
      errorResponseSchema.parse(body);
    },
  );

  (bindTeamSpec && hasUserAuth() ? it : it.skip)(
    "binds the configured standing team spec",
    async () => {
      const response = await requestApi(
        `/api/v1/workspaces/${workspaceId()}/teams`,
        {
          method: "PUT",
          auth: "user",
          json: JSON.parse(bindTeamSpec),
        },
      );

      expectStatus(response, [200, 403, 404, 409, 422, 429, 500, 503]);
      expect(response.headers.get("content-type") ?? "").toContain(
        "application/json",
      );
      const body = await readJson<Record<string, unknown>>(response);
      if (response.status === 200) {
        teamBindResponseSchema.parse(body);
        return;
      }
      errorResponseSchema.parse(body);
    },
  );

  (teamId && hasUserAuth() ? it : it.skip)(
    "reads the configured team status",
    async () => {
      const response = await requestApi(
        `/api/v1/workspaces/${workspaceId()}/teams/${teamId}`,
        { auth: "user" },
      );

      expectStatus(response, [200, 404, 429, 500, 503]);
      expect(response.headers.get("content-type") ?? "").toContain(
        "application/json",
      );
      const body = await readJson<Record<string, unknown>>(response);
      if (response.status === 200) {
        teamStatusResponseSchema.parse(body);
        return;
      }
      errorResponseSchema.parse(body);
    },
  );

  const cancelTeamId = process.env.ACCEPTANCE_TEAM_CANCEL_ID?.trim();
  (cancelTeamId && hasUserAuth() ? it : it.skip)(
    "cancels the configured non-terminal team",
    async () => {
      const response = await requestApi(
        `/api/v1/workspaces/${workspaceId()}/teams/${cancelTeamId}/cancel`,
        { method: "POST", auth: "user" },
      );

      expectStatus(response, [200, 404, 409, 429, 500, 503]);
      expect(response.headers.get("content-type") ?? "").toContain(
        "application/json",
      );
      const body = await readJson<Record<string, unknown>>(response);
      if (response.status === 200) {
        teamCancelResponseSchema.parse(body);
        return;
      }
      errorResponseSchema.parse(body);
    },
  );
});
