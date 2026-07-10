import test from "node:test";
import assert from "node:assert/strict";

const {
  getConfiguredAppOrigin,
} = await import(new URL("../packages/web/lib/app-origin.ts", import.meta.url).href);

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("getConfiguredAppOrigin reads the production public app URL", () => {
  const origin = withEnv(
    {
      NEXT_PUBLIC_APP_URL: "https://agentrelay.com/cloud",
    },
    () => getConfiguredAppOrigin(),
  );

  assert.equal(origin, "https://agentrelay.com");
});

test("getConfiguredAppOrigin preserves the local dev localhost origin", () => {
  const origin = withEnv(
    {
      NEXT_PUBLIC_APP_URL: "http://localhost:3000/cloud",
    },
    () => getConfiguredAppOrigin(),
  );

  assert.equal(origin, "http://localhost:3000");
});

test("getConfiguredAppOrigin rejects missing configuration", () => {
  assert.throws(
    () =>
      withEnv(
        {
          NEXT_PUBLIC_APP_URL: undefined,
        },
        () => getConfiguredAppOrigin(),
      ),
    /Trusted app origin is not configured/,
  );
});
