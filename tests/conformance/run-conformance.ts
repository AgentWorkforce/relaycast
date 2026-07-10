#!/usr/bin/env -S npx tsx
// CLI entry for the conformance harness.
//
// Usage:
//   npx tsx tests/conformance/run-conformance.ts <provider...>   # named providers
//   npx tsx tests/conformance/run-conformance.ts --all           # every manifest
//   npx tsx tests/conformance/run-conformance.ts slack --json    # machine output
//   npx tsx tests/conformance/run-conformance.ts hubspot --direction writeback
//   npx tsx tests/conformance/run-conformance.ts github --live   # real Nango round-trip
//
// Exit code is non-zero if any selected provider is not GREEN, so this doubles
// as the per-provider G3 gate.

import {
  loadAllManifests,
  loadManifestByName,
  type LoadedManifest,
} from "./load-manifest.ts";
import { runProviderManifest, summarizeProvider } from "./harness.ts";
import type { Direction, ProviderResult, RunOptions } from "./harness-types.ts";

// Live Nango connection ids (prod) keyed by providerConfigKey. Populated from
// Integration-Verifier's probe; secret stays in cloud/nango-integrations/.env.
const LIVE_CONNECTIONS: Record<string, string> = {
  "github-relay": "c4dd69bf-5d18-4c41-b220-8f502c841558",
  "gitlab-relay": "4722f486-0e50-41da-8de6-e0ba8bdf724f",
  "google-mail-relay": "7106d5ff-ca4f-4462-b87d-8498a72bc855",
  "hubspot-relay": "18111372-7470-4dbb-852f-1637f6c307c6",
  "linear-relay": "9d5d9c1d-e257-42f2-89d1-f8d5193c56f0",
  "notion-relay": "3f4fcb9b-4df4-4935-a6b9-79c20c6da6a3",
  "slack-relay": "c8ebcc90-1809-47e6-875e-30cfc67b9c5b",
  "granola-relay": "a44625ae-9a6f-4320-bfd0-c2f9477314fc",
  "reddit-composio-relay": "ca_ZeoDRmViRoFu",
};

function parseArgs(argv: string[]): {
  providers: string[];
  all: boolean;
  json: boolean;
  options: RunOptions;
} {
  const providers: string[] = [];
  let all = false;
  let json = false;
  let live = false;
  let directions: Direction[] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") all = true;
    else if (arg === "--json") json = true;
    else if (arg === "--live") live = true;
    else if (arg === "--direction" || arg === "--directions") {
      directions = argv[++i]?.split(",").map((s) => s.trim()) as Direction[];
    } else if (arg.startsWith("--")) {
      console.error(`Unknown flag: ${arg}`);
    } else {
      providers.push(arg);
    }
  }

  return {
    providers,
    all,
    json,
    options: { live, directions, liveConnections: LIVE_CONNECTIONS },
  };
}

function printHuman(result: ProviderResult): void {
  console.log(summarizeProvider(result));
  for (const fx of result.fixtures) {
    if (fx.passed) {
      console.log(`  ✅ ${fx.label}`);
    } else {
      console.log(`  ❌ ${fx.label}`);
      for (const err of fx.errors) console.log(`       - ${err}`);
    }
  }
}

async function main(): Promise<void> {
  const { providers, all, json, options } = parseArgs(process.argv.slice(2));

  let selected: LoadedManifest[];
  if (all) {
    selected = loadAllManifests();
  } else if (providers.length > 0) {
    selected = providers.map((name) => loadManifestByName(name));
  } else {
    console.error(
      "Usage: run-conformance.ts <provider...> | --all  [--direction d1,d2] [--live] [--json]",
    );
    process.exit(2);
    return;
  }

  const results: ProviderResult[] = [];
  for (const { manifest } of selected) {
    results.push(await runProviderManifest(manifest, options));
  }

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) printHuman(r);
    const red = results.filter((r) => !r.green);
    console.log(
      `\n${results.length - red.length}/${results.length} providers GREEN` +
        (red.length ? ` — RED: ${red.map((r) => r.provider).join(", ")}` : ""),
    );
  }

  process.exit(results.every((r) => r.green) ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
