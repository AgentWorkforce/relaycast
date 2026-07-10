import { createAction } from "nango";

import { listAdvisorIssues } from "../shared/neon-api.js";
import { mapAdvisorIssueRecord } from "../shared/neon-mappers.js";
import { ListAdvisorIssuesInput, ListAdvisorIssuesOutput } from "../shared/neon-schemas.js";

export default createAction({
  description: "List Neon advisor issues for a project and optional branch.",
  version: "1.0.0",
  endpoint: {
    method: "GET",
    path: "/neon/advisor-issues",
    group: "Neon",
  },
  input: ListAdvisorIssuesInput,
  output: ListAdvisorIssuesOutput,

  exec: async (nango, input) => {
    const capturedAt = new Date().toISOString();
    const issues = await listAdvisorIssues(nango, {
      project_id: input.project_id,
      ...(input.branch_id ? { branch_id: input.branch_id } : {}),
      ...(input.database_name ? { database_name: input.database_name } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.min_severity ? { min_severity: input.min_severity } : {}),
    });
    return {
      issues: issues.map((issue) =>
        mapAdvisorIssueRecord(input.project_id, input.branch_id, issue, capturedAt),
      ),
    };
  },
});
