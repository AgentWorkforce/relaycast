// Loaded via dynamic import inside main() so argument validation and --help can
// run without initializing the web app's database/storage dependencies.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const backfillModulePath =
  "../packages/web/lib/billing/provider-credential-account-email-backfill.ts";

type BackfillProviderCredentialAccountEmails =
  (typeof import("../packages/web/lib/billing/provider-credential-account-email-backfill"))["backfillProviderCredentialAccountEmails"];

async function loadBackfill(): Promise<BackfillProviderCredentialAccountEmails> {
  const mod: Record<string, unknown> = await import(backfillModulePath);
  const named = mod.backfillProviderCredentialAccountEmails;
  const fromDefault = (mod.default as { backfillProviderCredentialAccountEmails?: unknown } | undefined)
    ?.backfillProviderCredentialAccountEmails;
  const resolved = named ?? fromDefault;
  if (typeof resolved !== "function") {
    throw new Error(
      "Could not resolve backfillProviderCredentialAccountEmails from " + backfillModulePath,
    );
  }
  return resolved as BackfillProviderCredentialAccountEmails;
}

type CliOptions = {
  dryRun: boolean;
  workspaceId?: string;
  userId?: string;
  provider?: string;
  authType?: string;
  limit?: number;
};

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/backfill-provider-credential-account-email.ts [options]

Backfills provider_credentials.account_email from the encrypted credential blob
stored in WorkflowStorage. Runs in DRY-RUN mode by default.

Options:
  --apply               Actually update provider_credentials.account_email.
                        Without this flag the script only prints what would change.
  --workspace-id <id>   Restrict to one workspace.
  --user-id <id>        Restrict to one user.
  --provider <name>     Restrict to one provider, e.g. anthropic or openai.
  --auth-type <type>    Restrict to one auth type.
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

function readPositiveInt(args: string[], index: number, flag: string): number {
  const raw = readValue(args, index, flag);
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

export function parseArgs(argv: string[]): CliOptions {
  if (argv.includes("--apply") && argv.includes("--dry-run")) {
    throw new Error("--apply and --dry-run are mutually exclusive. Remove one.");
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
      case "--user-id":
        options.userId = readValue(argv, index, arg);
        index += 1;
        break;
      case "--provider":
        options.provider = readValue(argv, index, arg);
        index += 1;
        break;
      case "--auth-type":
        options.authType = readValue(argv, index, arg);
        index += 1;
        break;
      case "--limit":
        options.limit = readPositiveInt(argv, index, arg);
        index += 1;
        break;
      case "--dry-run":
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
      "DRY-RUN MODE - no data will be written. Pass --apply to update account_email.",
    );
  }

  const backfillProviderCredentialAccountEmails = await loadBackfill();
  const summary = await backfillProviderCredentialAccountEmails(options);
  console.log(JSON.stringify(summary, null, 2));

  if (options.dryRun) {
    console.warn("Dry-run complete. Re-run with --apply to commit these changes.");
  }

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Provider credential account_email backfill failed",
    );
    process.exit(1);
  });
}
