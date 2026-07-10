// Loaded via dynamic import inside main() so argument validation and --help can
// run without initializing the web app's database dependencies.

const auditModulePath =
  "../packages/web/lib/integrations/workspace-integration-row-audit.ts";

type AuditWorkspaceIntegrationRows =
  (typeof import("../packages/web/lib/integrations/workspace-integration-row-audit"))["auditWorkspaceIntegrationRows"];

async function loadAudit(): Promise<AuditWorkspaceIntegrationRows> {
  const mod: Record<string, unknown> = await import(auditModulePath);
  const named = mod.auditWorkspaceIntegrationRows;
  const fromDefault = (mod.default as { auditWorkspaceIntegrationRows?: unknown } | undefined)
    ?.auditWorkspaceIntegrationRows;
  const resolved = named ?? fromDefault;
  if (typeof resolved !== "function") {
    throw new Error("Could not resolve auditWorkspaceIntegrationRows from " + auditModulePath);
  }
  return resolved as AuditWorkspaceIntegrationRows;
}

type CliOptions = {
  workspaceId?: string;
  provider?: string;
  limit?: number;
  mismatchedOnly: boolean;
};

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/audit-workspace-integration-rows.ts [options]

READ-ONLY audit of workspace_integrations.workspace_id shapes (#1910 context):
classifies each row (rw_ vs app-UUID vs other), resolves the bound relay
workspace the sync-enqueue translation now uses, and flags rows whose
pre-#1910 sync target differed (historical records stranded in a workspace
nobody mounts) plus app-UUID rows with NO binding. There is no --apply: this
script never writes; repairs are a separate decision.

Options:
  --workspace-id <id>     Restrict to one workspace_integrations.workspace_id value.
  --provider <name>       Restrict to one provider, e.g. github, linear.
  --limit <count>         Process at most count rows.
  --mismatched-only       Print only rows with syncTargetMismatch or unbound app-UUIDs.
  --help                  Show this help.
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
  const options: CliOptions = { mismatchedOnly: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
        return "help";
      case "--mismatched-only":
        options.mismatchedOnly = true;
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

  const audit = await loadAudit();
  const summary = await audit(parsed);

  for (const entry of summary.entries) {
    if (
      parsed.mismatchedOnly &&
      !entry.syncTargetMismatch &&
      !(entry.idShape === "app_uuid" && entry.boundRelayWorkspaceId === null)
    ) {
      continue;
    }
    console.log(JSON.stringify(entry));
  }
  console.log(
    JSON.stringify({
      scanned: summary.scanned,
      relayShaped: summary.relayShaped,
      appUuidShaped: summary.appUuidShaped,
      otherShaped: summary.otherShaped,
      mismatched: summary.mismatched,
      unbound: summary.unbound,
    }),
  );
}

const isDirectRun = process.argv[1]?.endsWith("audit-workspace-integration-rows.ts") ?? false;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
