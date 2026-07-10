import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceScript = join(repoRoot, "scripts/patch-opennext-native-shims.mjs");
const nodableEntitiesPath = "node_modules/@nodable/entities/src/entities.js";
const handlerPath = "packages/web/.open-next-cf/server-functions/default/packages/web/handler.mjs";
const workerPath = "packages/web/.open-next-cf/sst-bundle/worker.js";

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "opennext-shims-"));
  const scriptPath = join(root, "scripts/patch-opennext-native-shims.mjs");
  const nodableEntities = join(root, nodableEntitiesPath);
  const generatedHandler = join(root, handlerPath);
  const generatedWorker = join(root, workerPath);

  mkdirSync(dirname(scriptPath), { recursive: true });
  mkdirSync(dirname(nodableEntities), { recursive: true });
  mkdirSync(dirname(generatedHandler), { recursive: true });
  mkdirSync(dirname(generatedWorker), { recursive: true });
  copyFileSync(sourceScript, scriptPath);

  return { root, scriptPath, nodableEntities, generatedHandler, generatedWorker };
}

function runPatch(scriptPath) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
  });
}

test("patch-opennext-native-shims patches Daytona ObjectStorage loader variants", () => {
  const { scriptPath, generatedHandler } = createFixture();
  writeFileSync(
    generatedHandler,
    [
      'const x={ObjectStorage:()=>import("../ObjectStorage.js"),Other:()=>import("../ObjectStorage.js")};',
      'const y={"ObjectStorage" : () => import(/* @vite-ignore */ \'../ObjectStorage.js\')};',
    ].join("\n"),
    "utf8",
  );

  const result = runPatch(scriptPath);
  assert.equal(result.status, 0, result.stderr);

  const patched = readFileSync(generatedHandler, "utf8");
  assert.match(patched, /Daytona ObjectStorage is unavailable in the Cloudflare Worker bundle/);
  assert.match(patched, /Other:\(\)=>import\("\.\.\/ObjectStorage\.js"\)/);
  assert.doesNotMatch(patched, /["']?ObjectStorage["']?\s*:\s*[^,;}]{0,160}\.\.\/ObjectStorage\.js/);
});

test("patch-opennext-native-shims removes duplicate entity keys from source package and generated outputs", () => {
  const { scriptPath, nodableEntities, generatedHandler, generatedWorker } = createFixture();
  writeFileSync(
    nodableEntities,
    [
      "export default {",
      "  euro: '€',",
      "  dollar: '$',",
      "  euro: '€',",
      "  Vdash: '⊩',",
      "  dashv: '⊣',",
      "  vDash: '⊨',",
      "  Vdash: '⊩',",
      "};",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    generatedHandler,
    'let U2={cent:"¢",pound:"£",curren:"¤",yen:"¥",euro:"\\u20AC",dollar:"$",euro:"\\u20AC",fnof:"ƒ",Vdash:"\\u22A9",dashv:"\\u22A3",vDash:"\\u22A8",Vdash:"\\u22A9",Vvdash:"\\u22AA"};',
    "utf8",
  );
  writeFileSync(
    generatedWorker,
    'let U2={cent:"¢",pound:"£",curren:"¤",yen:"¥",euro:"€",dollar:"$",euro:"€",fnof:"ƒ",Vdash:"⊩",dashv:"⊣",vDash:"⊨",Vdash:"⊩",Vvdash:"⊪"};',
    "utf8",
  );

  const result = runPatch(scriptPath);
  assert.equal(result.status, 0, result.stderr);

  const patchedSource = readFileSync(nodableEntities, "utf8");
  const patchedHandler = readFileSync(generatedHandler, "utf8");
  const patchedWorker = readFileSync(generatedWorker, "utf8");

  for (const patched of [patchedSource, patchedHandler, patchedWorker]) {
    assert.doesNotMatch(patched, /euro\s*:\s*(["'])(?:\\u20AC|€)\1\s*,\s*dollar\s*:\s*(["'])\$\2\s*,\s*euro\s*:/);
    assert.doesNotMatch(patched, /Vdash\s*:\s*(["'])(?:\\u22A9|⊩)\1\s*,\s*dashv\s*:\s*(["'])(?:\\u22A3|⊣)\2\s*,\s*vDash\s*:\s*(["'])(?:\\u22A8|⊨)\3\s*,\s*Vdash\s*:/);
  }

  assert.match(patchedHandler, /euro:"\\u20AC",dollar:"\$",fnof/);
  assert.match(patchedWorker, /Vdash:"⊩",dashv:"⊣",vDash:"⊨",Vvdash/);
});

test("patch-opennext-native-shims fails loud on pretty-printed unpatched ObjectStorage loader", () => {
  const { scriptPath, generatedHandler } = createFixture();
  writeFileSync(
    generatedHandler,
    [
      "const x = {",
      "  ObjectStorage:",
      "    async () =>",
      "      import(\"../ObjectStorage.js\"),",
      "};",
    ].join("\n"),
    "utf8",
  );

  const result = runPatch(scriptPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unpatched Daytona ObjectStorage loader remains/);
});
