// Diagnostic sweep — runs conformance for selected providers/directions under
// the VITEST resolver (vite alias for `server-only`, lenient package exports),
// which sidesteps the tsx-CLI module-resolution issues (server-only + an
// unpublished/partial adapter export like gitlab that the webhook router
// statically imports). It PRINTS per-fixture evidence and does NOT hard-fail,
// so it is a hole-finding tool, not a gate (the gate is conformance.test.ts +
// run-conformance.ts).
//
// Usage:
//   CONFORMANCE_PROVIDERS=slack,linear,notion CONFORMANCE_DIRECTION=inbound \
//     npx vitest run tests/conformance/sweep.test.ts
//   CONFORMANCE_DIRECTION=inbound npx vitest run tests/conformance/sweep.test.ts   # all manifests
//
// Omit CONFORMANCE_PROVIDERS to sweep every manifest; omit CONFORMANCE_DIRECTION
// to run all declared directions.

import { describe, it } from "vitest";

import {
  loadAllManifests,
  loadManifestByName,
  type LoadedManifest,
} from "./load-manifest.ts";
import { runProviderManifest, summarizeProvider } from "./harness.ts";
import type { Direction } from "./harness-types.ts";

const providerList = (process.env.CONFORMANCE_PROVIDERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const directions = (process.env.CONFORMANCE_DIRECTION ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean) as Direction[];

const selected: LoadedManifest[] = providerList.length
  ? providerList.map((name) => loadManifestByName(name))
  : loadAllManifests();

describe("conformance sweep (diagnostic, non-failing)", () => {
  for (const { name, manifest } of selected) {
    it(`${name}`, async () => {
      const result = await runProviderManifest(
        manifest,
        directions.length ? { directions } : {},
      );
      // Evidence dump for hole-finding (path/call diffs are in fixture.errors).
      console.log(
        `\n${summarizeProvider(result)}\n` +
          JSON.stringify(
            result.fixtures.map((f) => ({
              label: f.label,
              passed: f.passed,
              errors: f.errors,
              evidence: f.evidence,
            })),
            null,
            2,
          ),
      );
    }, 120_000);
  }
});
