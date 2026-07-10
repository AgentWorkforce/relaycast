// Repo note: the canonical Drizzle schema lives in packages/web/lib/db/schema.ts.
// This bridge exists because the worker-dispatch spec originally targeted
// packages/web/drizzle/schema/*.ts files.
export {
  workAssignments,
  workerEnrollmentTokens,
  workers,
} from "../../lib/db/schema";
