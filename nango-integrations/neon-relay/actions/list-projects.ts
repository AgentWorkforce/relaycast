import { createAction } from "nango";

import { listProjects } from "../shared/neon-api.js";
import { mapProjectRecord } from "../shared/neon-mappers.js";
import { ListProjectsInput, ListProjectsOutput } from "../shared/neon-schemas.js";

export default createAction({
  description: "List Neon projects for an organization or API key scope.",
  version: "1.0.0",
  endpoint: {
    method: "GET",
    path: "/neon/projects",
    group: "Neon",
  },
  input: ListProjectsInput,
  output: ListProjectsOutput,

  exec: async (nango, input) => {
    const result = await listProjects(nango, {
      ...(input.org_id ? { org_id: input.org_id } : {}),
      ...(input.search ? { search: input.search } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    return {
      projects: result.projects.map(mapProjectRecord),
      ...(result.next_cursor ? { next_cursor: result.next_cursor } : {}),
    };
  },
});
