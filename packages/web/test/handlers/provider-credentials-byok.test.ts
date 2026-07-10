// @handler /api/v1/workspaces/[workspaceId]/provider-credentials/byok
import { expect } from "vitest";

expect.extend({
  toHaveBeenCalledAfter(received: { mock?: { invocationCallOrder?: number[] } }, target: { mock?: { invocationCallOrder?: number[] } }) {
    const receivedOrder = received.mock?.invocationCallOrder?.[0];
    const targetOrder = target.mock?.invocationCallOrder?.[0];

    const pass =
      typeof receivedOrder === "number" &&
      typeof targetOrder === "number" &&
      receivedOrder > targetOrder;

    return {
      pass,
      message: () =>
        pass
          ? `expected mock not to be called after ${targetOrder}`
          : `expected mock to be called after ${targetOrder}, received ${receivedOrder}`,
    };
  },
});

import "../../app/api/v1/workspaces/[workspaceId]/provider-credentials/byok/route.test.ts";
