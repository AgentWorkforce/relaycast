import { createAction } from "nango";

import { listBranches } from "../shared/neon-api.js";
import { mapBranchRecord } from "../shared/neon-mappers.js";
import { ListBranchesInput, ListBranchesOutput } from "../shared/neon-schemas.js";

export default createAction({
  description: "List branches for a Neon project.",
  version: "1.0.0",
  endpoint: {
    method: "GET",
    path: "/neon/branches",
    group: "Neon",
  },
  input: ListBranchesInput,
  output: ListBranchesOutput,

  exec: async (nango, input) => {
    const result = await listBranches(nango, {
      project_id: input.project_id,
      ...(input.search ? { search: input.search } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    return {
      branches: result.branches.map(mapBranchRecord),
      ...(result.next_cursor ? { next_cursor: result.next_cursor } : {}),
    };
  },
});
