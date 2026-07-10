/**
 * Next.js instrumentation hook — runs once when the Next.js server
 * initializes (cold start) and never again on warm invokes. Runs on
 * both the AWS Lambda (deployed via `infra/web.ts`) and the
 * Cloudflare Worker (deployed via `infra/web-worker.ts`); OpenNext-CF
 * preserves the Next.js instrumentation contract and reports
 * `NEXT_RUNTIME=nodejs` from inside the Workers `nodejs_compat`
 * sandbox, so this hook fires in both environments.
 *
 * Used here as the boot-time hook for the cloud webapp's resource
 * binding check. See `lib/boot/resource-check.ts` for what gets
 * verified and why; the check itself detects which runtime it's in
 * and picks the appropriate required-resource list.
 *
 * Keep this file extremely small. Anything heavy added here delays
 * cold-start latency for every request that triggered the cold start.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    // Edge runtime can't access SST resources via `import { Resource } from 'sst'`;
    // skip on edge to avoid a crash at module load.
    return;
  }

  // Isolate the check so it can never abort lambda startup. The
  // entire point of this module is observational — if the boot
  // module itself fails to load (build artifact missing, SST runtime
  // unavailable on this runtime, etc.) we want to log the breakage
  // and keep serving requests, not 500 every cold-started invoke.
  try {
    const { runBootResourceCheck } = await import("./lib/boot/resource-check");
    runBootResourceCheck();
  } catch (err) {
    console.error("[boot] instrumentation hook failed — boot resource check skipped", {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}
