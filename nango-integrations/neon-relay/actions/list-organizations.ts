import { createAction } from "nango";
import { z } from "zod";

import { listOrganizations } from "../shared/neon-api.js";
import { mapOrganizationRecord } from "../shared/neon-mappers.js";
import { ListOrganizationsOutput } from "../shared/neon-schemas.js";

export default createAction({
  description: "List Neon organizations visible to the connected API key.",
  version: "1.0.0",
  endpoint: {
    method: "GET",
    path: "/neon/organizations",
    group: "Neon",
  },
  input: z.object({}),
  output: ListOrganizationsOutput,

  exec: async (nango) => {
    const organizations = await listOrganizations(nango);
    return {
      organizations: organizations.map(mapOrganizationRecord),
    };
  },
});
