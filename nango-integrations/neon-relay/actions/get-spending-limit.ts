import { createAction } from "nango";

import { getSpendingLimit } from "../shared/neon-api.js";
import { mapSpendingLimitRecord } from "../shared/neon-mappers.js";
import { GetSpendingLimitInput, GetSpendingLimitOutput } from "../shared/neon-schemas.js";

export default createAction({
  description: "Get the configured spending limit for a Neon organization.",
  version: "1.0.0",
  endpoint: {
    method: "GET",
    path: "/neon/spending-limit",
    group: "Neon",
  },
  input: GetSpendingLimitInput,
  output: GetSpendingLimitOutput,

  exec: async (nango, input) => {
    const capturedAt = new Date().toISOString();
    const spendingLimit = await getSpendingLimit(nango, input.org_id);
    return {
      spending_limit: mapSpendingLimitRecord(input.org_id, undefined, spendingLimit, capturedAt),
    };
  },
});
