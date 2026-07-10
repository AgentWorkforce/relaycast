import { createAction } from "nango";

import { getProject } from "../shared/neon-api.js";
import { mapProjectRecord } from "../shared/neon-mappers.js";
import { GetProjectInput, GetProjectOutput } from "../shared/neon-schemas.js";

export default createAction({
  description: "Get a single Neon project by id.",
  version: "1.0.0",
  endpoint: {
    method: "GET",
    path: "/neon/project",
    group: "Neon",
  },
  input: GetProjectInput,
  output: GetProjectOutput,

  exec: async (nango, input) => {
    const project = await getProject(nango, input.project_id);
    return {
      project: mapProjectRecord(project),
    };
  },
});
