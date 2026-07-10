import baseConfig from "../../../vitest.config";

const exclude = (baseConfig.test?.exclude ?? []).filter(
  (pattern) => pattern !== "tests/proactive-runtime/vitest/deploy-manager.integration.test.ts",
);

export default {
  ...baseConfig,
  test: {
    ...baseConfig.test,
    exclude,
  },
};
