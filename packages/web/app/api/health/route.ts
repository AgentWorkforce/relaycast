import { NextResponse } from "next/server";

import { checkRequiredResources } from "@/lib/boot/resource-check";

// Force Node runtime so the CF request context + SST resource reads work.
export const runtime = "nodejs";
// Never cache — this is a liveness + binding gate.
export const dynamic = "force-dynamic";

export async function GET() {
  // Runs IN REQUEST SCOPE, where OpenNext-CF has populated
  // `globalThis[__cloudflare-context__].env`. Unlike the boot check
  // (instrumentation register(), init scope) this sees the real CF
  // bindings, so it is the authoritative pre-cutover binding gate.
  let bindings:
    | { runtime: string; ok: string[]; missing: string[]; deferred: string[] }
    | { error: string };
  try {
    const summary = checkRequiredResources();
    bindings = {
      runtime: summary.runtime,
      ok: summary.ok.map((e) => e.name),
      missing: summary.missing.map((e) => e.name),
      // In REQUEST scope the CF env must be populated, so nothing should
      // defer here. If it does, the request-scoped context is genuinely
      // broken (the exact failure this gate exists to catch) — surface it
      // and treat it as NOT ok, never silently "verified".
      deferred: (summary.deferred ?? []).map((e) => e.name),
    };
  } catch (err) {
    bindings = { error: err instanceof Error ? err.message : String(err) };
  }

  const bindingsOk =
    "missing" in bindings &&
    bindings.missing.length === 0 &&
    bindings.deferred.length === 0 &&
    bindings.ok.length > 0;

  return NextResponse.json(
    {
      status: bindingsOk ? "ok" : "error",
      timestamp: new Date().toISOString(),
      version: "1.0.0",
      bindingsOk,
      bindings,
    },
    // Hard gate: 503 when bindings are not verifiably attached in request
    // scope, so uptime/cutover tooling treats it as a real failure.
    { status: bindingsOk ? 200 : 503 },
  );
}
