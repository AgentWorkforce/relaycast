/**
 * Detect whether the current request is being served by the OpenNext
 * Cloudflare Worker runtime vs the AWS Lambda runtime. Used by the AWS
 * factory functions (`createWorkflowStorageS3Client`, broker mint paths)
 * to choose between direct STS calls (Lambda — has IAM) and
 * broker-mediated STS calls (Worker — no IAM, must call out to the
 * Lambda STS broker).
 *
 * The detection mirrors the DB factory pattern in
 * `@cloud/core/db/factory.ts`: OpenNext-CF populates a context object on
 * `globalThis[Symbol.for("__cloudflare-context__")]` with the worker
 * `env` bindings. If the symbol is present, we're on the Worker. If not,
 * we're on Lambda (or local Node — same code path either way, since
 * Lambda's IAM credentials are picked up by the AWS SDK default chain).
 */

const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");

export type WorkerEnv = Record<string, unknown>;

export function readWorkerEnv(): WorkerEnv | undefined {
  const context = (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
  if (context && typeof context === "object") {
    const env = (context as { env?: unknown }).env;
    if (env && typeof env === "object") {
      return env as WorkerEnv;
    }
  }
  return undefined;
}

export function isWorkerRuntime(): boolean {
  return readWorkerEnv() !== undefined;
}

function readString(env: WorkerEnv | undefined, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Resolve broker config from the Worker env. Returns `undefined` on Lambda
 * (broker is Worker-only). Throws on Worker if either binding is missing —
 * the route handler should surface that as a 500 / boot-time alarm.
 */
export function readBrokerConfig(): { brokerUrl: string; hmacSecret: string } | undefined {
  const env = readWorkerEnv();
  if (!env) {
    return undefined;
  }
  const brokerUrl = readString(env, "BROKER_URL");
  const hmacSecret = readString(env, "BROKER_HMAC_SECRET");
  if (!brokerUrl || !hmacSecret) {
    throw new Error(
      "[aws/runtime] STS broker is not configured on this Worker (BROKER_URL or BROKER_HMAC_SECRET missing)",
    );
  }
  return { brokerUrl, hmacSecret };
}
