import { createAction } from "nango";

import { listOperations } from "../shared/neon-api.js";
import { mapOperationRecord } from "../shared/neon-mappers.js";
import { ListOperationsInput, ListOperationsOutput } from "../shared/neon-schemas.js";

export default createAction({
  description: "List operations for a Neon project.",
  version: "1.0.0",
  endpoint: {
    method: "GET",
    path: "/neon/operations",
    group: "Neon",
  },
  input: ListOperationsInput,
  output: ListOperationsOutput,

  exec: async (nango, input) => {
    const result = await listOperations(nango, {
      project_id: input.project_id,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    return {
      operations: result.operations.map(mapOperationRecord),
      ...(result.next_cursor ? { next_cursor: result.next_cursor } : {}),
    };
  },
});
