// Conformance harness orchestrator.
//
// Given a loaded manifest, run every fixture for each declared capability
// through the real code path and aggregate a ProviderResult. A provider is
// GREEN when every declared capability has all its fixtures passing.

import {
  type ConformanceManifest,
  resolveProviderConfigKey,
} from "./manifest-schema.ts";
import type {
  Direction,
  FixtureResult,
  ProviderResult,
  RunOptions,
} from "./harness-types.ts";
import { runSyncFixture } from "./runners/sync-runner.ts";
import { runWritebackFixture } from "./runners/writeback-runner.ts";
import { runInboundFixture } from "./runners/inbound-runner.ts";

function wants(options: RunOptions, direction: Direction): boolean {
  return !options.directions || options.directions.includes(direction);
}

export async function runProviderManifest(
  manifest: ConformanceManifest,
  options: RunOptions = {},
): Promise<ProviderResult> {
  const fixtures: FixtureResult[] = [];
  const caps = manifest.capabilities;

  // Inbound — run sequentially: each mutates shared process.env + globalThis.
  if (caps.webhook && wants(options, "inbound")) {
    for (const fx of manifest.inbound ?? []) {
      const pck = resolveProviderConfigKey(manifest, fx.providerConfigKey);
      fixtures.push(await runInboundFixture(manifest, fx, pck));
    }
  }
  // Only true (cloud-integrated) triggers the cloud writeback runner.
  // "adapter-only" providers are proven at the adapter layer, not here.
  if (caps.writeback === true && wants(options, "writeback")) {
    for (const fx of manifest.writeback ?? []) {
      const pck = resolveProviderConfigKey(manifest, fx.expectCall?.providerConfigKey);
      fixtures.push(await runWritebackFixture(manifest, fx, pck, options));
    }
  }
  if (caps.sync && wants(options, "sync")) {
    const pck = resolveProviderConfigKey(manifest);
    for (const fx of manifest.sync ?? []) {
      fixtures.push(await runSyncFixture(manifest, fx, pck));
    }
  }

  const count = (d: Direction) => fixtures.filter((f) => f.direction === d);
  const passed = (d: Direction) => count(d).filter((f) => f.passed).length;

  const capabilities = {
    webhook: {
      declared: caps.webhook,
      fixtures: count("inbound").length,
      passed: passed("inbound"),
    },
    writeback: {
      declared: caps.writeback === true,
      fixtures: count("writeback").length,
      passed: passed("writeback"),
    },
    sync: {
      declared: caps.sync,
      fixtures: count("sync").length,
      passed: passed("sync"),
    },
  };

  // Green: every declared+selected capability has >=1 fixture and all passed.
  const capGreen = (
    declared: boolean,
    direction: Direction,
    c: { fixtures: number; passed: number },
  ) => {
    if (!declared || !wants(options, direction)) return true;
    return c.fixtures > 0 && c.passed === c.fixtures;
  };

  const green =
    capGreen(caps.webhook, "inbound", capabilities.webhook) &&
    capGreen(caps.writeback === true, "writeback", capabilities.writeback) &&
    capGreen(caps.sync, "sync", capabilities.sync);

  return { provider: manifest.provider, capabilities, fixtures, green };
}

/** Pretty one-line summary for CLI/log output. */
export function summarizeProvider(result: ProviderResult): string {
  const parts: string[] = [];
  for (const [name, c] of Object.entries(result.capabilities)) {
    if (!c.declared) continue;
    parts.push(`${name} ${c.passed}/${c.fixtures}`);
  }
  const status = result.green ? "GREEN" : "RED";
  return `[${status}] ${result.provider} — ${parts.join(", ") || "no capabilities"}`;
}
