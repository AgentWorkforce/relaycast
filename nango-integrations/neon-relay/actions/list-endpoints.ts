import { createAction } from "nango";

import { listEndpoints } from "../shared/neon-api.js";
import { mapEndpointRecord } from "../shared/neon-mappers.js";
import { ListEndpointsInput, ListEndpointsOutput } from "../shared/neon-schemas.js";

export default createAction({
  description: "List compute endpoints for a Neon project.",
  version: "1.0.0",
  endpoint: {
    method: "GET",
    path: "/neon/endpoints",
    group: "Neon",
  },
  input: ListEndpointsInput,
  output: ListEndpointsOutput,

  exec: async (nango, input) => {
    const endpoints = await listEndpoints(nango, input.project_id);
    return {
      endpoints: endpoints.map(mapEndpointRecord),
    };
  },
});
