#!/usr/bin/env node
/*
 * Regenerate the LATEST drizzle meta snapshot with the full schema derived
 * from the TypeScript schema sources (the canonical truth).
 *
 * Why this exists: migrations in this repo are hand-authored, and the
 * matching meta/<idx>_snapshot.json files degraded into empty stubs
 * (`"tables": {}`) starting around 0074/0075. The post-migrate deploy gate
 * (verify-applied-schema.cjs) reads ONLY the latest snapshot, so every stub
 * made the gate verify nothing — and the empty schema list produced a
 * Postgres `IN ()` syntax error besides. Run this script whenever you add a
 * migration: it rewrites the latest snapshot's content from the TS schemas
 * while preserving the snapshot's id/prevId chain.
 *
 * Usage:
 *   npm run web:drizzle-snapshot:regenerate
 *
 * The script:
 *   1. Writes a temporary drizzle-kit config covering the full schema
 *      (packages/web/lib/db/schema.ts re-exports @cloud/core's schema, plus
 *      packages/platform/src/schema.ts). Requires `npm run build:core` first
 *      (the web schema imports @cloud/core/db/schema.js from dist).
 *   2. Runs `drizzle-kit generate` into a throwaway directory, producing a
 *      0000 snapshot containing the complete schema.
 *   3. Copies that snapshot's content over meta/<latest>_snapshot.json,
 *      preserving the existing id and prevId so the drizzle journal chain
 *      is untouched.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const metaDir = path.join(repoRoot, "packages", "web", "drizzle", "meta");

const journal = JSON.parse(
  fs.readFileSync(path.join(metaDir, "_journal.json"), "utf8"),
);
const ordered = journal.entries.slice().sort((a, b) => a.idx - b.idx);
const latest = ordered.at(-1);
const idxPadded = String(latest.idx).padStart(4, "0");
const snapshotPath = path.join(metaDir, `${idxPadded}_snapshot.json`);

// For a NEW migration the latest snapshot file doesn't exist yet: mint a
// fresh id and chain prevId off the previous journal entry's snapshot.
// (This is what keeps authors from ever needing to hand-seed a stub.)
let current;
if (fs.existsSync(snapshotPath)) {
  current = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
} else {
  const previous = ordered.at(-2);
  if (!previous) {
    console.error("regenerate-drizzle-snapshot: no prior journal entry to chain prevId from");
    process.exit(1);
  }
  const prevPath = path.join(metaDir, `${String(previous.idx).padStart(4, "0")}_snapshot.json`);
  const prevSnapshot = JSON.parse(fs.readFileSync(prevPath, "utf8"));
  current = { id: crypto.randomUUID(), prevId: prevSnapshot.id };
  console.log(
    `regenerate-drizzle-snapshot: ${path.basename(snapshotPath)} is new — minted id, chained prevId to ${previous.tag}.`,
  );
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "drizzle-full-gen-"));
const configPath = path.join(repoRoot, ".drizzle-snapshot-regen.config.ts");

// BigInt column defaults (e.g. `default(0n)`) crash drizzle-kit's JSON
// serialization; shim toJSON for this generate-only config. The verifier
// only reads table/column NAMES, so default formatting is immaterial.
const config = `import { defineConfig } from "drizzle-kit";
(BigInt.prototype as unknown as { toJSON?: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};
export default defineConfig({
  schema: [
    "./packages/platform/src/schema.ts",
    "./packages/web/lib/db/schema.ts",
  ],
  out: ${JSON.stringify(outDir)},
  dialect: "postgresql",
});
`;

fs.writeFileSync(configPath, config);
try {
  execFileSync("npx", ["drizzle-kit", "generate", "--config", configPath], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "inherit"],
  });

  const generated = JSON.parse(
    fs.readFileSync(path.join(outDir, "meta", "0000_snapshot.json"), "utf8"),
  );
  const tableCount = Object.keys(generated.tables ?? {}).length;
  if (tableCount === 0) {
    console.error(
      "regenerate-drizzle-snapshot: generated snapshot has zero tables — refusing to write. " +
        "Did `npm run build:core` run? (the web schema imports @cloud/core/db/schema.js from dist)",
    );
    process.exit(1);
  }

  generated.id = current.id;
  generated.prevId = current.prevId;
  fs.writeFileSync(snapshotPath, `${JSON.stringify(generated, null, 2)}\n`);
  console.log(
    `regenerate-drizzle-snapshot: wrote ${path.basename(snapshotPath)} (tag ${latest.tag}) with ${tableCount} tables.`,
  );
} finally {
  fs.rmSync(configPath, { force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
}
