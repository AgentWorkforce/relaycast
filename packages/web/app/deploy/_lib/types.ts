/**
 * Shared types for the web "Launch Agent" deploy wizard — the browser
 * equivalent of the `agentworkforce deploy` CLI. The wizard walks an operator
 * through reviewing a persona, choosing a workspace, connecting the
 * integrations + model credentials the persona needs, filling in its inputs,
 * and deploying it to the cloud.
 *
 * `PersonaSummary` is the lightweight, UI-friendly projection of a compiled
 * persona spec. In Phase 1 it is sourced from baked-in demo data; in Phase 2 it
 * comes from `POST /api/persona/resolve`, which fetches + compiles the
 * `persona.ts` referenced by the `?persona=` GitHub blob URL.
 */

export type DeployMode = "demo" | "live";

export type HarnessSource = "plan" | "managed" | "byok" | "oauth";

export type PersonaTriggerKind = "integration" | "schedule";

export interface PersonaTriggerSummary {
  kind: PersonaTriggerKind;
  /** e.g. "github", "linear", or "schedule" */
  provider: string;
  /** Human-readable description of when the agent fires. */
  label: string;
}

export interface PersonaIntegrationSummary {
  /** Provider key, e.g. "github", "slack", "linear". */
  provider: string;
  /** Display label, e.g. "GitHub". */
  label: string;
  /** Nango provider config key used to open the connect modal. */
  providerConfigKey: string;
  /** Why the persona needs this integration. */
  description: string;
}

export interface PersonaInputPicker {
  provider: string;
  resource: string;
}

export interface PersonaInputSummary {
  /** Env var name, e.g. "SLACK_CHANNEL". */
  key: string;
  description: string;
  optional: boolean;
  default?: string;
  picker?: PersonaInputPicker;
}

export interface PersonaSummary {
  /** Persona slug, e.g. "pr-reviewer". */
  id: string;
  /** Display name, e.g. "Review Agent". */
  name: string;
  description: string;
  /** Source GitHub blob URL the wizard was launched with, if any. */
  sourceUrl?: string;
  /** Small card image for visual preview, e.g. card-sm.png in the persona folder. */
  imageUrl?: string;
  /** Repo path slug derived from the URL, e.g. "review". */
  slug: string;
  /** Coding harness the persona runs on, e.g. "codex", "claude". null = none. */
  harness: string | null;
  /** Model id, e.g. "gpt-5.5", "claude-sonnet-4-6". */
  model?: string;
  /** Model provider derived from the model/harness, e.g. "openai", "anthropic". */
  modelProvider?: string;
  /** Whether the persona uses the operator's own LLM subscription. */
  useSubscription: boolean;
  integrations: PersonaIntegrationSummary[];
  inputs: PersonaInputSummary[];
  triggers: PersonaTriggerSummary[];
  /** One-line "what it does" tagline for hero display. */
  tagline?: string;
}

/** The compiled bundle the live deploy POST needs (Phase 2). */
export interface PersonaBundle {
  runner: string;
  agent: string;
  packageJson: Record<string, unknown>;
}

/**
 * Why a live resolve was *blocked* rather than softly degraded.
 *
 * - `auth-required` (HTTP 401): the resolver couldn't authenticate the caller,
 *   so it never even tried the private-repo credential path. The operator needs
 *   to sign in / connect GitHub.
 * - `no-access` (HTTP 403): the caller is authenticated, but no GitHub
 *   integration connected to this workspace can read the persona's repo (e.g. a
 *   private repo owned by a different org the github-relay App isn't installed
 *   on).
 *
 * Unlike a generic parse/compile failure — which degrades to demo data so the
 * wizard still renders — a `resolveError` means the *real* persona could not be
 * loaded at all, so deploying would silently ship demo data. The wizard blocks
 * the deploy and shows an actionable banner in this case.
 */
export type PersonaResolveErrorKind = "auth-required" | "no-access";

export interface PersonaResolveError {
  /** HTTP status returned by `/api/persona/resolve` (401 or 403). */
  status: number;
  kind: PersonaResolveErrorKind;
  /** Server-provided detail, surfaced verbatim to the operator. */
  message: string;
}

export interface ResolvedPersona {
  summary: PersonaSummary;
  /** Raw compiled persona spec — passed through to the deploy POST. */
  persona?: unknown;
  /** Raw compiled agent listener spec. */
  agent?: unknown;
  bundle?: PersonaBundle;
  /** True when this came from baked-in demo data rather than a live compile. */
  demo: boolean;
  /**
   * Set when live mode (`?live=1`) was requested but the resolve/compile failed
   * and we degraded to demo data. The wizard surfaces this as a banner so a
   * backend failure can't masquerade as a real "agent is live" success.
   */
  fallbackReason?: string;
  /**
   * Set when a live resolve was blocked by an auth/access failure (401/403)
   * rather than a soft parse/compile fallback. When present the wizard must not
   * let the operator deploy demo data as if it were the real persona.
   */
  resolveError?: PersonaResolveError;
}

export type IntegrationConnectionState = "idle" | "connecting" | "connected" | "error";

export interface IntegrationState {
  provider: string;
  state: IntegrationConnectionState;
  connectionId?: string;
  error?: string;
}

export type DeployPhase =
  | "idle"
  | "submitting"
  | "provisioning"
  | "ready"
  | "failed";

export interface DeployResult {
  agentId: string;
  deploymentId: string;
  status: string;
  demo: boolean;
}

export type WizardStepId =
  | "review"
  | "workspace"
  | "integrations"
  | "model"
  | "inputs"
  | "deploy";

export interface WizardStepMeta {
  id: WizardStepId;
  title: string;
  shortTitle: string;
  description: string;
}
