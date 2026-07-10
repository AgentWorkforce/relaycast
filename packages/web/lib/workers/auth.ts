import type { NextRequest } from "next/server";
import { readBearerToken } from "@/lib/auth/api-token-store";
import { WorkerRegistry } from "./registry";
import { isWorkerToken } from "./tokens";
import type { WorkerRecord } from "./types";

export class WorkerAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WorkerAuthError";
  }
}

export async function requireWorkerAuth(
  request: NextRequest,
  workerId: string,
): Promise<WorkerRecord> {
  const registry = new WorkerRegistry();
  const bearerToken = readBearerToken(request.headers.get("authorization"));
  if (!bearerToken) {
    throw new WorkerAuthError("Unauthorized", 401);
  }

  const authorized =
    isWorkerToken(bearerToken) && (await registry.validateToken(workerId, bearerToken));
  if (!authorized) {
    throw new WorkerAuthError("Unauthorized", 401);
  }

  const worker = await registry.findById(workerId);
  if (!worker || worker.status === "revoked") {
    throw new WorkerAuthError("Unauthorized", 401);
  }

  return worker;
}
