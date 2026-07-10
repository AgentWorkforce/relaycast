import { drizzle } from "drizzle-orm/d1";
import * as schema from "@relaycron/server/db";

export function createD1Database(d1: D1Database) {
  return drizzle(d1, { schema });
}
