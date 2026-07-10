"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, RefreshCw, Rocket } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Skeleton } from "@/app/components/ui/skeleton";
import {
  createModelCredentialSelection,
  deployPersona,
  hasActiveSubscriptionCredential,
  subscriptionCredentialMissingMessage,
} from "../_lib/deploy-client";
import {
  fetchAlreadyDeployedAgents,
  type DeployedAgentMatch,
} from "../_lib/deployed-status-client";
import { resolvePersona } from "../_lib/persona-client";
import { buildDeployLoginHref } from "../_lib/deploy-login-href";
import { useDeploySession } from "../_lib/use-deploy-session";
import type {
  DeployMode,
  DeployPhase,
  DeployResult,
  HarnessSource,
  IntegrationState,
  ResolvedPersona,
  WizardStepId,
  WizardStepMeta,
} from "../_lib/types";
import { AlreadyDeployedNotice } from "./already-deployed-notice";
import { DeployedSuccess } from "./deployed-success";
import { GithubAccessPrompt } from "./github-access-prompt";
import { StepDeploy } from "./steps/step-deploy";
import { StepInputs } from "./steps/step-inputs";
import { StepIntegrations } from "./steps/step-integrations";
import { StepModel } from "./steps/step-model";
import { StepReview } from "./steps/step-review";
import { StepWorkspace } from "./steps/step-workspace";
import { WizardStepper } from "./wizard-stepper";

type DeployWizardProps = {
  personaUrl: string | null;
  mode: DeployMode;
};

const STEP_META: Record<WizardStepId, WizardStepMeta> = {
  review: {
    id: "review",
    title: "Review persona",
    shortTitle: "Review",
    description: "Understand what this agent does before launching it.",
  },
  workspace: {
    id: "workspace",
    title: "Choose workspace",
    shortTitle: "Workspace",
    description: "Pick the cloud workspace where the agent will run.",
  },
  integrations: {
    id: "integrations",
    title: "Connect integrations",
    shortTitle: "Integrations",
    description: "Authorize provider access required by the persona.",
  },
  model: {
    id: "model",
    title: "Connect model",
    shortTitle: "Model",
    description: "Select how the agent gets model access.",
  },
  inputs: {
    id: "inputs",
    title: "Configure inputs",
    shortTitle: "Inputs",
    description: "Fill in the runtime values this persona expects.",
  },
  deploy: {
    id: "deploy",
    title: "Deploy agent",
    shortTitle: "Deploy",
    description: "Launch the agent into the selected workspace.",
  },
};

function inputDefaults(resolved: ResolvedPersona | null): Record<string, string> {
  if (!resolved) return {};
  return Object.fromEntries(resolved.summary.inputs.map((input) => [input.key, input.default ?? ""]));
}

function nextDeployPhase(message: string): DeployPhase {
  const lowered = message.toLowerCase();
  if (lowered.includes("provision") || lowered.includes("register")) return "provisioning";
  if (lowered.includes("live") || lowered.includes("ready")) return "ready";
  return "submitting";
}

export function initialHarnessSourceForPersona(persona: ResolvedPersona["summary"]): HarnessSource | null {
  if (!persona.harness) {
    return null;
  }
  if (!persona.useSubscription) {
    return "plan";
  }
  return persona.modelProvider === "openai" || persona.modelProvider === "anthropic" ? "oauth" : "byok";
}

export function isDeployModelSelectionValid(input: {
  persona: ResolvedPersona["summary"] | null;
  harnessSource: HarnessSource | null;
  byokKey: string;
}): boolean {
  if (!input.persona?.harness) {
    return true;
  }
  const { persona, harnessSource, byokKey } = input;
  return (
    (!persona.useSubscription && harnessSource === "plan") ||
    (persona.useSubscription &&
      (persona.modelProvider === "openai" || persona.modelProvider === "anthropic") &&
      harnessSource === "oauth") ||
    (persona.useSubscription && harnessSource === "managed") ||
    (harnessSource === "byok" && byokKey.trim().length > 0)
  );
}

