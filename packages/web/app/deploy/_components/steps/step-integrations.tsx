"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CheckCircle2, Copy, Loader2 } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Badge } from "@/app/components/ui/badge";
import { ProviderLogo } from "@/app/components/ProviderLogo";
import {
  DAYTONA_CONNECT_COMMAND,
  checkDaytonaConnected,
  isCliCapturedProvider,
} from "../../_lib/daytona-status-client";
import { useNangoConnect } from "../../_lib/use-nango-connect";
import {
  joinGithubInstallation,
  readSessionToken,
  requestGithubConnectSession,
  resolveGithubInstallationBranch,
  type GithubInstallationMatch,
} from "../../_lib/github-installation-flow-client";
import {
  connectedIntegrationStatesFromList,
  fetchWorkspaceIntegrations,
} from "../../_lib/workspace-integrations-client";
import type { DeployMode, IntegrationState, PersonaIntegrationSummary } from "../../_lib/types";

type StepIntegrationsProps = {
  mode: DeployMode;
  workspaceId: string | null;
  integrations: PersonaIntegrationSummary[];
  states: Record<string, IntegrationState>;
  onChange: (provider: string, state: IntegrationState) => void;
};

type GithubOffer = {
  provider: string;
  match: GithubInstallationMatch;
  oauthConnectionId: string;
  status?: "pending" | "ambiguous" | "no_workspace";
  message?: string;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function StepIntegrations({
  mode,
  workspaceId,
  integrations,
  states,
  onChange,
}: StepIntegrationsProps) {
  const { requestSession, openConnectUi, saveIntegration, listIntegrations } = useNangoConnect(workspaceId ?? "");
  const [githubOffer, setGithubOffer] = useState<GithubOffer | null>(null);
  const shouldCheckExisting = mode === "live" && Boolean(workspaceId) && integrations.length > 0;
  const [checkingExisting, setCheckingExisting] = useState(shouldCheckExisting);
  const onChangeRef = useRef(onChange);
  const integrationSignature = integrations
    .map((integration) => `${integration.provider}:${integration.providerConfigKey}`)
    .join("|");

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!shouldCheckExisting || !workspaceId) {
      setCheckingExisting(false);
      return;
    }

    let active = true;
    setCheckingExisting(true);
    fetchWorkspaceIntegrations(workspaceId)
      .then((entries) => {
        if (!active) return;
        const connectedStates = connectedIntegrationStatesFromList(integrations, entries);
        for (const state of Object.values(connectedStates)) {
          onChangeRef.current(state.provider, state);
        }
      })
      .catch(() => {
        // Existing-connection detection is a convenience; failed reads should
        // not block a new OAuth connection from the wizard.
      })
      .finally(() => {
        if (active) setCheckingExisting(false);
      });

    return () => {
      active = false;
    };
  }, [shouldCheckExisting, workspaceId, integrationSignature]);

  async function refreshConnectedIntegration(integration: PersonaIntegrationSummary): Promise<string | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) {
        await wait(500);
      }

      const entries = await listIntegrations();
      const connected = entries.find((entry) => entry.providerConfigKey === integration.providerConfigKey)
        ?? entries.find(
          (entry) =>
            entry.provider === integration.provider &&
            (entry.providerConfigKey === null || entry.providerConfigKey === integration.providerConfigKey),
        );
      if (connected?.connectionId) {
        return connected.connectionId;
      }
    }

    return null;
  }

  async function completeWorkspaceConnect(
    integration: PersonaIntegrationSummary,
    sessionToken?: string | null,
  ) {
    const token = sessionToken ?? await requestSession([integration.providerConfigKey]);
    const result = await openConnectUi(token);
    await saveIntegration({
      provider: integration.provider,
      providerConfigKey: integration.providerConfigKey,
      result,
    });
    const connectionId = await refreshConnectedIntegration(integration);
    if (!connectionId) {
      throw new Error(`${integration.label} authorization finished, but the workspace connection is not ready yet.`);
    }
    onChange(integration.provider, {
      provider: integration.provider,
      state: "connected",
      connectionId,
    });
  }

  async function connect(integration: PersonaIntegrationSummary) {
    if (!workspaceId) {
      onChange(integration.provider, {
        provider: integration.provider,
        state: "error",
        error: "Choose a workspace before connecting integrations.",
      });
      return;
    }

    onChange(integration.provider, { provider: integration.provider, state: "connecting" });
    try {
      setGithubOffer(null);
      if (integration.provider === "github") {
        const branch = await resolveGithubInstallationBranch({
          workspaceId,
          providerConfigKey: integration.providerConfigKey,
          openConnectUi,
        });
        if (branch.kind === "inherit") {
          setGithubOffer({
            provider: integration.provider,
            match: branch.match,
            oauthConnectionId: branch.oauthConnectionId,
          });
          onChange(integration.provider, { provider: integration.provider, state: "idle" });
          return;
        }
        if (branch.kind === "disabled") {
          await completeWorkspaceConnect(integration, readSessionToken(branch.session));
          return;
        }
      }

      await completeWorkspaceConnect(integration);
    } catch (error) {
      if (mode !== "demo") {
        const connectionId = await refreshConnectedIntegration(integration).catch(() => null);
        if (connectionId) {
          onChange(integration.provider, {
            provider: integration.provider,
            state: "connected",
            connectionId,
          });
          return;
        }
      }

      if (mode === "demo") {
        await wait(900);
        onChange(integration.provider, {
          provider: integration.provider,
          state: "connected",
          connectionId: `demo-${integration.provider}`,
        });
        return;
      }
      onChange(integration.provider, {
        provider: integration.provider,
        state: "error",
        error: error instanceof Error ? error.message : "Connection failed.",
      });
    }
  }

  async function installGithub(integration: PersonaIntegrationSummary) {
    if (!workspaceId) return;
    setGithubOffer(null);
    onChange(integration.provider, { provider: integration.provider, state: "connecting" });
    try {
      const session = await requestGithubConnectSession({
        workspaceId,
        providerConfigKey: integration.providerConfigKey,
      });
      await completeWorkspaceConnect(integration, readSessionToken(session));
    } catch (error) {
      onChange(integration.provider, {
        provider: integration.provider,
        state: "error",
        error: error instanceof Error ? error.message : "Connection failed.",
      });
    }
  }

  async function inheritGithub(integration: PersonaIntegrationSummary, offer: GithubOffer) {
    if (!workspaceId) return;
    onChange(integration.provider, { provider: integration.provider, state: "connecting" });
    try {
      const outcome = await joinGithubInstallation({
        workspaceId,
        installationId: offer.match.installationId,
        oauthConnectionId: offer.oauthConnectionId,
      });
      if (outcome.kind === "connected") {
        setGithubOffer(null);
        onChange(integration.provider, {
          provider: integration.provider,
          state: "connected",
          connectionId: `github-installation:${offer.match.installationId}`,
        });
        return;
      }
      if (outcome.kind === "pending") {
        setGithubOffer({
          ...offer,
          status: "pending",
          message: "Join request sent. An organization owner or admin must approve it before this workspace can use the GitHub App.",
        });
        onChange(integration.provider, { provider: integration.provider, state: "idle" });
        return;
      }
      if (outcome.kind === "ambiguous") {
        setGithubOffer({
          ...offer,
          status: "ambiguous",
          message: "Choose a destination workspace after approval before continuing.",
        });
        onChange(integration.provider, { provider: integration.provider, state: "idle" });
        return;
      }
      if (outcome.kind === "no_workspace") {
        setGithubOffer({
          ...offer,
          status: "no_workspace",
          message: outcome.message,
        });
        onChange(integration.provider, { provider: integration.provider, state: "idle" });
        return;
      }
      throw new Error(outcome.message);
    } catch (error) {
      onChange(integration.provider, {
        provider: integration.provider,
        state: "error",
        error: error instanceof Error ? error.message : "Connection failed.",
      });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {integrations.map((integration) => {
        const state = states[integration.provider];
        if (isCliCapturedProvider(integration.provider)) {
          return (
            <DaytonaIntegrationRow
              key={integration.provider}
              mode={mode}
              workspaceId={workspaceId}
              integration={integration}
              state={state}
              onChange={onChange}
            />
          );
        }
        const connecting = state?.state === "connecting";
        const connected = state?.state === "connected";
        const checking = checkingExisting && !connected && !connecting;
        const offer = integration.provider === "github" ? githubOffer : null;

        return (
          <div
            key={integration.provider}
            className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-5"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-4">
                <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-background text-foreground">
                  <ProviderLogo provider={integration.provider} label={integration.label} size={20} />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-foreground">{integration.label}</p>
                    {connected ? <Badge variant="success">Connected</Badge> : null}
                  </div>
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">{integration.description}</p>
                </div>
              </div>
              <Button
                variant={connected ? "outline" : "default"}
                disabled={checking || connecting || !workspaceId}
                onClick={() => void connect(integration)}
              >
                {checking || connecting ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
                {connected ? <CheckCircle2 aria-hidden="true" /> : null}
                {checking ? "Checking" : connecting ? "Connecting" : connected ? "Reconnect" : "Connect"}
              </Button>
            </div>
            {state?.state === "error" && state.error ? (
              <p className="mt-3 rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] p-3 text-sm text-[var(--status-danger)]">
                {state.error}
              </p>
            ) : null}
            {offer ? (
              <div className="mt-4 rounded-xl border border-[var(--border-default)] bg-background p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {offer.match.accountLogin ?? "This GitHub organization"} already uses AgentWorkforce.
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {offer.message ?? "Join the existing organization connection, or install the GitHub App for this workspace."}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={connecting || offer.status === "pending"}
                      onClick={() => void installGithub(integration)}
                    >
                      Install
                    </Button>
                    <Button
                      type="button"
                      disabled={connecting || offer.status === "pending" || offer.status === "no_workspace"}
                      onClick={() => void inheritGithub(integration, offer)}
                    >
                      {offer.status === "pending"
                        ? "Pending"
                        : offer.status === "no_workspace"
                          ? "Unavailable"
                          : "Join"}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

type DaytonaIntegrationRowProps = {
  mode: DeployMode;
  workspaceId: string | null;
  integration: PersonaIntegrationSummary;
  state: IntegrationState | undefined;
  onChange: (provider: string, state: IntegrationState) => void;
};

/**
 * Daytona row: instruct + poll. Daytona is captured by the relay CLI, not a
 * Nango OAuth popup (see daytona-status-client), so this row shows the terminal
 * command to run and polls the status route, flipping to "Connected" when the
 * credential lands. The wizard's deploy gate keys on the same `connected` state
 * as every other provider, so no gating change is needed.
 */
function DaytonaIntegrationRow({
  mode,
  workspaceId,
  integration,
  state,
  onChange,
}: DaytonaIntegrationRowProps) {
  const connected = state?.state === "connected";
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const markConnected = useCallback(
    (connectionId: string) => {
      onChangeRef.current(integration.provider, {
        provider: integration.provider,
        state: "connected",
        connectionId,
      });
    },
    [integration.provider],
  );

  // Demo mode: there is no real cloud to poll — auto-connect after a beat so the
  // demo wizard isn't stuck on the gate, mirroring the Nango rows' demo path.
  useEffect(() => {
    if (mode !== "demo" || connected) return;
    const timer = setTimeout(() => markConnected(`demo-${integration.provider}`), 900);
    return () => clearTimeout(timer);
  }, [mode, connected, integration.provider, markConnected]);

  // Live mode: poll the status route until the credential lands. The first poll
  // fires immediately, so a persona whose daytona credential already exists
  // shows "Connected" on arrival without any user action.
  useEffect(() => {
    if (mode !== "live" || !workspaceId || connected) return;

    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      setBusy(true);
      let ok = false;
      try {
        ok = await checkDaytonaConnected(workspaceId);
      } catch {
        ok = false;
      }
      if (!active) return;
      setBusy(false);
      if (ok) {
        markConnected("daytona");
        return;
      }
      timer = setTimeout(() => void poll(), 4000);
    };

    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [mode, workspaceId, connected, markConnected]);

  function handleCopy() {
    void navigator.clipboard?.writeText(DAYTONA_CONNECT_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function checkNow() {
    if (!workspaceId || busy) return;
    setBusy(true);
    try {
      if (await checkDaytonaConnected(workspaceId)) {
        markConnected("daytona");
        return;
      }
    } catch {
      // Transient failure — the auto-poll keeps retrying.
    }
    setBusy(false);
  }

  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-background text-foreground">
            <ProviderLogo provider={integration.provider} label={integration.label} size={20} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-foreground">{integration.label}</p>
              {connected ? <Badge variant="success">Connected</Badge> : null}
            </div>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">{integration.description}</p>
          </div>
        </div>
        {connected ? (
          <Button variant="outline" disabled>
            <CheckCircle2 aria-hidden="true" />
            Connected
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={busy || !workspaceId}
            onClick={() => void checkNow()}
          >
            {busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            {busy ? "Checking" : "Check connection"}
          </Button>
        )}
      </div>
      {connected ? null : (
        <div className="mt-4 rounded-xl border border-[var(--border-default)] bg-background p-4">
          <p className="text-sm font-medium text-foreground">
            Connect Daytona from your terminal
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Daytona connects via the CLI. Run this command, complete the browser login, and this
            step updates automatically once the credential is stored.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-lg bg-[var(--surface-soft)] px-3 py-2 font-mono text-sm text-foreground">
              {DAYTONA_CONNECT_COMMAND}
            </code>
            <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden="true" className="animate-spin" />
            Waiting for the Daytona credential…
          </p>
        </div>
      )}
      {state?.state === "error" && state.error ? (
        <p className="mt-3 rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] p-3 text-sm text-[var(--status-danger)]">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
