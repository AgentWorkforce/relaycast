import { describe, expect, it } from "vitest";
import { APP_BASE_PATH, toAbsoluteAppUrl, toAppPath } from "./app-path";

describe("app-path base-path resolution", () => {
  it("prefixes a root-relative path with the app base path", () => {
    expect(toAppPath("/api/v1/fleet/register")).toBe(`${APP_BASE_PATH}/api/v1/fleet/register`);
  });

  it("builds the fleet enrollment URL under the base path (not at the bare origin)", () => {
    // This mirrors exactly how the enrollment-tokens route mints `enrollmentUrl`.
    // A bare `${origin}/api/v1/fleet/register` would 404 because the route is
    // registered under the app base path (basePath="/cloud").
    const enrollmentUrl = toAbsoluteAppUrl(
      "https://cloud.test",
      "/api/v1/fleet/register",
    ).toString();
    expect(enrollmentUrl).toBe(`https://cloud.test${APP_BASE_PATH}/api/v1/fleet/register`);
    expect(enrollmentUrl).toContain(`${APP_BASE_PATH}/api/v1/fleet/register`);
  });

  it("does not double-prefix a path that already includes the base path", () => {
    expect(toAbsoluteAppUrl("https://cloud.test", `${APP_BASE_PATH}/api/v1/fleet/register`).toString()).toBe(
      `https://cloud.test${APP_BASE_PATH}/api/v1/fleet/register`,
    );
  });
});