export function DeployWizard({ personaUrl, mode }: DeployWizardProps) {
  const session = useDeploySession();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const signInHref = buildDeployLoginHref(pathname, searchParams);
  const [resolved, setResolved] = useState<ResolvedPersona | null>(null);
  const [personaLoading, setPersonaLoading] = useState(true);
  const [personaError, setPersonaError] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [integrationStates, setIntegrationStates] = useState<Record<string, IntegrationState>>({});
  const [harnessSource, setHarnessSource] = useState<HarnessSource | null>(null);
  const [byokKey, setByokKey] = useState("");
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [deployPhase, setDeployPhase] = useState<DeployPhase>("idle");
  const [deployResult, setDeployResult] = useState<DeployResult | null>(null);
  const [deployProgress, setDeployProgress] = useState<string[]>([]);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [subscriptionCredentialReady, setSubscriptionCredentialReady] = useState<boolean | null>(null);
  const [alreadyDeployed, setAlreadyDeployed] = useState<DeployedAgentMatch[] | null>(null);
  // Bumped by the "Retry" action on a blocked resolve so the operator can
  // re-resolve after granting GitHub access without reloading the page.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    setPersonaLoading(true);
    setPersonaError(null);

    resolvePersona(personaUrl, mode)
      .then((nextResolved) => {
        if (!active) return;
        setResolved(nextResolved);
        setInputValues(inputDefaults(nextResolved));
        setHarnessSource(initialHarnessSourceForPersona(nextResolved.summary));
        setIntegrationStates(
          Object.fromEntries(
            nextResolved.summary.integrations.map((integration) => [
              integration.provider,
              { provider: integration.provider, state: "idle" as const },
            ]),
          ),
        );
        setStepIndex(0);
        setDeployPhase("idle");
        setDeployResult(null);
        setDeployProgress([]);
        setDeployError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setPersonaError(error instanceof Error ? error.message : "Failed to resolve persona.");
      })
      .finally(() => {
        if (active) setPersonaLoading(false);
      });

    return () => {
      active = false;
    };
  }, [mode, personaUrl, reloadToken]);

  const workspaceId = session.currentWorkspace?.id ?? null;
  const persona = resolved?.summary ?? null;
  const requiresSubscriptionCredential =
    mode === "live" &&
    Boolean(resolved) &&
    !resolved?.demo &&
    Boolean(resolved?.bundle) &&
    persona?.useSubscription === true &&
    harnessSource === "oauth";
  const subscriptionCredentialMessage =
    requiresSubscriptionCredential && subscriptionCredentialReady === false
      ? subscriptionCredentialMissingMessage(persona?.modelProvider)
      : null;
  const subscriptionCredentialChecking = requiresSubscriptionCredential && subscriptionCredentialReady === null;

  // Already-deployed check: live mode only (demo/fallback never fetches),
  // once persona + workspace are both known. Failures resolve to null —
  // no banner, never an error state.
  useEffect(() => {
    setAlreadyDeployed(null);
    if (mode !== "live" || !resolved || resolved.demo || !workspaceId) return;

    let active = true;
    void fetchAlreadyDeployedAgents(workspaceId, resolved.summary.id).then((matches) => {
      if (active) setAlreadyDeployed(matches);
    });
    return () => {
      active = false;
    };
  }, [mode, resolved, workspaceId]);

  useEffect(() => {
    if (!requiresSubscriptionCredential) {
      setSubscriptionCredentialReady(null);
      return;
    }

    let active = true;
    setSubscriptionCredentialReady(null);
    void hasActiveSubscriptionCredential(persona?.modelProvider).then((ready) => {
      if (active) setSubscriptionCredentialReady(ready);
    }).catch(() => {
      if (active) setSubscriptionCredentialReady(false);
    });

    return () => {
      active = false;
    };
  }, [persona?.modelProvider, requiresSubscriptionCredential]);

  const steps = useMemo<WizardStepMeta[]>(() => {
    if (!resolved) return [STEP_META.review, STEP_META.workspace, STEP_META.deploy];
    const stepIds: WizardStepId[] = ["review", "workspace"];
    if (resolved.summary.integrations.length > 0) stepIds.push("integrations");
    if (resolved.summary.harness) stepIds.push("model");
    if (resolved.summary.inputs.length > 0) stepIds.push("inputs");
    stepIds.push("deploy");
    return stepIds.map((id) => STEP_META[id]);
  }, [resolved]);

  useEffect(() => {
    setStepIndex((current) => Math.min(current, steps.length - 1));
  }, [steps.length]);

  const currentStep = steps[stepIndex];
  const allIntegrationsConnected =
    persona?.integrations.every((integration) => integrationStates[integration.provider]?.state === "connected") ?? false;
  const modelValid = isDeployModelSelectionValid({ persona, harnessSource, byokKey });
  const inputsValid =
    persona?.inputs.every((input) => input.optional || (inputValues[input.key] ?? "").trim().length > 0) ?? false;
  const effectiveMode: DeployMode = resolved?.demo ? "demo" : mode;

  const currentStepValid = (() => {
    if (!currentStep) return false;
    if (currentStep.id === "review") return true;
    if (currentStep.id === "workspace") return Boolean(session.currentWorkspace);
    if (currentStep.id === "integrations") return allIntegrationsConnected;
    if (currentStep.id === "model") return modelValid;
    if (currentStep.id === "inputs") return inputsValid;
    if (currentStep.id === "deploy") {
      return Boolean(session.currentWorkspace) &&
        allIntegrationsConnected &&
        modelValid &&
        inputsValid &&
        !subscriptionCredentialChecking &&
        !subscriptionCredentialMessage;
    }
    return false;
  })();

  function updateIntegrationState(provider: string, state: IntegrationState) {
    setIntegrationStates((current) => ({ ...current, [provider]: state }));
  }

  function updateInputValue(key: string, value: string) {
    setInputValues((current) => ({ ...current, [key]: value }));
  }

  async function submitDeploy() {
    if (!resolved || !session.currentWorkspace || deployPhase === "submitting" || deployPhase === "provisioning") {
      return;
    }
    // A blocked live resolve means we only have demo data; never deploy it as if
    // it were the real (private) persona.
    if (resolved.resolveError) {
      return;
    }
    if (subscriptionCredentialChecking || subscriptionCredentialMessage) {
      setDeployError(subscriptionCredentialMessage ?? "Checking active subscription credentials.");
      return;
    }

    setDeployPhase("submitting");
    setDeployError(null);
    setDeployProgress([]);
    try {
      // Only provision a real model credential for a true live deploy. Demo /
      // fallback runs (no bundle) simulate the round-trip and must never hit the
      // provider-credentials endpoints — doing so would 401/500 against the mock
      // workspace and break the demo flow.
      const isLiveDeploy = mode === "live" && !resolved.demo && Boolean(resolved.bundle);
      const credentialSelections = isLiveDeploy
        ? await createModelCredentialSelection({
            workspaceId: session.currentWorkspace.id,
            persona: resolved.summary,
            harnessSource,
            byokKey,
          })
        : {};

      const result = await deployPersona({
        mode,
        workspaceId: session.currentWorkspace.id,
        resolved,
        inputs: inputValues,
        credentialSelections,
        harnessSource,
        onProgress: (message) => {
          setDeployProgress((current) => [...current, message]);
          setDeployPhase(nextDeployPhase(message));
        },
      });
      setDeployResult(result);
      setDeployPhase("ready");
    } catch (error) {
      setDeployPhase("failed");
      setDeployError(error instanceof Error ? error.message : "Deploy failed.");
    }
  }

  function handleContinue() {
    if (!currentStep || !currentStepValid) return;
    if (currentStep.id === "deploy") {
      void submitDeploy();
      return;
    }
    setStepIndex((current) => Math.min(current + 1, steps.length - 1));
  }

  function resetWizard() {
    setDeployResult(null);
    setDeployPhase("idle");
    setDeployProgress([]);
    setDeployError(null);
    setStepIndex(0);
  }

  if (personaLoading) {
    return (
      <Card className="w-full max-w-5xl">
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-9 w-80 max-w-full" />
          <Skeleton className="h-5 w-full max-w-lg" />
        </CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
          <div className="flex flex-col gap-3">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-14 w-full" />
            ))}
          </div>
          <Skeleton className="min-h-[32rem] w-full rounded-2xl" />
        </CardContent>
      </Card>
    );
  }

  if (personaError || !resolved || !persona || !currentStep) {
    return (
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>Persona could not be loaded</CardTitle>
          <CardDescription>{personaError ?? "Resolve returned no persona."}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (deployResult) {
    return (
      <DeployedSuccess
        result={deployResult}
        persona={persona}
        fallbackReason={resolved.fallbackReason}
        onReset={resetWizard}
      />
    );
  }

  const resolveBlocked = Boolean(resolved.resolveError);
  const continueDisabled =
    !currentStepValid ||
    deployPhase === "submitting" ||
    deployPhase === "provisioning" ||
    (currentStep.id === "deploy" && resolveBlocked);

  return (
    <div className="w-full">
      <div className="mb-6 flex flex-col gap-3 text-center">
        <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--surface-soft)] px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {persona.imageUrl ? (
            <img
              src={persona.imageUrl}
              alt=""
              loading="lazy"
              className="h-8 w-14 rounded-md object-cover"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          ) : (
            <Rocket aria-hidden="true" />
          )}
          Launch Agent
        </div>
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Deploy {persona.name}</h1>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Review the persona, connect the required access, and launch a cloud agent in one guided flow.
          </p>
        </div>
      </div>

      {resolved.resolveError ? (
        <div className="mb-5 rounded-2xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] p-4 text-sm leading-6 text-[var(--status-danger)]">
          <p className="font-semibold">
            {resolved.resolveError.kind === "auth-required"
              ? "Sign in to load this persona"
              : "Connect GitHub to load this private persona"}
          </p>
          <p className="mt-1">{resolved.resolveError.message}</p>
          <p className="mt-2 text-[var(--status-danger)]/90">
            {resolved.resolveError.kind === "auth-required"
              ? "Sign in with Google first. If this persona lives in a private repo, you'll then authorize GitHub so we can read its contents."
              : "This persona lives in a private GitHub repo. Authorize GitHub so we can read its contents, then it'll load automatically. Deploy is disabled until the real persona loads — we won't ship demo data in its place."}
          </p>
          {resolved.resolveError.kind === "no-access" ? (
            <GithubAccessPrompt
              workspaceId={workspaceId}
              reloading={personaLoading}
              onReload={() => setReloadToken((token) => token + 1)}
            />
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button asChild>
                <a href={signInHref}>Sign in with Google</a>
              </Button>
              <Button
                variant="outline"
                disabled={personaLoading}
                onClick={() => setReloadToken((token) => token + 1)}
              >
                <RefreshCw aria-hidden="true" />
                Retry
              </Button>
            </div>
          )}
        </div>
      ) : resolved.fallbackReason ? (
        <div className="mb-5 rounded-2xl border border-[var(--status-warning)] bg-[var(--status-warning-soft)] p-4 text-sm leading-6 text-[var(--status-warning)]">
          Showing demo data - live resolve failed: {resolved.fallbackReason}
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <div className="grid gap-0 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="border-b border-[var(--border-default)] bg-[var(--dashboard-panel)] p-6 lg:border-b-0 lg:border-r">
            <WizardStepper steps={steps} currentIndex={stepIndex} />
          </aside>

          <section className="flex min-h-[42rem] flex-col">
            <CardHeader className="border-b border-[var(--border-default)] bg-[var(--surface-soft)]">
              <CardTitle>{currentStep.title}</CardTitle>
              <CardDescription>{currentStep.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 p-5 sm:p-6 lg:p-8">
              {currentStep.id === "review" ? (
                <>
                  <AlreadyDeployedNotice
                    matches={alreadyDeployed}
                    workspaceName={session.currentWorkspace?.name ?? null}
                  />
                  <StepReview persona={persona} />
                </>
              ) : null}
              {currentStep.id === "workspace" ? <StepWorkspace session={session} /> : null}
              {currentStep.id === "integrations" ? (
                <StepIntegrations
                  mode={effectiveMode}
                  workspaceId={session.currentWorkspace?.id ?? null}
                  integrations={persona.integrations}
                  states={integrationStates}
                  onChange={updateIntegrationState}
                />
              ) : null}
              {currentStep.id === "model" ? (
                <StepModel
                  persona={persona}
                  harnessSource={harnessSource}
                  byokKey={byokKey}
                  workspaceId={workspaceId}
                  subscriptionCredentialMessage={subscriptionCredentialMessage}
                  subscriptionCredentialChecking={subscriptionCredentialChecking}
                  onSourceChange={setHarnessSource}
                  onByokKeyChange={setByokKey}
                  onSubscriptionCredentialConnected={() => setSubscriptionCredentialReady(true)}
                />
              ) : null}
              {currentStep.id === "inputs" ? (
                <StepInputs
                  inputs={persona.inputs}
                  values={inputValues}
                  onChange={updateInputValue}
                  mode={effectiveMode}
                  workspaceId={session.currentWorkspace?.id ?? null}
                />
              ) : null}
              {currentStep.id === "deploy" ? (
                <StepDeploy
                  persona={persona}
                  workspace={session.currentWorkspace}
                  integrationStates={integrationStates}
                  harnessSource={harnessSource}
                  inputValues={inputValues}
                  deployPhase={deployPhase}
                  progressMessages={deployProgress}
                  deployError={deployError}
                  subscriptionCredentialMessage={subscriptionCredentialMessage}
                  subscriptionCredentialChecking={subscriptionCredentialChecking}
                />
              ) : null}
            </CardContent>
            <div className="flex flex-col-reverse gap-3 border-t border-[var(--border-default)] bg-[var(--dashboard-panel)] p-5 sm:flex-row sm:items-center sm:justify-between">
              <Button
                variant="outline"
                disabled={stepIndex === 0 || deployPhase === "submitting" || deployPhase === "provisioning"}
                onClick={() => setStepIndex((current) => Math.max(current - 1, 0))}
              >
                <ArrowLeft aria-hidden="true" />
                Back
              </Button>
              <Button disabled={continueDisabled} onClick={handleContinue}>
                {currentStep.id === "deploy" ? "Deploy agent" : "Continue"}
                {currentStep.id === "deploy" ? <Rocket aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
              </Button>
            </div>
          </section>
        </div>
      </Card>
    </div>
  );
}
