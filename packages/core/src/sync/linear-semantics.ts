import { LinearAdapter } from "@relayfile/adapter-linear";
import type { ConnectionProvider, FileSemantics } from "@relayfile/sdk";

const NOOP_CLIENT = {
  writeFile: async () => {
    throw new Error("LinearAdapter stub client should not be invoked");
  },
};

const NOOP_PROVIDER: ConnectionProvider = {
  name: "linear",
  proxy: async () => {
    throw new Error("LinearAdapter stub provider should not be invoked");
  },
  healthCheck: async () => false,
};

const linearAdapter = new LinearAdapter(NOOP_CLIENT, NOOP_PROVIDER);

export interface LinearSyncContext {
  connectionId: string;
  model: string;
  providerConfigKey: string;
  syncName: string;
}

export function buildLinearSyncSemantics(
  objectType: string,
  objectId: string,
  record: Record<string, unknown>,
  context: LinearSyncContext,
): FileSemantics {
  const base = linearAdapter.computeSemantics(objectType, objectId, record);
  return {
    ...base,
    properties: {
      ...(base.properties ?? {}),
      "nango.connection_id": context.connectionId,
      "nango.model": context.model,
      "nango.provider_config_key": context.providerConfigKey,
      "nango.sync_name": context.syncName,
    },
  };
}
