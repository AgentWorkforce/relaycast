// Conformance harness reference suite.
//
// This is the harness trust gate: every manifest must be schema-valid, and the
// two already-proven reference integrations (slack, linear) must run GREEN
// through the real code path. A green reference run means the harness machinery
// itself is trustworthy — so Fixture-Wright / Adapter-Mechanic / Cloud-Wright
// can rely on RED results from other providers being real holes, not harness
// artifacts.
//
// Per-provider G3 enforcement during the build-out is done via the CLI:
//   npx tsx tests/conformance/run-conformance.ts <provider>
// (non-zero exit when not green). This suite stays stable so `vitest run` is
// not blocked by integrations that are still being filled in.

import { describe, expect, it } from "vitest";

import { loadAllManifests, loadManifestByName } from "./load-manifest.ts";
import { runProviderManifest } from "./harness.ts";

describe("conformance manifests", () => {
  it("all manifests are schema-valid", () => {
    // loadAllManifests throws ManifestValidationError listing every problem.
    const loaded = loadAllManifests();
    expect(loaded.length).toBeGreaterThan(0);
  });
});

describe("reference providers run green through the real code path", () => {
  for (const provider of ["slack", "linear"]) {
    it(`${provider} is GREEN`, async () => {
      const { manifest } = loadManifestByName(provider);
      const result = await runProviderManifest(manifest);
      const failures = result.fixtures
        .filter((f) => !f.passed)
        .map((f) => `${f.label}: ${f.errors.join("; ")}`);
      expect(failures, failures.join("\n")).toEqual([]);
      expect(result.green).toBe(true);
    }, 60_000);
  }
});
