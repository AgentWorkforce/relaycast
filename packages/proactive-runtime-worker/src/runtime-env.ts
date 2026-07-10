type RuntimeEnv = Record<string, unknown>;

const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");

export function installRuntimeEnv(env: RuntimeEnv): void {
  (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol] = { env };

  const maybeProcess = globalThis.process as
    | { env?: Record<string, string | undefined> }
    | undefined;
  if (!maybeProcess?.env) {
    return;
  }

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      maybeProcess.env[key] = value;
    }
  }
}
