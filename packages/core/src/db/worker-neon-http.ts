import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

export function configureNeonHttpFetchFunctionForWorker(): void {
  neonConfig.fetchFunction = (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => globalThis.fetch(input, init);
}

export function getNeonHttpDb(connectionString: string) {
  configureNeonHttpFetchFunctionForWorker();
  const sql = neon(connectionString);
  return drizzle(sql, { schema });
}
