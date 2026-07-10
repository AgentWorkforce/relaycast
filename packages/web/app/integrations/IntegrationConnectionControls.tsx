"use client";

import Nango from "@nangohq/frontend";
import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { toAppPath } from "@/lib/app-path";
import type { WorkspaceIntegrationProvider } from "@/lib/integrations/providers";

type ConnectResult = {
  connectionId: string;
  providerConfigKey?: string | null;
};


type Props = {
  workspaceId: string;
  provider: WorkspaceIntegrationProvider;
  providerLabel: string;
  providerConfigKey: string;
  nangoHost: string;
  connected: boolean;
  connectionId: string | null;
  onMutate?: () => void | Promise<void>;
};

type DisconnectResponse = {
  success?: boolean;
  upstreamDelete?: {
    success?: boolean;
    backend?: string | null;
    error?: string | null;
  };
};

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return fallback;
  }

  try {
    const payload = JSON.parse(text) as { error?: string };
    return payload.error || fallback;
  } catch {
    return text;
  }
}

function readConnectResult(value: unknown): ConnectResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const payload = record.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const payloadResult = readConnectResult(payload);
    if (payloadResult) {
      return payloadResult;
    }
  }

  const rawConnectionId = record.connectionId ?? record.connection_id;
  if (typeof rawConnectionId !== "string" || !rawConnectionId.trim()) {
    return null;
  }

  const rawProviderConfigKey =
    record.providerConfigKey ?? record.provider_config_key;

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

export function IntegrationConnectionControls({
  workspaceId,
  provider,
  providerLabel,
  providerConfigKey,
  nangoHost,
  connected,
  connectionId,
  onMutate,
}: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function requestConnectSession(): Promise<string> {
    const response = await fetch(
      toAppPath(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/connect-session`),
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          allowedIntegrations: [providerConfigKey],
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        await readErrorMessage(response, `Failed to create a ${providerLabel} connect session.`),
      );
    }

    const payload = (await response.json()) as { token?: string };
    if (!payload.token) {
      throw new Error(`Failed to create a ${providerLabel} connect session.`);
    }

    return payload.token;
  }

  async function openConnectUi(sessionToken: string): Promise<ConnectResult> {
    const nango = new Nango();

    return await new Promise<ConnectResult>((resolve, reject) => {
      let settled = false;
      let connectResult: ConnectResult | null = null;
      const connectUi = nango.openConnectUI({
        sessionToken,
        apiURL: nangoHost,
        detectClosedAuthWindow: true,
        onEvent: (event) => {
          if (settled) {
            return;
          }

          if (event.type === "connect") {
            const result = readConnectResult(event);
            if (!result) {
              settled = true;
              connectUi.close();
              reject(new Error(`Failed to read the ${providerLabel} connection result.`));
              return;
            }

            connectResult = result;
            settled = true;
            connectUi.close();
            resolve(result);
            return;
          }

          if (event.type === "error") {
            settled = true;
            connectUi.close();
            reject(new Error(event.payload.errorMessage || `Failed to connect ${providerLabel}.`));
            return;
          }

          if (event.type === "close") {
            const result = readConnectResult(event) ?? connectResult;
            if (result) {
              settled = true;
              resolve(result);
              return;
            }

            settled = true;
            reject(new Error(`${providerLabel} connect flow was closed before it completed.`));
          }
        },
      });

      connectUi.open();
    });
  }

  async function saveIntegration(result: ConnectResult): Promise<void> {
    const response = await fetch(
      toAppPath(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/${provider}`),
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: result.connectionId,
          providerConfigKey: result.providerConfigKey ?? providerConfigKey,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        await readErrorMessage(response, `Failed to save the ${providerLabel} connection.`),
      );
    }
  }

  async function handleConnect() {
    setPending(true);
    setPendingLabel(`Opening ${providerLabel}...`);
    setError(null);
    setNotice(null);

    try {
      const sessionToken = await requestConnectSession();
      setPendingLabel(`Waiting for ${providerLabel} authorization...`);
      const result = await openConnectUi(sessionToken);
      setPendingLabel(`Saving ${providerLabel} connection...`);
      await saveIntegration(result);
      setPendingLabel(`Refreshing ${providerLabel}...`);
      await onMutate?.();
      startTransition(() => router.refresh());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Failed to connect ${providerLabel}.`);
    } finally {
      setPendingLabel(null);
      setPending(false);
    }
  }

  async function handleDisconnect() {
    setPending(true);
    setPendingLabel(`Disconnecting ${providerLabel}...`);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(
        toAppPath(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/${provider}`),
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (!response.ok) {
        throw new Error(
          await readErrorMessage(response, `Failed to disconnect ${providerLabel}.`),
        );
      }

      const payload = await response.json().catch(() => null) as DisconnectResponse | null;
      if (payload?.upstreamDelete?.success === false) {
        const backendLabel =
          payload.upstreamDelete.backend === "nango"
            ? "Nango"
            : "upstream backend";
        const upstreamError = payload.upstreamDelete.error
          ? ` ${payload.upstreamDelete.error}`
          : "";
        setNotice(
          `Disconnected locally, but ${backendLabel} deletion failed.${upstreamError}`,
        );
      }

      setPendingLabel(`Refreshing ${providerLabel}...`);
      try {
        await onMutate?.();
      } catch (refreshError) {
        setError(
          refreshError instanceof Error
            ? `Disconnected ${providerLabel}, but failed to refresh the page state: ${refreshError.message}`
            : `Disconnected ${providerLabel}, but failed to refresh the page state.`,
        );
      }
      startTransition(() => router.refresh());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Failed to disconnect ${providerLabel}.`);
    } finally {
      setPendingLabel(null);
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant={connected ? "outline" : "default"}
          onClick={connected ? handleDisconnect : handleConnect}
          disabled={pending}
        >
          {pending ? (
            <>
              <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
              <span aria-live="polite">{pendingLabel ?? "Working..."}</span>
            </>
          ) : connected ? (
            `Disconnect ${providerLabel}`
          ) : (
            `Connect ${providerLabel}`
          )}
        </Button>
        <span className="text-sm text-[var(--muted-foreground)]">
          {connected && connectionId
            ? `Connected via ${connectionId}`
            : `No ${providerLabel} connection stored for this workspace.`}
        </span>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {notice ? (
        <p role="alert" className="text-sm text-amber-700">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
