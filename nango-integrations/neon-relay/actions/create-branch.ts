import { createAction } from "nango";

import { asRecord, createBranch } from "../shared/neon-api.js";
import { mapBranchRecord, mapEndpointRecord } from "../shared/neon-mappers.js";
import { CreateBranchInput, CreateBranchOutput } from "../shared/neon-schemas.js";

export default createAction({
  description: "Create a Neon branch, optionally with a compute endpoint.",
  version: "1.0.0",
  endpoint: {
    method: "POST",
    path: "/neon/branches",
    group: "Neon",
  },
  input: CreateBranchInput,
  output: CreateBranchOutput,

  exec: async (nango, input) => {
    const response = await createBranch(nango, {
      project_id: input.project_id,
      ...(input.name ? { name: input.name } : {}),
      ...(input.parent_id ? { parent_id: input.parent_id } : {}),
      ...(input.parent_lsn ? { parent_lsn: input.parent_lsn } : {}),
      ...(input.parent_timestamp ? { parent_timestamp: input.parent_timestamp } : {}),
      ...(input.endpoint_type ? { endpoint_type: input.endpoint_type } : {}),
    });
    const branch = asRecord(response["branch"]);
    if (!branch) {
      throw new Error("Neon create branch response did not include branch");
    }

    const endpoints = Array.isArray(response["endpoints"]) ? response["endpoints"] : [];
    const operations = Array.isArray(response["operations"]) ? response["operations"] : [];

    return {
      branch: mapBranchRecord(branch as never),
      ...(endpoints.length > 0 && asRecord(endpoints[0])
        ? { endpoint: mapEndpointRecord(endpoints[0] as never) }
        : {}),
      operation_ids: operations
        .map((entry) => asRecord(entry)?.["id"])
        .filter((value): value is string => typeof value === "string"),
    };
  },
});
