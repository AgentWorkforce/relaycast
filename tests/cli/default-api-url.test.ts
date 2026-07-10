import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { defaultApiUrl } from "../../packages/cli/src/cli/constants.js";
import { resolveApiUrl } from "../../packages/cli/src/credentials.js";

describe("CLI API URL defaults", () => {
  it("defaults the interactive CLI to the cloud base path", () => {
    const previous = process.env.CLOUD_API_URL;
    delete process.env.CLOUD_API_URL;

    try {
      assert.equal(defaultApiUrl(), "https://agentrelay.com/cloud");
    } finally {
      if (previous === undefined) {
        delete process.env.CLOUD_API_URL;
      } else {
        process.env.CLOUD_API_URL = previous;
      }
    }
  });

  it("defaults stored-credentials flows to the local cloud base path", () => {
    const previous = process.env.CLOUD_API_URL;
    delete process.env.CLOUD_API_URL;

    try {
      assert.equal(resolveApiUrl(), "http://localhost:3000/cloud");
    } finally {
      if (previous === undefined) {
        delete process.env.CLOUD_API_URL;
      } else {
        process.env.CLOUD_API_URL = previous;
      }
    }
  });
});
