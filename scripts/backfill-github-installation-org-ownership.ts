const backfillModulePath =
  "../packages/web/lib/integrations/github-installation-org-backfill.ts";

type BackfillGithubInstallationOrgOwnership =
  (typeof import("../packages/web/lib/integrations/github-installation-org-backfill"))["backfillGithubInstallationOrgOwnership"];

type CliOptions = {
  dryRun: boolean;
  reportDivergence?: boolean;
  workspaceId?: string;
  limit?: number;
};

async function loadBackfill(): Promise<BackfillGithubInstallationOrgOwnership> {
  const mod: Record<string, unknown> = await import(backfillModulePath);
  const resolved = mod.backfillGithubInstallationOrgOwnership;
  if (typeof resolved !== "function") {
    throw new Error(
      "Could not resolve backfillGithubInstallationOrgOwnership from " +
        backfillModulePath,
    );
  }
  return resolved as BackfillGithubInstallationOrgOwnership;
}

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/backfill-github-installation-org-ownership.ts [options]

Backfills organization_github_installations from existing GitHub workspace
integration rows and workspace_github_installation_links. Runs in DRY-RUN mode
by default and reports orphans without deleting or mutating source rows.

Options:
  --apply               Write missing org-installation ownership rows and fill
                        missing github_installations connection metadata.
  --dry-run             Alias: same as omitting --apply.
  --report-divergence   Dry-run and report groups where the real backfill would
                        choose from multiple distinct connection ids.
  --workspace-id <id>   Restrict to one workspace id.
  --limit <count>       Process at most count source rows.
  --help                Show this help.
`);
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(args: string[]): CliOptions | "help" {
  const options: CliOptions = { dryRun: true };
  let applyRequested = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
        return "help";
      case "--apply":
        if (options.reportDivergence) {
          throw new Error("--apply cannot be combined with --report-divergence");
        }
        applyRequested = true;
        options.dryRun = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--report-divergence":
        if (applyRequested) {
          throw new Error("--report-divergence cannot be combined with --apply");
        }
        options.dryRun = true;
        options.reportDivergence = true;
        break;
      case "--workspace-id":
        options.workspaceId = readValue(args, index, arg);
        index += 1;
        break;
      case "--limit": {
        const raw = readValue(args, index, arg);
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error(`--limit must be a positive integer; got "${raw}"`);
        }
        options.limit = parsed;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg} (use --help)`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    printHelp();
    return;
  }

  const backfill = await loadBackfill();
  const summary = await backfill(parsed);

  for (const orphan of summary.orphans) {
    console.log(JSON.stringify({ type: "orphan", ...orphan }));
  }
  for (const skipped of summary.skippedPersonal) {
    console.log(JSON.stringify({ type: "skipped_personal", ...skipped }));
  }
  for (const divergence of summary.connectionDivergences) {
    console.log(JSON.stringify({ type: "connection_divergence", ...divergence }));
  }
  for (const result of summary.results) {
    console.log(JSON.stringify({ type: "result", ...result }));
  }
  console.log(JSON.stringify({
    type: "summary",
    dryRun: summary.dryRun,
    scanned: summary.scanned,
    eligible: summary.eligible,
    inserted: summary.inserted,
    updated: summary.updated,
    existing: summary.existing,
    wouldInsert: summary.wouldInsert,
    wouldUpdate: summary.wouldUpdate,
    wouldKeep: summary.wouldKeep,
    skippedPersonalInstallations: summary.skippedPersonalInstallations,
    orphanCount: summary.orphans.length,
    connectionDivergenceCount: summary.connectionDivergences.length,
  }));
}

const isDirectRun =
  process.argv[1]?.endsWith("backfill-github-installation-org-ownership.ts") ??
  false;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
