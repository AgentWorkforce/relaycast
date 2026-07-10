import { describe, expect, it, vi } from "vitest";

import type { LinearIntegration } from "./linear-api-client.js";
import { createLinearLibrarianApiFallback } from "./linear-api-fallback.js";

type ListIssuesArgs = Parameters<LinearIntegration["listIssues"]>;
type ListIssuesReturn = ReturnType<LinearIntegration["listIssues"]>;
type SearchIssuesArgs = Parameters<LinearIntegration["searchIssues"]>;
type SearchIssuesReturn = ReturnType<LinearIntegration["searchIssues"]>;
type GetIssueArgs = Parameters<LinearIntegration["getIssue"]>;
type GetIssueReturn = ReturnType<LinearIntegration["getIssue"]>;
type ListProjectsArgs = Parameters<LinearIntegration["listProjects"]>;
type ListProjectsReturn = ReturnType<LinearIntegration["listProjects"]>;
type ListCommentsArgs = Parameters<LinearIntegration["listComments"]>;
type ListCommentsReturn = ReturnType<LinearIntegration["listComments"]>;

type LinearIssueFixture = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  updatedAt: string;
  createdAt: string;
  state: {
    name: string;
    type: string;
  };
  team: {
    id: string;
    key: string;
    name: string;
  };
  assignee: {
    id: string;
    name: string;
    email: string;
  };
  priority: number;
  labels: Array<{ name: string }>;
  project: {
    id: string;
    name: string;
  };
};

function createIssue(index: number): LinearIssueFixture {
  return {
    id: `issue-${index}`,
    identifier: `ENG-${index}`,
    title: `Linear issue ${index}`,
    url: `https://linear.example.test/ENG-${index}`,
    updatedAt: `2026-04-${String(index).padStart(2, "0")}T12:00:00.000Z`,
    createdAt: `2026-03-${String(index).padStart(2, "0")}T12:00:00.000Z`,
    state: {
      name: "In Progress",
      type: "started",
    },
    team: {
      id: `team-${index}`,
      key: `TEAM${index}`,
      name: `Team ${index}`,
    },
    assignee: {
      id: `user-${index}`,
      name: `Assignee ${index}`,
      email: `assignee-${index}@example.test`,
    },
    priority: 2,
    labels: [{ name: `label-${index}` }, { name: "shared" }],
    project: {
      id: `project-${index}`,
      name: `Project ${index}`,
    },
  };
}

function createLinearIntegration(overrides?: {
  listIssues?: ReturnType<typeof vi.fn<ListIssuesArgs, ListIssuesReturn>>;
  searchIssues?: ReturnType<typeof vi.fn<SearchIssuesArgs, SearchIssuesReturn>>;
}) {
  const listIssues =
    overrides?.listIssues
    ?? vi.fn<ListIssuesArgs, ListIssuesReturn>().mockResolvedValue({
      data: [],
      source: "linear.cloud.nango",
      timestamp: "2026-04-26T12:00:00.000Z",
    });
  const searchIssues =
    overrides?.searchIssues
    ?? vi.fn<SearchIssuesArgs, SearchIssuesReturn>().mockResolvedValue({
      data: { items: [] },
      source: "linear.cloud.nango",
      timestamp: "2026-04-26T12:00:00.000Z",
    });

  const getIssue = vi.fn<GetIssueArgs, GetIssueReturn>().mockResolvedValue({
    data: null,
    source: "linear.cloud.nango",
    timestamp: "2026-04-26T12:00:00.000Z",
  });
  const listProjects = vi.fn<ListProjectsArgs, ListProjectsReturn>().mockResolvedValue({
    data: [],
    source: "linear.cloud.nango",
    timestamp: "2026-04-26T12:00:00.000Z",
  });
  const listComments = vi
    .fn<ListCommentsArgs, ListCommentsReturn>()
    .mockResolvedValue({
      data: [],
      source: "linear.cloud.nango",
      timestamp: "2026-04-26T12:00:00.000Z",
    });

  const integration: LinearIntegration = {
    listIssues,
    searchIssues,
    getIssue,
    listProjects,
    listComments,
  };

  return {
    integration,
    listIssues,
    searchIssues,
  };
}

function expectedIssueProperties(issue: LinearIssueFixture): Record<string, string> {
  return {
    state: "open",
    team: issue.team.name,
    assignee: issue.assignee.name,
    priority: String(issue.priority),
    labels: JSON.stringify(issue.labels.map((label) => label.name)),
    project: issue.project.name,
    updatedAt: issue.updatedAt,
  };
}

describe("createLinearLibrarianApiFallback", () => {
  it("returns all listIssues results and maps their properties", async () => {
    const issues = Array.from({ length: 5 }, (_, index) => createIssue(index + 1));
    const { integration } = createLinearIntegration({
      listIssues: vi
        .fn<ListIssuesArgs, ListIssuesReturn>()
        .mockResolvedValue({
          data: issues,
          source: "linear.cloud.nango",
          timestamp: "2026-04-26T12:00:00.000Z",
        }),
    });
    const fallback = createLinearLibrarianApiFallback(integration);

    const entries = await fallback({
      instruction: "List current open Linear issues",
      text: "show me current open Linear issues",
      filters: { state: ["open"] },
      types: ["issue"],
    });

    expect(entries).toHaveLength(5);
    for (const [index, entry] of entries.entries()) {
      expect(entry.properties).toEqual(
        expect.objectContaining(expectedIssueProperties(issues[index]!)),
      );
    }
  });

  it("passes structured state filters through to listIssues", async () => {
    const listIssues = vi.fn<ListIssuesArgs, ListIssuesReturn>().mockResolvedValue({
      data: [createIssue(1)],
      source: "linear.cloud.nango",
      timestamp: "2026-04-26T12:00:00.000Z",
    });
    const { integration } = createLinearIntegration({ listIssues });
    const fallback = createLinearLibrarianApiFallback(integration);

    await fallback({
      instruction: "List open issues",
      text: "list open issues",
      filters: { state: ["open"] },
      types: ["issue"],
    });

    expect(listIssues).toHaveBeenCalledWith({
      state: "open",
      limit: 50,
    });
  });

  it("does not substring-filter list fallback results by request text", async () => {
    const listIssues = vi.fn<ListIssuesArgs, ListIssuesReturn>().mockResolvedValue({
      data: [createIssue(1), createIssue(2), createIssue(3)],
      source: "linear.cloud.nango",
      timestamp: "2026-04-26T12:00:00.000Z",
    });
    const { integration, searchIssues } = createLinearIntegration({ listIssues });
    const fallback = createLinearLibrarianApiFallback(integration);

    const entries = await fallback({
      instruction: "Find issues about auth",
      text: "this text does not appear in any issue title or body",
      filters: {},
      types: ["issue"],
    });

    expect(entries).toHaveLength(3);
    expect(searchIssues).not.toHaveBeenCalled();
  });
});
