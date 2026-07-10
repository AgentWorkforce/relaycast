"use client";

import Nango from "@nangohq/frontend";
import { toAppPath } from "@/lib/app-path";

export interface NangoConnectResult {
  connectionId: string;
  providerConfigKey?: string | null;
}

export interface IntegrationListEntry {
  provider: string;
  providerConfigKey: string | null;
  status: string;
  connectionId?: string;
}

function readConnectResult(value: unknown): NangoConnectResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const payload = record.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const payloadResult = readConnectResult(payload);
    if (payloadResult) return payloadResult;
  }

  const rawConnectionId = record.connectionId ?? record.connection_id;
  if (typeof rawConnectionId !== "string" || !rawConnectionId.trim()) {
    return null;
  }

  const rawProviderConfigKey = record.providerConfigKey ?? record.provider_config_key;
  return {
    connectionId: rawConnectionId.trim(),
    providerConfigKey:
      typeof rawProviderConfigKey === "string"
        ? rawProviderConfigKey
        : rawProviderConfigKey === null
          ? null
          : undefined,
  };
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return fallback;

  try {
    const payload = JSON.parse(text) as { error?: string; message?: string };
    return payload.error || payload.message || fallback;
  } catch {
    return text;
  }
}

/**
 * Browser hook that opens the Nango Connect modal for a provider, mirroring the
 * dashboard's `useNangoConnect`. Used by the wizard's integrations step.
 */
export function useNangoConnect(workspaceId: string) {
  async function requestSession(allowedIntegrations: string[]): Promise<string> {
    const res = await fetch(
      toAppPath(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/connect-session`,
      ),
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedIntegrations }),
      },
    );
    if (!res.ok) throw new Error("Failed to create connect session.");
    const payload = (await res.json()) as { token?: string };
    if (!payload.token) throw new Error("Failed to create connect session.");
    return payload.token;
  }

  async function openConnectUi(sessionToken: string): Promise<NangoConnectResult> {
    const nango = new Nango();
    return await new Promise<NangoConnectResult>((resolve, reject) => {
      let settled = false;
      const connectUi = nango.openConnectUI({
        detectClosedAuthWindow: true,
        onEvent: (event) => {
          if (settled) return;
          if (event.type === "connect") {
            const result = readConnectResult(event);
            if (!result) {
              settled = true;
              connectUi.close();
              reject(new Error("Failed to read connection result."));
              return;
            }
            // Resolve on `connect` but intentionally DO NOT call
            // connectUi.close() here. Per the Nango sample app
            // (NangoHQ/sample-app IntegrationGrid.tsx), Nango closes its own
            // Connect UI + the OAuth popup after a successful connect.
            // Force-closing the iframe in this handler tears it down mid-flow
            // and orphans the OAuth popup — the "popup stays open / wizard
            // never flips to Connected" bug. Resolving without closing also
            // means we never hang if the trailing `close` event doesn't fire.
            settled = true;
            resolve(result);
            return;
          }
          if (event.type === "error") {
            settled = true;
            connectUi.close();
            const payload = event.payload as { errorMessage?: string } | undefined;
            reject(new Error(payload?.errorMessage || "Connection failed."));
          }
          if (event.type === "close") {
            const result = readConnectResult(event);
            settled = true;
            if (result) {
              resolve(result);
            } else {
              reject(new Error("Connection dialog was closed."));
            }
          }
        },
      });
      connectUi.setSessionToken(sessionToken);
    });
  }

  async function listIntegrations(): Promise<IntegrationListEntry[]> {
    const response = await fetch(
      toAppPath(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations`),
      {
        credentials: "include",
      },
    );

    if (!response.ok) {
      throw new Error(await readErrorMessage(response, "Failed to refresh integrations."));
    }

    const payload = (await response.json()) as unknown;
    return Array.isArray(payload) ? (payload as IntegrationListEntry[]) : [];
  }

  async function saveIntegration(input: {
    provider: string;
    providerConfigKey: string;
    result: NangoConnectResult;
  }): Promise<void> {
    const response = await fetch(
      toAppPath(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/${input.provider}`),
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: input.result.connectionId,
          providerConfigKey: input.result.providerConfigKey ?? input.providerConfigKey,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(await readErrorMessage(response, "Failed to save integration."));
    }
  }

  return { requestSession, openConnectUi, saveIntegration, listIntegrations };
}
