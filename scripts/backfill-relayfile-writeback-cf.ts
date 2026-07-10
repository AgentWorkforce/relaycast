// Loaded via dynamic import inside main() rather than a top-level
// `import { backfillRelayfileWritebackCf } from ".../*.js"` statement.
// The named-import form fails at Node's ESM parse time because
// packages/web has no `"type": "module"` declaration, so tsx loads
// the .ts file as CJS and exposes its exports under `default` — Node
// ESM rejects the named binding before main() ever runs. Dynamic
// import bypasses the parse-time named-export check and works under
// both module shapes. See Codex P1.5 on bundle PR #647.
const backfillModulePath =
  "../packages/web/lib/integrations/relayfile-writeback-dispatch-backfill.js";

async function loadBackfill(): Promise<
  (typeof import("../packages/web/lib/integrations/relayfile-writeback-dispatch-backfill"))["backfillRelayfileWritebackCf"]
> {
  const mod: Record<string, unknown> = await import(backfillModulePath);
  const named = mod.backfillRelayfileWritebackCf;
  const fromDefault = (mod.default as { backfillRelayfileWritebackCf?: unknown } | undefined)
    ?.backfillRelayfileWritebackCf;
  const resolved = named ?? fromDefault;
  if (typeof resolved !== "function") {
    throw new Error(
      "Could not resolve backfillRelayfileWritebackCf from " + backfillModulePath,
    );
  }
  return resolved as Awaited<ReturnType<typeof loadBackfill>>;
}

type CliOptions = {
  workspaceId?: string;
  provider?: string;
  limit?: number;
  timeoutMs?: number;
  dryRun: boolean;
};

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/backfill-relayfile-writeback-cf.ts [options]

Safely activates Cloudflare-native RelayFile writeback dispatch by first
pushing each workspace integration credential copy to RelayFile, then flipping
workspace_integrations.writeback_dispatch_via to 'cf' only after that push
succeeds.

Runs in DRY-RUN mode by default. Pass --apply to perform live mutations.

Options:
  --apply               Actually push to RelayFile and flip writeback_dispatch_via.
                        Without this flag the script only prints what would change.
  --workspace-id <id>   Restrict to one workspace.
  --provider <name>     Restrict to one provider, e.g. notion, github, slack.
  --limit <count>       Process at most count rows.
  --timeout-ms <ms>     RelayFile credential push timeout. Defaults to 5000.
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

function readPositiveInt(args: string[], index: number, flag: string): number {
  const value = Number.parseInt(readValue(args, index, flag), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  // Safe-by-default: dry-run unless --apply is explicitly provided.
  if (argv.includes("--apply") && argv.includes("--dry-run")) {
    console.error("Error: --apply and --dry-run are mutually exclusive. Remove one.");
    process.exit(1);
  }
  const options: CliOptions = { dryRun: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      case "--apply":
        options.dryRun = false;
        break;
      case "--workspace-id":
        options.workspaceId = readValue(argv, index, arg);
        index += 1;
        break;
      case "--provider":
        options.provider = readValue(argv, index, arg);
        index += 1;
        break;
      case "--limit":
        options.limit = readPositiveInt(argv, index, arg);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = readPositiveInt(argv, index, arg);
        index += 1;
        break;
      case "--dry-run":
        // Explicit alias — dry-run is already the default, but accept it
        // so old invocations don't break.
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.dryRun) {
    console.warn(
      "⚠  DRY-RUN MODE — no data will be written. Pass --apply to perform live mutations.",
    );
  }

  const backfillRelayfileWritebackCf = await loadBackfill();
  const summary = await backfillRelayfileWritebackCf(options);
  console.log(JSON.stringify(summary, null, 2));

  if (options.dryRun) {
    console.warn(
      "⚠  Dry-run complete. Re-run with --apply to commit these changes.",
    );
  }

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "RelayFile writeback CF backfill failed",
  );
  process.exit(1);
});
