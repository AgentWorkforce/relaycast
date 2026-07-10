import { getDb as getAppDb, setDbForTesting } from "./db/client.js";

export function setDb(db: unknown): void {
  setDbForTesting(db as never);
}

export function getDb(): unknown {
  return getAppDb();
}
