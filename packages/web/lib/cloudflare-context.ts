type CloudflareContext = {
  env?: Record<string, unknown>;
};

const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");

export function getCloudflareContext(options: { async: false }): CloudflareContext {
  void options;
  const context = (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
  if (context && typeof context === "object") {
    return context as CloudflareContext;
  }

  throw new Error("Cloudflare context is not available");
}
