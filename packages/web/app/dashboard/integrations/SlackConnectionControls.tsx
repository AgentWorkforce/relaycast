"use client";

import { IntegrationConnectionControls } from "../../integrations/IntegrationConnectionControls";
import { useDashboard } from "../_components/dashboard-data";

type Props = {
  connected: boolean;
  connectionId: string | null;
  nangoHost: string;
  providerConfigKey: string;
};

export function SlackConnectionControls({
  connected,
  connectionId,
  nangoHost,
  providerConfigKey,
}: Props) {
  const { authSession, authenticated, sessionLoading } = useDashboard();

  if (sessionLoading) {
    return (
      <p className="text-sm text-muted-foreground">
        Loading workspace session before opening the Slack connect flow.
      </p>
    );
  }

  if (!authenticated || !authSession) {
    return (
      <p className="text-sm text-muted-foreground">
        Sign in to manage the Slack connection for this workspace.
      </p>
    );
  }

  return (
    <IntegrationConnectionControls
      workspaceId={authSession.currentWorkspace.id}
      provider="slack"
      providerLabel="Slack"
      providerConfigKey={providerConfigKey}
      nangoHost={nangoHost}
      connected={connected}
      connectionId={connectionId}
    />
  );
}
