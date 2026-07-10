// Operator script: backfill the #1538 github_installations index from the
// live github-relay Nango connections, so org-reconcile detection surfaces
// pre-index installations. Safe to re-run; goes through the canonical
// upsertGithubInstallationIndex only.
//
// Usage:
//   NANGO_SECRET_KEY=... DATABASE_URL=... npx tsx scripts/run-github-installation-sweep.ts [--dry-run]
import { sweepGithubInstallationsFromNango } from "../packages/web/lib/integrations/github-installation-sweep";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const result = await sweepGithubInstallationsFromNango({ dryRun });
  console.log(
    `[github-installation-sweep]${dryRun ? " (dry-run)" : ""} scanned=${result.scanned} indexed=${result.indexed} ` +
      `skippedNoInstallation=${result.skippedNoInstallation} skippedOrphan=${result.skippedOrphan} failed=${result.failed}`,
  );
  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[github-installation-sweep] fatal:", error);
  process.exit(1);
});
