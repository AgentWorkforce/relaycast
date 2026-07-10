import { describe, expect, it } from "vitest";

import {
  deployDigestFunction,
  disableDigestFunction,
  fetchRecentInvocationLogs,
  getDigestFunction,
  listDigestFunctions,
  parseDigestFunctionDeployRequest,
} from "./index";

describe("digest-functions public exports", () => {
  it("exports the orchestration functions used by route handlers", () => {
    expect(deployDigestFunction).toEqual(expect.any(Function));
    expect(listDigestFunctions).toEqual(expect.any(Function));
    expect(parseDigestFunctionDeployRequest).toEqual(expect.any(Function));
    expect(getDigestFunction).toEqual(expect.any(Function));
    expect(disableDigestFunction).toEqual(expect.any(Function));
    expect(fetchRecentInvocationLogs).toEqual(expect.any(Function));
  });
});
