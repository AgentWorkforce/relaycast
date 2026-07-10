import { RelayFileClient } from "@relayfile/sdk";
import { Resource } from "sst";
import { mintRelayfileToken } from "../packages/core/src/relayfile/client.js";

const cleanupModulePath =
  "../packages/web/lib/integrations/orphaned-workspace-integration-cleanup.js";

const DEFAULT_RELAYFILE_URL = "https://api.relayfile.dev";
const DEFAULT_RELAYAUTH_URL = "https://api.relayauth.dev";

type CleanupModule = typeof import("../packages/web/lib/integrations/orphaned-workspace-integration-cleanup");

type CliOptions = {
  dryRun: boolean;
  workspaceId?: string;
  provider?: string;
  connectionId?: string;
  verifyRelayfile: boolean;
  relayfileRoot?: string;
  relayfileUrl: string;
  relayAuthUrl: string;
  relayAuthApiKey?: string;
  relayfileSampleLimit: number;
};

async function loadCleanup(): Promise<CleanupModule> {
  const mod: Record<string, unknown> = await import(cleanupModulePath);
  const resolved = mod.default ?? mod;
  return resolved as CleanupModule;
}

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/remove-orphaned-workspace-integration.ts [options]

Removes an orphaned workspace_integrations row that references a deleted Nango
connection, without touching provider materialized records. By default this
targets google-mail. Pass --connection-id and optionally --workspace-id to
select the exact orphan cleanup target.

Runs in DRY-RUN mode by default. Pass --apply to delete the exact matching
workspace_integrations row.

Options:
  --apply                    Delete the exact matching workspace_integrations row.
  --dry-run                  Print what would be deleted. This is the default.
  --workspace-id <id>        Restrict cleanup to one workspace.
  --provider <name>          Provider to match. Defaults to google-mail.
  --connection-id <id>       Connection id to match. Required.
  --verify-relayfile         Fingerprint the provider RelayFile root during dry-run.
  --skip-relayfile-verify    Do not fingerprint the provider RelayFile root
                             during --apply. Apply verifies RelayFile by default.
  --relayfile-root <path>    RelayFile provider root to fingerprint. Defaults to
                             /google-mail.
  --relayfile-url <url>      RelayFile API URL. Defaults to RELAYFILE_URL or
                             ${DEFAULT_RELAYFILE_URL}.
  --relayauth-url <url>      RelayAuth API URL. Defaults to RELAYAUTH_URL or
                             ${DEFAULT_RELAYAUTH_URL}.
  --relayauth-api-key <key>  RelayAuth API key. Defaults to RELAYAUTH_API_KEY,
                             NANGO_SYNC_RELAYAUTH_API_KEY, or SST WebRelayauthApiKey.
  --sample-limit <count>     Number of per-file hashes to print in the sample.
                             Defaults to 5; the full digest still covers all files.
  --help                     Show this help.
`);
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readNonNegativeInt(args: string[], index: number, flag: string): number {
  const value = Number.parseInt(readValue(args, index, flag), 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes("--apply") && argv.includes("--dry-run")) {
    throw new Error("--apply and --dry-run are mutually exclusive.");
  }
  if (argv.includes("--verify-relayfile") && argv.includes("--skip-relayfile-verify")) {
    throw new Error("--verify-relayfile and --skip-relayfile-verify are mutually exclusive.");
  }

  const dryRun = !argv.includes("--apply");
  const options: CliOptions = {
    dryRun,
    verifyRelayfile: !dryRun,
    relayfileUrl: process.env.RELAYFILE_URL?.trim() || DEFAULT_RELAYFILE_URL,
    relayAuthUrl: process.env.RELAYAUTH_URL?.trim() || DEFAULT_RELAYAUTH_URL,
    relayfileSampleLimit: 5,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      case "--apply":
        options.dryRun = false;
        options.verifyRelayfile = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        options.verifyRelayfile = false;
        break;
      case "--workspace-id":
        options.workspaceId = readValue(argv, index, arg);
        index += 1;
        break;
      case "--provider":
        options.provider = readValue(argv, index, arg);
        index += 1;
        break;
      case "--connection-id":
        options.connectionId = readValue(argv, index, arg);
        index += 1;
        break;
      case "--verify-relayfile":
        options.verifyRelayfile = true;
        break;
      case "--skip-relayfile-verify":
        options.verifyRelayfile = false;
        break;
      case "--relayfile-root":
        options.relayfileRoot = readValue(argv, index, arg);
        index += 1;
        break;
      case "--relayfile-url":
        options.relayfileUrl = readValue(argv, index, arg);
        index += 1;
        break;
      case "--relayauth-url":
        options.relayAuthUrl = readValue(argv, index, arg);
        index += 1;
        break;
      case "--relayauth-api-key":
        options.relayAuthApiKey = readValue(argv, index, arg);
        index += 1;
        break;
      case "--sample-limit":
        options.relayfileSampleLimit = readNonNegativeInt(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.relayfileUrl = trimTrailingSlash(options.relayfileUrl);
  options.relayAuthUrl = trimTrailingSlash(options.relayAuthUrl);
  return options;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readRelayAuthApiKey(options: CliOptions): string {
  const envValue =
    options.relayAuthApiKey?.trim() ||
    process.env.RELAYAUTH_API_KEY?.trim() ||
    process.env.NANGO_SYNC_RELAYAUTH_API_KEY?.trim();
  if (envValue) {
    return envValue;
  }

  const resources = Resource as unknown as {
    WebRelayauthApiKey?: { value?: string };
  };
  const linkedValue = resources.WebRelayauthApiKey?.value?.trim();
  if (linkedValue) {
    return linkedValue;
  }

  throw new Error(
    "RelayFile verification requires --relayauth-api-key, RELAYAUTH_API_KEY, NANGO_SYNC_RELAYAUTH_API_KEY, or SST WebRelayauthApiKey.",
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.dryRun) {
    console.warn(
      "DRY-RUN MODE: no data will be written. Pass --apply to delete the orphaned row.",
    );
  }

  const cleanup = await loadCleanup();
  const relayAuthApiKey = options.verifyRelayfile
    ? readRelayAuthApiKey(options)
    : undefined;

  const result = await cleanup.removeOrphanedWorkspaceIntegration(
    {
      dryRun: options.dryRun,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.connectionId ? { connectionId: options.connectionId } : {}),
      verifyRelayfile: options.verifyRelayfile,
      ...(options.relayfileRoot ? { relayfileRoot: options.relayfileRoot } : {}),
      relayfileSampleLimit: options.relayfileSampleLimit,
    },
    options.verifyRelayfile
      ? {
          fingerprintRelayfile: async (workspaceId, fingerprintOptions) => {
            const client = new RelayFileClient({
              baseUrl: options.relayfileUrl,
              token: () =>
                mintRelayfileToken({
                  workspaceId,
                  relayAuthUrl: options.relayAuthUrl,
                  relayAuthApiKey: relayAuthApiKey ?? "",
                  agentName: "cloud-1311-google-mail-cleanup",
                }),
            });
            return cleanup.createRelayfileSubtreeFingerprint(
              client,
              workspaceId,
              fingerprintOptions,
            );
          },
        }
      : {},
  );

  console.log(JSON.stringify(result, null, 2));

  if (
    result.status === "blocked_multiple_matches" ||
    result.status === "delete_race_lost" ||
    result.status === "relayfile_changed"
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
