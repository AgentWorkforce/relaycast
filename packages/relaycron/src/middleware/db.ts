import { createMiddleware } from "hono/factory";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema.js";
import type { Env } from "../types.js";

export const dbMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const db = drizzle(c.env.DB, { schema });
    c.set("db", db);
    await next();
  }
);
