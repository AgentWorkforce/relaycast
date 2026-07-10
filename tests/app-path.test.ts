import test from "node:test";
import assert from "node:assert/strict";

const {
  APP_BASE_PATH,
  stripAppBasePath,
  toAbsoluteAppUrl,
  toAppPath,
} = await import(new URL("../packages/web/lib/app-path.ts", import.meta.url).href);

test("trusted origin builds app URLs under the cloud base path", () => {
  const inviteBaseUrl = toAbsoluteAppUrl("https://agentrelay.com", "/").toString();

  assert.equal(inviteBaseUrl, `https://agentrelay.com${APP_BASE_PATH}`);
  assert.equal(toAppPath("/invite/token-123"), `${APP_BASE_PATH}/invite/token-123`);
});

test("stripAppBasePath normalizes app routes back to app-relative paths", () => {
  assert.equal(stripAppBasePath(`${APP_BASE_PATH}/invite/token-123`), "/invite/token-123");
  assert.equal(stripAppBasePath(APP_BASE_PATH), "/");
  assert.equal(stripAppBasePath("/dashboard"), "/dashboard");
});
