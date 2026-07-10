/**
 * Read the OpenNext Cloudflare context's `waitUntil` so background work
 * (e.g. the tick-delivery drain) survives the response. Extracted from the
 * deployment ticks route so every route that enqueues deliveries shares one
 * implementation (cloud trigger-now work).
 */
const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");

export function readCloudflareWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {
  const context = (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
  if (!context || typeof context !== "object") {
    return undefined;
  }
  const cloudflareContext = context as {
    waitUntil?: (promise: Promise<unknown>) => void;
    ctx?: { waitUntil?: (promise: Promise<unknown>) => void };
  };
  if (typeof cloudflareContext.waitUntil === "function") {
    return (promise: Promise<unknown>) => cloudflareContext.waitUntil!(promise);
  }
  if (cloudflareContext.ctx && typeof cloudflareContext.ctx.waitUntil === "function") {
    const ctx = cloudflareContext.ctx;
    return (promise: Promise<unknown>) => ctx.waitUntil!(promise);
  }
  return undefined;
}
