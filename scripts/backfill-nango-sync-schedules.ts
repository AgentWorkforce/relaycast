// Loaded via dynamic import inside main() so argument validation and --help can
// run without initializing the web app's database/Nango dependencies.

const backfillModulePath =
  "../packages/web/lib/integrations/nango-sync-schedule-backfill.ts";

type BackfillNangoSyncSchedules =
  (typeof import("../packages/web/lib/integrations/nango-sync-schedule-backfill"))["backfillNangoSyncSchedules"];

async function loadBackfill(): Promise<BackfillNangoSyncSchedules> {
  const mod: Record<string, unknown> = await import(backfillModulePath);
  const named = mod.backfillNangoSyncSchedules;
  const fromDefault = (mod.default as { backfillNangoSyncSchedules?: unknown } | undefined)
    ?.backfillNangoSyncSchedules;
  const resolved = named ?? fromDefault;
  if (typeof resolved !== "function") {
    throw new Error("Could not resolve backfillNangoSyncSchedules from " + backfillModulePath);
  }
  return resolved as BackfillNangoSyncSchedules;
}

type CliOptions = {
  dryRun: boolean;
  workspaceId?: string;
  provider?: string;
  limit?: number;
};

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/backfill-nango-sync-schedules.ts [options]

Starts Nango sync schedules for existing connected workspace_integrations rows.
#1857 starts schedules from the OAuth auth webhook, which only covers
connections made after it shipped — earlier connections have no schedules, so
their providers never materialize in the relayfile workspace. Runs in DRY-RUN
mode by default (lists candidates + current /sync/status; never calls
/sync/start).

Options:
  --apply               Actually call Nango /sync/start for each candidate.
                        Idempotent: starting an already-started sync is a no-op.
  --workspace-id <id>   Restrict to one workspace.
  --provider <name>     Restrict to one provider, e.g. slack, notion, linear.
  --limit <count>       Process at most count rows.
  --dry-run             Alias: same as omitting --apply (dry-run is the default).
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
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
        return "help";
      case "--apply":
        options.dryRun = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--workspace-id":
        options.workspaceId = readValue(args, index, arg);
        index += 1;
        break;
      case "--provider":
        options.provider = readValue(args, index, arg);
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

  for (const result of summary.results) {
    console.log(JSON.stringify(result));
  }
  console.log(
    JSON.stringify({
      dryRun: summary.dryRun,
      scanned: summary.scanned,
      started: summary.started,
      skipped: summary.skipped,
      failed: summary.failed,
    }),
  );
  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1]?.endsWith("backfill-nango-sync-schedules.ts") ?? false;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
