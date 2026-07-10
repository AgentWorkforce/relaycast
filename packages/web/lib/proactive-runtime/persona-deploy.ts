import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  normalizeRelayfilePath,
  relayfilePathsForTrigger,
  relayfilePathsForIntegrations,
  RelayfilePathScopeError,
  type RelayfileTriggerDescriptor,
  type RelayfileTriggerIntegrations,
} from "@cloud/core/relayfile/path-scopes.js";
import {
  deploymentAgentSpec,
  deploymentPersonaSpec,
  relayfileTriggerIntegrationsFromAgentOrLegacy,
  type DeploymentAgentSpec,
  type DeploymentSpecSnapshot,
} from "@cloud/core/proactive-runtime/agent-spec.js";
import type { CapabilityName } from "@cloud/core/proactive-runtime/capabilities.js";
import {
  isPersonaIntent,
  parseAgentSpec as parsePersonaKitAgentSpec,
  parsePersonaSpec as parsePersonaKitSpec,
  type PersonaIntent,
} from "@cloud/core/proactive-runtime/persona-spec.js";
import { normalizeRelayfileTriggerEventName, relayfileProviderResourceGlobs, resolveRelayfileProviderContract, relayfileTriggerMatchesEvent } from "@cloud/core/relayfile/provider-contracts.js";
import { getDb } from "@/lib/db";
import {
  cancelCronSchedule,
  listCronSchedules,
  registerCronSchedules,
  resolveAgentGatewayRelaycronEnv,
  type RegisteredCronSchedule,
  type ScheduleSpec,
} from "@/lib/proactive-runtime/agent-gateway-relaycron-client";
import { storeBundle } from "@/lib/proactive-runtime/bundle-store";
import { translatePersonaRelayToInboxSelectors } from "@/lib/proactive-runtime/inbox-selectors";
export { translatePersonaRelayToInboxSelectors } from "@/lib/proactive-runtime/inbox-selectors";

export type PersonaBundle = {
  runner: string;
  agent: string;
  packageJson: Record<string, unknown>;
};

export type PersonaBundleDeployRequest = {
  persona: unknown;
  agent?: unknown;
  summary?: {
    imageUrl?: string;
  };
  bundle: PersonaBundle;
  inputs?: Record<string, string>;
  credentialSelections?: Record<string, string>;
  pinnedVersion?: { version: number };
};

export type PersonaBundleDeployInput = PersonaBundleDeployRequest & {
  workspaceId: string;
  userId: string;
  /**
   * Organization that owns the persona row created/updated by this
   * deploy. Required because `personas.organization_id` is NOT NULL —
   * see the `personas` table in `packages/web/lib/db/schema.ts`. The
   * deploy POST handler resolves it from `auth.organizationId`.
   */
  organizationId: string;
  requestOrigin: string;
};

export type PersonaBundleDeployResult = {
  agentId: string;
  workspaceId: string;
  status: "starting" | "active" | "failed";
  deploymentId: string;
  sandboxId: string;
};

export class PersonaDeployError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PersonaDeployError";
  }
}

type PersonaSchedule = {
  name?: string;
  cron?: string;
  cronExpression?: string;
  tz?: string;
  timezone?: string;
  description?: string;
};

const MIN_SUPPORTED_CRON_INTERVAL_MINUTES = 5;
const UNSUPPORTED_SLACK_LIVE_TRIGGER_NAMES = new Set([
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
]);
// Cloud-owned capability keys that persona-kit may not model directly. Pinned
// `satisfies readonly CapabilityName[]` so adding a key here that the cloud
// dispatcher does not actually recognize is a compile error (drift-guard,
// cloud#1732) — the detector below only makes sense for keys the gate reads.
const CLOUD_OWNED_CAPABILITY_KEYS = [
  "teamSolve",
] as const satisfies readonly CapabilityName[];

type ParsedPersonaSpec = Record<string, unknown> & {
  id: string;
  intent: PersonaIntent;
  slug?: string;
  name?: string;
  sandbox?: boolean;
  // Optional per `@agentworkforce/persona-kit`'s PersonaSpec; downstream
  // consumers treat `undefined` as "no parameterized inputs" (equivalent
  // to `{}`) via `input.inputs ?? {}` in `upsertAgent` and friends.
  inputs?: Record<string, unknown>;
  schedules?: PersonaSchedule[];
  integrations?: Record<string, { triggers?: Array<{ on?: string }>; scope?: unknown; source?: unknown }>;
  memory?: { scopes?: unknown };
};

type ParsedAgentSpec = DeploymentAgentSpec & {
  triggers?: Record<string, Array<{ on?: string; trigger?: unknown; maxConcurrency?: unknown }>>;
  schedules?: PersonaSchedule[];
  watch?: unknown[];
};

type DeploymentWatchRule = {
  paths: string[];
  events: string[];
  conditions?: Array<{ field: string; equals: string }>;
  // Trigger `match` content filter, carried verbatim to the dispatch-level
  // watch rule so the cloud matcher (watchRulesMatchEvent) can gate the wake
  // on event content (e.g. a Slack `@mention`) BEFORE provisioning a sandbox.
  match?: string;
  triggerKey?: string;
};

type RawRow<T> = { rows?: T[] };

/**
 * Normalize a drizzle `execute()` result to the row array, accepting
 * both driver shapes used in this repo:
 *
 *   - **node-postgres** (Lambda, `@cloud/core/db/client`) returns
 *     `pg.QueryResult` ≈ `{ rows: T[], rowCount, ... }`.
 *   - **postgres-js** (Cloudflare Worker, `@cloud/core/db/factory`)
 *     returns a `RowList` that **is** the array of rows (it `extends
 *     Array`); there is no `.rows` property.
 *
 * Reading only `result.rows` silently returned `[]` on the Worker even
 * when the underlying INSERT/SELECT succeeded — that produced the
 * `persona_version_persist_failed` 500 on every first-time deploy.
 *
 * The dual-shape pattern is the same one already used in
 * `packages/web/lib/integrations/persona-integration-resolver.ts`'s
 * `readRows()`.
 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as RawRow<T>;
  return Array.isArray(candidate?.rows) ? candidate.rows : [];
}

/**
 * Encode a JS string array as a Postgres array literal (e.g. `{"a","b"}`)
 * suitable for binding via drizzle's `sql\`\``\` template + a `::text[]`
 * cast.
 *
 * Why this exists: drizzle's sql tag binds a JS array as the bare scalar
 * of its first element. A single-element `["documentation"]` arrives at
 * Postgres as the string `"documentation"`, and the `::text[]` cast then
 * rejects the non-array scalar. Verified against the production
 * `INSERT INTO personas` failure where `params: ...,documentation,...`
 * showed the array flattened to one string. Building the literal
 * manually with proper quoting/escaping sidesteps the pitfall.
 *
 * Empty arrays produce `{}` which Postgres accepts as an empty `text[]`.
 */
function toPostgresTextArrayLiteral(values: readonly string[]): string {
  if (values.length === 0) return "{}";
  const escaped = values.map((value) =>
    `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
  );
  return `{${escaped.join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

export function integrationTriggerKey(provider: string, index: number): string {
  return `provider:${provider}:trigger:${index}`;
}

export function deriveDeliveryMaxConcurrency(agent: unknown): number | null {
  if (!isRecord(agent) || !isRecord(agent.triggers)) {
    return null;
  }
  let cap: number | null = null;
  for (const rawTriggers of Object.values(agent.triggers)) {
    if (!Array.isArray(rawTriggers)) {
      continue;
    }
    for (const trigger of rawTriggers) {
      if (!isRecord(trigger)) {
        continue;
      }
      const triggerCap = readPositiveInteger(trigger.maxConcurrency);
      if (triggerCap !== null) {
        cap = cap === null ? triggerCap : Math.min(cap, triggerCap);
      }
    }
  }
  return cap;
}

export function deriveDeliveryMaxConcurrencyByTrigger(agent: unknown): Record<string, number> | null {
  if (!isRecord(agent) || !isRecord(agent.triggers)) {
    return null;
  }
  const caps: Record<string, number> = {};
  for (const [provider, rawTriggers] of Object.entries(agent.triggers)) {
    if (!Array.isArray(rawTriggers)) {
      continue;
    }
    for (const [index, trigger] of rawTriggers.entries()) {
      if (!isRecord(trigger)) {
        continue;
      }
      const triggerCap = readPositiveInteger(trigger.maxConcurrency);
      if (triggerCap !== null) {
        caps[integrationTriggerKey(provider, index)] = triggerCap;
      }
    }
  }
  return Object.keys(caps).length > 0 ? caps : null;
}

export function copyTriggerMaxConcurrencyFromRawAgent(
  agent: ParsedAgentSpec,
  rawAgent: unknown,
): void {
  if (!isRecord(rawAgent) || !isRecord(rawAgent.triggers) || !isRecord(agent.triggers)) {
    return;
  }
  for (const [provider, rawTriggers] of Object.entries(rawAgent.triggers)) {
    const parsedTriggers = agent.triggers[provider];
    if (!Array.isArray(rawTriggers) || !Array.isArray(parsedTriggers)) {
      continue;
    }
    for (const [index, rawTrigger] of rawTriggers.entries()) {
      const parsedTrigger = parsedTriggers[index];
      if (!isRecord(rawTrigger) || !isRecord(parsedTrigger)) {
        continue;
      }
      const triggerCap = readPositiveInteger(rawTrigger.maxConcurrency);
      if (triggerCap !== null) {
        parsedTrigger.maxConcurrency = triggerCap;
      }
    }
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isSlackProviderName(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === "slack" || normalized.startsWith("slack-");
}

function assertSupportedSlackTrigger(provider: string, on: string, path: string): void {
  if (!isSlackProviderName(provider)) {
    return;
  }
  const normalized = normalizeRelayfileTriggerEventName(on);
  if (!UNSUPPORTED_SLACK_LIVE_TRIGGER_NAMES.has(normalized)) {
    return;
  }

  throw new PersonaDeployError(
    `Slack trigger '${on}' is not supported by watchforce proactive deployments. ` +
      `Use 'app_mention' for mention responders, or use Slack Relayfile trigger ` +
      `'message.created' to watch ingested message records.`,
    "unsupported_trigger",
    400,
    [{ path, message: "unsupported Slack subscription trigger name for watchforce deployments" }],
  );
}

function minuteValuesForField(field: string): number[] | null {
  const values = new Set<number>();
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) return null;
    if (part === "*") {
      for (let minute = 0; minute < 60; minute += 1) values.add(minute);
      continue;
    }

    const stepMatch = /^(?:(\*)|(\d+)-(\d+)|(\d+))\/(\d+)$/.exec(part);
    if (stepMatch) {
      const step = Number(stepMatch[5]);
      if (!Number.isInteger(step) || step <= 0) return null;
      const start = stepMatch[1] ? 0 : Number(stepMatch[2] ?? stepMatch[4]);
      const end = stepMatch[1] || stepMatch[4] ? 59 : Number(stepMatch[3]);
      if (start < 0 || end > 59 || start > end) return null;
      for (let minute = start; minute <= end; minute += step) values.add(minute);
      continue;
    }

    const rangeMatch = /^(\d+)-(\d+)$/.exec(part);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start < 0 || end > 59 || start > end) return null;
      for (let minute = start; minute <= end; minute += 1) values.add(minute);
      continue;
    }

    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 59) return null;
    values.add(value);
  }

  return [...values].sort((left, right) => left - right);
}

function minimumMinuteInterval(expression: string): number | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = minuteValuesForField(fields[0]);
  if (!minutes || minutes.length <= 1) return null;

  let minimum = 60;
  for (let index = 1; index < minutes.length; index += 1) {
    minimum = Math.min(minimum, minutes[index] - minutes[index - 1]);
  }
  return Math.min(minimum, 60 - minutes[minutes.length - 1] + minutes[0]);
}

function validateSupportedCronGranularity(expression: string, path: string): void {
  const minimumInterval = minimumMinuteInterval(expression);
  if (
    minimumInterval !== null &&
    minimumInterval < MIN_SUPPORTED_CRON_INTERVAL_MINUTES
  ) {
    throw new PersonaDeployError(
      `schedule '${expression}' runs more often than every ${MIN_SUPPORTED_CRON_INTERVAL_MINUTES} minutes`,
      "unsupported_cron_granularity",
      400,
      [
        {
          path,
          message: `cron schedules must run no more often than every ${MIN_SUPPORTED_CRON_INTERVAL_MINUTES} minutes`,
        },
      ],
    );
  }
}

export function stableSpecHash(spec: unknown): string {
  return createHash("sha256").update(stableStringify(spec)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deterministicUuid(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hash.slice(18, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

function normalizePersonaDatabaseId(personaId: string): string {
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      personaId,
    )
  ) {
    return personaId;
  }
  return deterministicUuid(`persona:${personaId}`);
}

function validationIssuePath(path: unknown): string {
  if (Array.isArray(path)) {
    return path.map((part) => String(part)).join(".") || "persona";
  }
  if (typeof path === "string" && path.trim()) {
    return path.trim();
  }
  return "persona";
}

function validationIssuesFrom(error: unknown): Array<{ path: string; message: string }> {
  const source = isRecord(error)
    ? Array.isArray(error.issues)
      ? error.issues
      : Array.isArray(error.errors)
      ? error.errors
      : null
    : null;

  if (!source) {
    return [
      {
        path: "persona",
        message: error instanceof Error ? error.message : "Invalid persona spec",
      },
    ];
  }

  return source.map((issue) => {
    if (!isRecord(issue)) {
      return { path: "persona", message: String(issue) };
    }
    return {
      path: validationIssuePath(issue.path),
      message: typeof issue.message === "string" ? issue.message : "Invalid persona spec",
    };
  });
}

function personaValidationError(error: unknown): PersonaDeployError {
  return new PersonaDeployError(
    error instanceof Error && error.message ? error.message : "Invalid persona spec",
    "invalid_persona",
    400,
    validationIssuesFrom(error),
  );
}

function rejectRemovedPersonaFields(persona: unknown): void {
  if (!isRecord(persona)) {
    return;
  }

  if ("traits" in persona) {
    throw new PersonaDeployError(
      "traits was removed in v1; personality is handled by the persona-personality-builder tool (out of scope for v1). See docs/plans/deploy-v1.md",
      "invalid_persona",
      400,
      [{ path: "traits", message: "traits was removed in v1" }],
    );
  }
}

function readPersonaSandboxSetting(persona: unknown): boolean | undefined {
  if (!isRecord(persona) || !("sandbox" in persona)) {
    return undefined;
  }
  if (typeof persona.sandbox !== "boolean") {
    throw new PersonaDeployError("persona.sandbox must be a boolean", "invalid_persona", 400, [
      { path: "sandbox", message: "sandbox must be true or false" },
    ]);
  }
  return persona.sandbox;
}

function personaForKitParser(persona: unknown): unknown {
  if (!isRecord(persona) || !("sandbox" in persona)) {
    return persona;
  }
  const { sandbox: _sandbox, ...rest } = persona;
  return rest;
}

function warnIgnoredPersonaMemory(persona: unknown): void {
  if (!isRecord(persona) || !("memory" in persona)) {
    return;
  }

  console.warn(
    "[persona-bundle-deploy] persona.memory is accepted and contributes relayfile memory mount scopes.",
  );
}

function readExpectedPersonaIntent(persona: unknown): PersonaIntent {
  if (!isRecord(persona) || typeof persona.intent !== "string" || persona.intent.trim().length === 0) {
    throw new PersonaDeployError("persona.intent is required", "invalid_persona", 400, [
      { path: "intent", message: "persona.intent is required" },
    ]);
  }
  return persona.intent as PersonaIntent;
}

function legacyAgentSpecFromPersona(persona: unknown): ParsedAgentSpec {
  if (!isRecord(persona)) {
    return {};
  }
  const agent: ParsedAgentSpec = {};
  const triggers: ParsedAgentSpec["triggers"] = {};
  if (isRecord(persona.integrations)) {
    for (const [provider, config] of Object.entries(persona.integrations)) {
      if (!isRecord(config) || config.triggers === undefined) {
        continue;
      }
      if (Array.isArray(config.triggers) && config.triggers.length > 0) {
        triggers[provider] = config.triggers as Array<{ on?: string; trigger?: unknown }>;
      }
    }
  }
  if (Object.keys(triggers).length > 0) {
    agent.triggers = triggers;
  }
  if (Array.isArray((persona as { schedules?: unknown }).schedules)) {
    agent.schedules = (persona as { schedules: PersonaSchedule[] }).schedules;
  }
  if (Array.isArray((persona as { watch?: unknown }).watch)) {
    agent.watch = (persona as { watch: unknown[] }).watch;
  }
  return agent;
}

function stripLegacyListenerFields(persona: unknown): unknown {
  if (!isRecord(persona)) {
    return persona;
  }
  const stripped: Record<string, unknown> = { ...persona };
  delete stripped.schedules;
  delete stripped.watch;
  if (isRecord(persona.integrations)) {
    const integrations: Record<string, unknown> = {};
    for (const [provider, config] of Object.entries(persona.integrations)) {
      if (!isRecord(config)) {
        integrations[provider] = config;
        continue;
      }
      const nextConfig: Record<string, unknown> = { ...config };
      delete nextConfig.triggers;
      integrations[provider] = nextConfig;
    }
    stripped.integrations = integrations;
  }
  return stripped;
}

function assertNoLegacyListenerFieldsWhenAgentPresent(persona: unknown): void {
  if (!isRecord(persona)) {
    return;
  }
  if ("schedules" in persona) {
    throw new PersonaDeployError(
      "persona.schedules is ignored when top-level agent is present; move schedules to agent.schedules",
      "invalid_persona",
      400,
      [{ path: "schedules", message: "move schedules to top-level agent.schedules" }],
    );
  }
  if ("watch" in persona) {
    throw new PersonaDeployError(
      "persona.watch is ignored when top-level agent is present; move watch rules to agent.watch",
      "invalid_persona",
      400,
      [{ path: "watch", message: "move watch rules to top-level agent.watch" }],
    );
  }
  if (!isRecord(persona.integrations)) {
    return;
  }
  for (const [provider, config] of Object.entries(persona.integrations)) {
    if (isRecord(config) && "triggers" in config) {
      throw new PersonaDeployError(
        `persona.integrations.${provider}.triggers is ignored when top-level agent is present; move triggers to agent.triggers.${provider}`,
        "invalid_persona",
        400,
        [
          {
            path: `integrations.${provider}.triggers`,
            message: `move triggers to top-level agent.triggers.${provider}`,
          },
        ],
      );
    }
  }
}

async function parsePersonaSpec(persona: unknown): Promise<ParsedPersonaSpec> {
  rejectRemovedPersonaFields(persona);
  const sandbox = readPersonaSandboxSetting(persona);
  warnIgnoredPersonaMemory(persona);
  const expectedIntent = readExpectedPersonaIntent(persona);

  // Persona-kit deep validation now lives behind
  // `@cloud/core/proactive-runtime/persona-spec.js`, the single Cloud-side
  // persona-kit consumer (cloud#2192). HTTP-error shaping stays here.
  if (!isPersonaIntent(expectedIntent)) {
    throw new PersonaDeployError("persona.intent is invalid", "invalid_persona", 400, [
      { path: "intent", message: "persona.intent is invalid" },
    ]);
  }

  try {
    const parsed = validateParsedPersona(
      parsePersonaKitSpec(personaForKitParser(persona), expectedIntent),
    );
    if (sandbox !== undefined) {
      parsed.sandbox = sandbox;
    }
    return parsed;
  } catch (error) {
    if (error instanceof PersonaDeployError) {
      throw error;
    }
    throw personaValidationError(error);
  }
}

async function parseDeploymentAgentSpec(agent: unknown): Promise<ParsedAgentSpec> {
  try {
    const parsed = parsePersonaKitAgentSpec(agent, "agent");
    if (!isRecord(parsed)) {
      throw new PersonaDeployError("agent must be an object", "invalid_persona", 400, [
        { path: "agent", message: "agent must be an object" },
      ]);
    }
    return parsed as ParsedAgentSpec;
  } catch (error) {
    if (error instanceof PersonaDeployError) {
      throw error;
    }
    throw personaValidationError(error);
  }
}

function validateParsedPersona(persona: unknown): ParsedPersonaSpec {
  if (!isRecord(persona)) {
    throw new PersonaDeployError("persona must be an object", "invalid_persona", 400, [
      { path: "persona", message: "persona must be an object" },
    ]);
  }

  rejectRemovedPersonaFields(persona);

  if (typeof persona.id !== "string" || persona.id.trim().length === 0) {
    throw new PersonaDeployError("persona.id is required", "invalid_persona", 400, [
      { path: "id", message: "persona.id is required" },
    ]);
  }

  if (typeof persona.intent !== "string" || persona.intent.trim().length === 0) {
    throw new PersonaDeployError("persona.intent is required", "invalid_persona", 400, [
      { path: "intent", message: "persona.intent is required" },
    ]);
  }

  readPersonaSandboxSetting(persona);

  // persona.inputs is optional in `@agentworkforce/persona-kit`'s schema
  // (a persona can take zero runtime parameters). Reject only when the
  // field is present but the wrong shape — an absent field is equivalent
  // to `{}` at every downstream consumer (`input.inputs ?? {}` in
  // `upsertAgent`, etc.). Previously we required it to be a record
  // unconditionally, which made every input-less persona fail at deploy
  // POST even though parsePersonaSpec accepted it.
  if (persona.inputs !== undefined && !isRecord(persona.inputs)) {
    throw new PersonaDeployError("persona.inputs must be an object", "invalid_persona", 400, [
      { path: "inputs", message: "persona.inputs must be an object" },
    ]);
  }

  if (persona.integrations !== undefined && !isRecord(persona.integrations)) {
    throw new PersonaDeployError("persona.integrations must be an object", "invalid_persona", 400, [
      { path: "integrations", message: "persona.integrations must be an object" },
    ]);
  }

  if (persona.schedules !== undefined && !Array.isArray(persona.schedules)) {
    throw new PersonaDeployError("persona.schedules must be an array", "invalid_persona", 400, [
      { path: "schedules", message: "persona.schedules must be an array" },
    ]);
  }
  if (Array.isArray(persona.schedules)) {
    for (const [index, schedule] of persona.schedules.entries()) {
      if (!isRecord(schedule)) {
        throw new PersonaDeployError(
          `schedule at index ${index} must be an object`,
          "invalid_persona",
          400,
          [{ path: `schedules.${index}`, message: "schedule must be an object" }],
        );
      }
      const cronExpression = schedule.cronExpression ?? schedule.cron;
      if (cronExpression !== undefined && typeof cronExpression !== "string") {
        throw new PersonaDeployError(
          `schedule at index ${index} has an invalid cron expression`,
          "invalid_persona",
          400,
          [{ path: `schedules.${index}.cron`, message: "cron expression must be a string" }],
        );
      }
      if (typeof cronExpression === "string") {
        validateSupportedCronGranularity(cronExpression, `schedules.${index}.cron`);
      }
      if (schedule.tz !== undefined && typeof schedule.tz !== "string") {
        throw new PersonaDeployError(
          `schedule at index ${index} has an invalid timezone`,
          "invalid_persona",
          400,
          [{ path: `schedules.${index}.tz`, message: "timezone must be a string" }],
        );
      }
      if (schedule.timezone !== undefined && typeof schedule.timezone !== "string") {
        throw new PersonaDeployError(
          `schedule at index ${index} has an invalid timezone`,
          "invalid_persona",
          400,
          [{ path: `schedules.${index}.timezone`, message: "timezone must be a string" }],
        );
      }
    }
  }

  return persona as ParsedPersonaSpec;
}

function validateAgentSchedules(agent: ParsedAgentSpec): void {
  if (agent.schedules !== undefined && !Array.isArray(agent.schedules)) {
    throw new PersonaDeployError("agent.schedules must be an array", "invalid_persona", 400, [
      { path: "agent.schedules", message: "agent.schedules must be an array" },
    ]);
  }
  if (!Array.isArray(agent.schedules)) {
    return;
  }
  for (const [index, schedule] of agent.schedules.entries()) {
    if (!isRecord(schedule)) {
      throw new PersonaDeployError(
        `schedule at index ${index} must be an object`,
        "invalid_persona",
        400,
        [{ path: `schedules.${index}`, message: "schedule must be an object" }],
      );
    }
    const cronExpression = schedule.cronExpression ?? schedule.cron;
    if (cronExpression !== undefined && typeof cronExpression !== "string") {
      throw new PersonaDeployError(
        `schedule at index ${index} has an invalid cron expression`,
        "invalid_persona",
        400,
        [{ path: `schedules.${index}.cron`, message: "cron expression must be a string" }],
      );
    }
    if (typeof cronExpression === "string") {
      validateSupportedCronGranularity(cronExpression, `schedules.${index}.cron`);
    }
    if (schedule.tz !== undefined && typeof schedule.tz !== "string") {
      throw new PersonaDeployError(
        `schedule at index ${index} has an invalid timezone`,
        "invalid_persona",
        400,
        [{ path: `schedules.${index}.tz`, message: "timezone must be a string" }],
      );
    }
    if (schedule.timezone !== undefined && typeof schedule.timezone !== "string") {
      throw new PersonaDeployError(
        `schedule at index ${index} has an invalid timezone`,
        "invalid_persona",
        400,
        [{ path: `schedules.${index}.timezone`, message: "timezone must be a string" }],
      );
    }
  }
}

export function parsePersonaBundleDeployRequest(value: unknown): PersonaBundleDeployRequest {
  if (!isRecord(value) || !isRecord(value.bundle)) {
    throw new PersonaDeployError("Invalid request body", "invalid_request", 400);
  }
  if (
    typeof value.bundle.runner !== "string" ||
    typeof value.bundle.agent !== "string" ||
    !isRecord(value.bundle.packageJson)
  ) {
    throw new PersonaDeployError("Invalid bundle payload", "invalid_request", 400);
  }
  if (value.inputs !== undefined && !isStringRecord(value.inputs)) {
    throw new PersonaDeployError("inputs must be a string map", "invalid_request", 400);
  }
  if (value.credentialSelections !== undefined && !isStringRecord(value.credentialSelections)) {
    throw new PersonaDeployError("credentialSelections must be a string map", "invalid_request", 400);
  }
  if (
    value.pinnedVersion !== undefined &&
    (!isRecord(value.pinnedVersion) ||
      typeof value.pinnedVersion.version !== "number" ||
      !Number.isInteger(value.pinnedVersion.version) ||
      value.pinnedVersion.version <= 0)
  ) {
    throw new PersonaDeployError("pinnedVersion.version must be a positive integer", "invalid_request", 400);
  }
  let summary: PersonaBundleDeployRequest["summary"];
  if (value.summary !== undefined) {
    if (!isRecord(value.summary)) {
      throw new PersonaDeployError("summary must be an object", "invalid_request", 400);
    }
    const imageUrl = normalizeHttpUrl(value.summary.imageUrl);
    if (value.summary.imageUrl !== undefined && !imageUrl) {
      throw new PersonaDeployError("summary.imageUrl must be an http(s) URL", "invalid_request", 400);
    }
    summary = imageUrl ? { imageUrl } : {};
  }
  return {
    persona: value.persona,
    ...(value.agent !== undefined ? { agent: value.agent } : {}),
    ...(summary !== undefined ? { summary } : {}),
    bundle: {
      runner: value.bundle.runner,
      agent: value.bundle.agent,
      packageJson: value.bundle.packageJson,
    },
    inputs: value.inputs,
    credentialSelections: value.credentialSelections,
    pinnedVersion: value.pinnedVersion as { version: number } | undefined,
  };
}

export function translatePersonaTriggersToWatchGlobs(
  persona: ParsedPersonaSpec,
  agent?: ParsedAgentSpec,
): string[] {
  assertTriggerProvidersHaveIntegrations(persona, agent);
  const integrations = relayfileTriggerIntegrationsFromAgentOrLegacy({
    agent,
    integrations: persona.integrations,
  }) ?? {};
  const globs = new Set<string>();

  for (const [provider, config] of Object.entries(integrations)) {
    if (!isRecord(config) || config.triggers === undefined) {
      continue;
    }
    if (!Array.isArray(config.triggers)) {
      throw new PersonaDeployError(
        `integration '${provider}' triggers must be an array`,
        "invalid_persona",
        400,
        [{ path: `integrations.${provider}.triggers`, message: "triggers must be an array" }],
      );
    }
    for (const [index, trigger] of config.triggers.entries()) {
      const on = isRecord(trigger) && typeof trigger.on === "string" ? trigger.on : null;
      if (!on) {
        throw new PersonaDeployError(
          `integration '${provider}' trigger at index ${index} must include an 'on' value`,
          "invalid_persona",
          400,
          [{ path: `integrations.${provider}.triggers.${index}.on`, message: "trigger.on is required" }],
        );
      }

      assertSupportedSlackTrigger(
        provider,
        on,
        `${agent === undefined ? "integrations" : "agent.triggers"}.${provider}.${index}.on`,
      );

      let paths: string[];
      try {
        paths = relayfilePathsForTrigger(provider, trigger);
      } catch (error) {
        throw new PersonaDeployError(
          `Unsupported integration trigger '${provider}:${on}'`,
          error instanceof RelayfilePathScopeError ? "unsupported_trigger" : "invalid_persona",
          400,
          [
            {
              path: `${agent === undefined ? "integrations" : "agent.triggers"}.${provider}.${index}.on`,
              message: "unsupported trigger",
            },
          ],
        );
      }
      warnOnSlackWatchPathScoping(
        provider,
        paths,
        `${agent === undefined ? "integrations" : "agent.triggers"}.${provider}.${index}.paths`,
      );
      for (const path of paths) {
        globs.add(path);
      }
    }
  }

  return [...globs].sort();
}

/** Channel/DM/group id shape (`C…`/`D…`/`G…`). Inbound slack message events are
 *  keyed by these ids, so a watch path must use one to match. */
const SLACK_CHANNEL_ID_RE = /^[CDG][A-Z0-9]{6,}$/;

/**
 * Warn (don't fail) on Slack watch paths that mis-scope the wake gate — the two
 * silent footguns from cloud#2000:
 *
 *  - unscoped `/slack/**` / `/slack/channels/**` → the agent wakes (and boots a
 *    box) for EVERY workspace slack message; and
 *  - `/slack/channels/<name>/…` where `<name>` is a channel NAME, not an id —
 *    inbound events are id-keyed (`/slack/channels/<id>/messages/…`), so a name
 *    path silently never matches.
 *
 * Paths are checked AFTER input interpolation, so a `${SLACK_CHANNEL}` picker
 * value (already resolved to an id) does not trip the name check.
 */
function warnOnSlackWatchPathScoping(provider: string, paths: readonly string[], at: string): void {
  if (!isSlackProviderName(provider)) {
    return;
  }
  for (const rawPath of paths) {
    const path = normalizeRelayfilePath(rawPath);
    if (path === "/slack" || path === "/slack/**" || path === "/slack/channels/**") {
      console.warn(
        "[deploy] slack trigger watch path is unscoped; the agent will wake for every channel (scope it to /slack/channels/<id>/**)",
        { diag: "slack-watch-unscoped", path, at },
      );
      continue;
    }
    const channelSegment = /^\/slack\/channels\/([^/]+)(?:\/|$)/.exec(path)?.[1];
    if (channelSegment && !channelSegment.includes("$") && !SLACK_CHANNEL_ID_RE.test(channelSegment)) {
      console.warn(
        "[deploy] slack watch path targets a channel NAME, not an id; inbound message events are id-keyed so this path will never match — use the channel id (C…/D…/G…)",
        { diag: "slack-watch-name-not-id", segment: channelSegment, path, at },
      );
    }
  }
}

/**
 * Substitute deploy-resolved input values into trigger/watch `paths`, so a
 * channel (or any id) can be supplied by a picker input instead of hardcoded in
 * source. cloud#1999.
 *
 * Watch globs are computed at deploy time from literal `trigger.paths`, and the
 * deploy already resolves inputs (incl. pickers) before this runs — so
 * `paths: ['/slack/channels/${SLACK_CHANNEL}/**']` + a channel-picker input
 * yields a concrete, channel-scoped wake gate. Mutates in place so EVERY
 * downstream derivation (watch_globs, watch_rules, mount paths, relayfile token
 * scopes) sees the resolved paths. An unresolved reference fails the deploy
 * loudly rather than silently persisting an unmatchable `${VAR}` path.
 */
export function interpolateTriggerPathInputs(
  persona: ParsedPersonaSpec,
  agent: ParsedAgentSpec | undefined,
  inputs: Record<string, string>,
): void {
  const substitute = (path: string, at: string): string =>
    path.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_match, braced: string | undefined, bare: string | undefined): string => {
        const name = (braced ?? bare) as string;
        const value = inputs[name];
        if (typeof value !== "string" || value.trim() === "") {
          throw new PersonaDeployError(
            `trigger watch path references input '${name}', which resolved to no value at deploy time`,
            "invalid_persona",
            400,
            [
              {
                path: at,
                message: `input '${name}' is unset — supply it (e.g. via a picker input) or remove the reference`,
              },
            ],
          );
        }
        const resolved = value.trim();
        // Defense-in-depth: a watch path is a relayfile scope, so an input must
        // not smuggle path traversal or glob metacharacters that would broaden
        // the wake gate / token scope beyond the intended segment. (Interior `/`
        // is allowed for legitimately multi-segment values like `owner/repo`.)
        if (/(^|\/)\.\.(\/|$)/.test(resolved) || /[*?{}[\]\x00-\x1f]/.test(resolved)) {
          throw new PersonaDeployError(
            `trigger watch path input '${name}' resolved to an unsafe value`,
            "invalid_persona",
            400,
            [
              {
                path: at,
                message: `input '${name}' must not contain '..', glob characters, or control characters`,
              },
            ],
          );
        }
        return resolved;
      },
    );

  const resolvePaths = (value: unknown, at: string): void => {
    if (!isRecord(value) || !Array.isArray(value.paths)) {
      return;
    }
    value.paths = value.paths.map((entry, index) =>
      typeof entry === "string" && entry.includes("$") ? substitute(entry, `${at}.${index}`) : entry,
    );
  };

  const walkTriggers = (triggers: unknown, base: string): void => {
    if (!isRecord(triggers)) {
      return;
    }
    for (const [provider, arr] of Object.entries(triggers)) {
      if (!Array.isArray(arr)) {
        continue;
      }
      arr.forEach((trigger, index) => resolvePaths(trigger, `${base}.${provider}.${index}.paths`));
    }
  };

  walkTriggers(agent?.triggers, "agent.triggers");
  if (isRecord(persona.integrations)) {
    for (const [provider, config] of Object.entries(persona.integrations)) {
      if (isRecord(config) && Array.isArray(config.triggers)) {
        config.triggers.forEach((trigger, index) =>
          resolvePaths(trigger, `integrations.${provider}.triggers.${index}.paths`),
        );
      }
    }
  }
  if (agent && Array.isArray(agent.watch)) {
    agent.watch.forEach((rule, index) => resolvePaths(rule, `agent.watch.${index}.paths`));
  }
}

/**
 * Effective deploy-time input values: persona-declared `default`s overlaid with
 * the explicit values the deploy CLI resolved (picker selections, env, etc.).
 * Used to interpolate trigger paths — see {@link interpolateTriggerPathInputs}.
 */
export function effectiveDeployInputs(
  persona: ParsedPersonaSpec,
  requestInputs?: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  if (isRecord(persona.inputs)) {
    for (const [name, spec] of Object.entries(persona.inputs)) {
      if (isRecord(spec) && typeof spec.default === "string") {
        resolved[name] = spec.default;
      }
    }
  }
  for (const [name, value] of Object.entries(requestInputs ?? {})) {
    if (typeof value === "string") {
      resolved[name] = value;
    }
  }
  return resolved;
}

/**
 * Translate trigger `where`/`match` clauses into dispatch-level watch rules.
 *
 * `where` ("field=value", comma-separated pairs ANDed; `field` is a dot-path
 * into the event payload, e.g. "label.name=small") is the persona-kit-safe
 * channel for dispatch conditions: parseIntegrationTrigger preserves it,
 * while a `conditions` key on a trigger and `conditions` on `watch` rules
 * are both stripped client-side. Until now nothing evaluated it — personas
 * filtered labels INSIDE the sandbox, paying a Daytona provision for every
 * non-matching `issues.labeled` event.
 *
 * `match` is the content-filter analog: a case-insensitive substring of the
 * event's human text, or the literal `@mention` token (text addresses an
 * agent). parseIntegrationTrigger preserves it too, and like `where` it was
 * silently dropped before reaching dispatch — so a Slack chat agent woke and
 * provisioned a box on EVERY channel message. Carrying `match` onto the watch
 * rule lets the cloud matcher gate the wake on content before provisioning.
 *
 * Returns null when NO trigger carries `where`, `match`, or a valid
 * `maxConcurrency` (zero delta: the agent keeps watch_globs matching). When ANY
 * trigger needs a dispatch-level rule, returns a COMPLETE rule set covering
 * EVERY trigger — `agentMatchesEvent` prefers watch_rules over watch_globs
 * exclusively, so a partial set would silently kill the persona's other
 * wakeups (issues.opened, slack, ...). `triggerKey` rides on these rules so
 * enqueue can stamp the delivery row for per-trigger backpressure.
 */
export function translatePersonaTriggersToWatchRules(
  persona: ParsedPersonaSpec,
  agent?: ParsedAgentSpec,
): DeploymentWatchRule[] | null {
  assertTriggerProvidersHaveIntegrations(persona, agent);
  const integrations = relayfileTriggerIntegrationsFromAgentOrLegacy({
    agent,
    integrations: persona.integrations,
  }) ?? {};

  let sawWhere = false;
  let sawMatch = false;
  let sawMaxConcurrency = false;
  const rules: DeploymentWatchRule[] = [];
  for (const [provider, config] of Object.entries(integrations)) {
    if (!isRecord(config) || !Array.isArray(config.triggers)) {
      continue;
    }
    for (const [index, trigger] of config.triggers.entries()) {
      const on = isRecord(trigger) && typeof trigger.on === "string" ? trigger.on : null;
      if (!on) {
        // translatePersonaTriggersToWatchGlobs already rejects this shape
        // with a structured error; mirror a skip here to keep one error site.
        continue;
      }
      let paths: string[];
      try {
        paths = relayfilePathsForTrigger(provider, trigger);
      } catch {
        // Same rationale: the glob translator owns the structured error.
        continue;
      }
      const where = isRecord(trigger) && typeof trigger.where === "string" ? trigger.where : null;
      const conditions = where
        ? parseTriggerWhere(where, `${agent === undefined ? "integrations" : "agent.triggers"}.${provider}.${index}.where`)
        : undefined;
      if (conditions) {
        sawWhere = true;
      }
      const match =
        isRecord(trigger) && typeof trigger.match === "string" && trigger.match.trim().length > 0
          ? trigger.match.trim()
          : undefined;
      if (match) {
        sawMatch = true;
      }
      if (isRecord(trigger) && readPositiveInteger(trigger.maxConcurrency) !== null) {
        sawMaxConcurrency = true;
      }
      rules.push({
        paths,
        events: expandTriggerEvents(provider, on),
        ...(conditions ? { conditions } : {}),
        ...(match ? { match } : {}),
        triggerKey: integrationTriggerKey(provider, index),
      });
    }
  }
  return sawWhere || sawMatch || sawMaxConcurrency ? rules : null;
}

/**
 * Expand a trigger `on` value to the concrete event types the dispatcher can
 * enqueue. Watch-rule event matching is EXACT (`rule.events.includes(eventType)`)
 * while legacy trigger matching is fuzzy (`relayfileTriggerMatchesEvent`:
 * prefix-dot, resource/action aliases) — e.g. a slack trigger `on: "message"`
 * legacy-matches the forward path's enqueued `message.created`. Derived rules
 * therefore expand `on` through the provider's adapter-sourced event catalog,
 * filtered by the SAME canonical matcher, so persisted rules keep exactly the
 * wakeups the trigger had. The literal `on` is always included as a fallback
 * for providers with missing/partial catalogs.
 */
function expandTriggerEvents(provider: string, on: string): string[] {
  const catalog = resolveRelayfileProviderContract(provider)?.triggerEvents ?? [];
  const events = new Set<string>([on]);
  for (const eventType of catalog) {
    if (relayfileTriggerMatchesEvent({ trigger: on, eventType })) {
      events.add(eventType);
    }
  }
  return [...events];
}

/** "field=value" pairs, comma-separated, ANDed. Dot-path fields match
 *  `WatchRuleCondition.field` semantics in @cloud/core/proactive-runtime/match. */
function parseTriggerWhere(
  where: string,
  contextPath: string,
): Array<{ field: string; equals: string }> {
  const conditions: Array<{ field: string; equals: string }> = [];
  for (const pair of where.split(",")) {
    const eq = pair.indexOf("=");
    const field = eq >= 0 ? pair.slice(0, eq).trim() : "";
    const value = eq >= 0 ? pair.slice(eq + 1).trim() : "";
    if (!field || !value) {
      throw new PersonaDeployError(
        `invalid trigger where clause '${where}' — expected comma-separated field=value pairs`,
        "invalid_persona",
        400,
        [{ path: contextPath, message: "expected field=value" }],
      );
    }
    conditions.push({ field, equals: value });
  }
  return conditions;
}

function assertTriggerProvidersHaveIntegrations(
  persona: ParsedPersonaSpec,
  agent: ParsedAgentSpec | undefined,
): void {
  if (agent === undefined || !isRecord(agent.triggers)) {
    return;
  }
  const personaIntegrations = isRecord(persona.integrations) ? persona.integrations : {};
  for (const [provider, triggers] of Object.entries(agent.triggers)) {
    if (!Array.isArray(triggers) || triggers.length === 0) {
      continue;
    }
    if (!isRecord(personaIntegrations[provider])) {
      throw new PersonaDeployError(
        `agent.triggers.${provider} requires a matching persona.integrations.${provider} connection`,
        "invalid_persona",
        400,
        [
          {
            path: `agent.triggers.${provider}`,
            message: `add persona.integrations.${provider} or remove the trigger`,
          },
        ],
      );
    }
  }
}

function providerRoot(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function scopePathPrefix(provider: string, key: string): string {
  const root = providerRoot(provider);
  const normalizedKey = key.trim().toLowerCase().replace(/_/gu, "-");
  if (!normalizedKey || normalizedKey === "path" || normalizedKey === "paths") {
    return root;
  }
  if (
    provider.trim().toLowerCase() === "github" &&
    ["repo", "repos", "repository", "repositories"].includes(normalizedKey)
  ) {
    return `${root}/repos`;
  }
  return `${root}/${normalizedKey}`;
}

function relayfilePathsFromScope(provider: string, scope: unknown): string[] {
  if (!isRecord(scope)) {
    return [];
  }

  const paths = new Set<string>();
  for (const [key, value] of Object.entries(scope)) {
    const prefix = scopePathPrefix(provider, key);
    if (typeof value === "string" && value.trim()) {
      const rawPath = value.trim().startsWith("/")
        ? value.trim()
        : `${prefix}/${value.trim()}/**`;
      paths.add(normalizeRelayfilePath(rawPath));
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.trim()) {
          const rawPath = entry.trim().startsWith("/")
            ? entry.trim()
            : `${prefix}/${entry.trim()}/**`;
          paths.add(normalizeRelayfilePath(rawPath));
        }
      }
    }
  }

  if (paths.size === 0) {
    paths.add(normalizeRelayfilePath(`${providerRoot(provider)}/**`));
  }
  return [...paths].filter(Boolean);
}

/**
 * Extract `persona.watch` rules. Returns `null` if the persona doesn't declare
 * the field (legacy path: only `watch_globs` derived from `integrations[].triggers`
 * will populate). Returns the rules array as-is otherwise; richer matching
 * happens in `@cloud/core/proactive-runtime/match`, which prefers
 * `watch_rules` over `watch_globs` when both are present.
 */
export function readDeploymentWatchRules(persona: ParsedPersonaSpec, agent?: ParsedAgentSpec): unknown[] | null {
  const raw = agent === undefined
    ? (persona as ParsedPersonaSpec & { watch?: unknown }).watch
    : agent.watch;
  const explicit = Array.isArray(raw) && raw.length > 0 ? raw : null;
  // Trigger `where` clauses lift into dispatch-level rules. When present the
  // trigger-derived set is COMPLETE (covers every trigger), so prepending it
  // ahead of any explicit watch rules preserves all wakeups under the
  // rules-over-globs precedence in @cloud/core/proactive-runtime/match.
  const fromTriggers = translatePersonaTriggersToWatchRules(persona, agent);
  if (!fromTriggers) return explicit;
  return explicit ? [...fromTriggers, ...explicit] : fromTriggers;
}

export function deriveRelayfileMountPaths(
  persona: ParsedPersonaSpec,
  agent?: ParsedAgentSpec,
): string[] {
  assertTriggerProvidersHaveIntegrations(persona, agent);
  const paths = new Set<string>();

  for (const [provider, config] of Object.entries(persona.integrations ?? {})) {
    if (!isRecord(config)) {
      continue;
    }
    for (const path of relayfilePathsFromScope(provider, config.scope)) {
      paths.add(path);
    }
  }

  const triggerIntegrations: RelayfileTriggerIntegrations =
    relayfileTriggerIntegrationsFromAgentOrLegacy({
      agent,
      integrations: persona.integrations,
    }) ?? {};
  for (const path of relayfilePathsForIntegrations(triggerIntegrations)) {
    paths.add(path);
  }

  const memoryScopes = Array.isArray(persona.memory?.scopes) ? persona.memory.scopes : [];
  for (const scope of memoryScopes) {
    if (typeof scope === "string" && scope.trim()) {
      paths.add(normalizeRelayfilePath(`/memory/${scope.trim()}/**`));
    }
  }

  // Make a bare provider-ROOT scope (`/<provider>/**`) "just work". A provider
  // root is dropped by the runtime mirror (isProviderRootPath), and a mid-path
  // `*` can't mount — so an author who scopes `/linear/**` to "mount everything"
  // otherwise mounts NOTHING. Expand it to the provider's concrete resource
  // subtrees (e.g. `/linear/issues/**`, `/linear/teams/**`) from the adapter
  // contract; those survive the mirror filter and mount the real data.
  for (const path of [...paths]) {
    const providerRoot = /^\/([^/]+)\/\*\*$/u.exec(path);
    if (!providerRoot) {
      continue;
    }
    const resourceGlobs = relayfileProviderResourceGlobs(providerRoot[1]).filter(
      (glob) => glob !== path,
    );
    if (resourceGlobs.length > 0) {
      paths.delete(path);
      for (const glob of resourceGlobs) {
        paths.add(glob);
      }
    }
  }

  // Self-describing companions: whenever ANY of a provider is mounted, also
  // mount that provider's root `LAYOUT.md` and `_index.json` so an agent can
  // orient itself. Relayfile mounts are documented as self-describing ("start
  // with LAYOUT.md"), but that guidance silently breaks for a SCOPED mount —
  // the root docs live at `/<provider>/LAYOUT.md`, which the broad
  // `/<provider>/**` would cover but the runtime mirror drops as a provider
  // root (isProviderRootPath). Naming the files concretely survives that filter
  // and travels with any subpath scope. `memory` is not a relayfile provider.
  const mountedProviders = new Set<string>();
  for (const path of paths) {
    const [provider] = normalizeRelayfilePath(path).split("/").filter(Boolean);
    if (provider && provider !== "memory") {
      mountedProviders.add(provider);
    }
  }
  for (const provider of mountedProviders) {
    paths.add(`/${provider}/LAYOUT.md`);
    paths.add(`/${provider}/_index.json`);
    if (provider === "github") {
      paths.add("/github/repos/_index.json");
    }
  }

  return [...paths].filter(Boolean).sort((left, right) => left.localeCompare(right));
}

export async function registerPersonaCronSchedules(input: {
  workspaceId: string;
  agentId: string;
  schedules: PersonaSchedule[];
  requestOrigin: string;
  // Plaintext secret that the cron service will echo on each tick. The cloud's
  // deployment ticks endpoint hashes this incoming header and compares it to
  // `agents.schedule_webhook_secret_hash`; without it, every cron tick 401s.
  webhookSecret: string;
  existingRelaycronScheduleIds?: string[];
}): Promise<RegisteredCronSchedule[]> {
  if (input.schedules.length === 0) {
    return [];
  }

  const schedules: ScheduleSpec[] = [];
  for (const [index, schedule] of input.schedules.entries()) {
    const cronExpression = schedule.cronExpression ?? schedule.cron;
    if (!cronExpression) {
      throw new PersonaDeployError(
        `schedule at index ${index} is missing a cron expression`,
        "invalid_persona",
        400,
        [{ path: `schedules.${index}.cron`, message: "cron expression is required" }],
      );
    }
    validateSupportedCronGranularity(cronExpression, `schedules.${index}.cron`);
    const scheduleName = nonEmptyString(schedule.name);
    schedules.push({
      ...(scheduleName ? { name: scheduleName } : {}),
      cron: cronExpression,
      tz: nonEmptyString(schedule.timezone) ?? nonEmptyString(schedule.tz) ?? "UTC",
    });
  }

  return registerCronSchedules(resolveAgentGatewayRelaycronEnv(), {
    workspace: input.workspaceId,
    agentId: input.agentId,
    schedules,
    webhookSecret: input.webhookSecret,
    cloudBaseUrl: input.requestOrigin,
    existingRelaycronScheduleIds: input.existingRelaycronScheduleIds,
  });
}

/**
 * Ensure a `personas` row exists with the given deterministic id BEFORE
 * any `persona_versions` insert (which has a FK on `personas.id`).
 *
 * `personaDbId` is derived from the persona slug via
 * `normalizePersonaDatabaseId`, so it's stable across deploys of the
 * same persona — re-deploys take the ON CONFLICT (id) path and update
 * the spec / metadata in place. NOT NULL columns (`spec`, `spec_hash`,
 * `slug`, `intent`, `tags`, `harness`, `model`) are populated from the
 * parsed persona; `visibility`/`use_subscription` rely on table
 * defaults.
 *
 * Without this step the deploy POST 500s with a Postgres FK violation
 * on `persona_versions_persona_id_fkey` for every persona that hasn't
 * been deployed before — see PR description for the production logs.
 */
async function upsertPersona(input: {
  personaDbId: string;
  ownerUserId: string;
  organizationId: string;
  slug: string;
  spec: ParsedPersonaSpec;
  specHash: string;
}): Promise<void> {
  const intent = typeof input.spec.intent === "string" ? input.spec.intent : null;
  const description = typeof input.spec.description === "string" ? input.spec.description : null;
  const harnessKind = typeof input.spec.harness === "string" ? input.spec.harness : null;
  const model = typeof input.spec.model === "string" ? input.spec.model : null;
  const tagList = Array.isArray(input.spec.tags)
    ? input.spec.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const tagsLiteral = toPostgresTextArrayLiteral(tagList);
  await getDb().execute(sql`
    INSERT INTO personas (
      id,
      owner_user_id,
      organization_id,
      slug,
      intent,
      tags,
      description,
      harness_kind,
      model,
      spec,
      spec_hash
    )
    VALUES (
      ${input.personaDbId},
      ${input.ownerUserId},
      ${input.organizationId},
      ${input.slug},
      ${intent},
      ${tagsLiteral}::text[],
      ${description},
      ${harnessKind},
      ${model},
      ${JSON.stringify(input.spec)}::jsonb,
      ${input.specHash}
    )
    ON CONFLICT (id) DO UPDATE
      SET
        slug = EXCLUDED.slug,
        intent = EXCLUDED.intent,
        tags = EXCLUDED.tags,
        description = EXCLUDED.description,
        harness_kind = EXCLUDED.harness_kind,
        model = EXCLUDED.model,
        spec = EXCLUDED.spec,
        spec_hash = EXCLUDED.spec_hash,
        updated_at = NOW()
  `);
}

async function persistPersonaVersion(input: {
  personaId: string;
  spec: ParsedPersonaSpec | DeploymentSpecSnapshot;
  specHash: string;
  bundleSha256: string;
  pinnedVersion?: { version: number };
}): Promise<{ id: string; version: number; created: boolean }> {
  if (input.pinnedVersion) {
    const result = await getDb().execute(sql`
      SELECT id, version
      FROM persona_versions
      WHERE persona_id = ${input.personaId}
        AND version = ${input.pinnedVersion.version}
      LIMIT 1
    `);
    const row = rowsOf<{ id: string; version: number }>(result)[0];
    if (!row) {
      throw new PersonaDeployError(
        `persona version ${input.pinnedVersion.version} was not found`,
        "persona_version_not_found",
        400,
      );
    }
    // Same bundle-pointer refresh as the spec-hash path below: the
    // pinned version row may exist from a prior deploy whose bundle
    // is gone (S3 GC, schema migration backfill), and the caller
    // just uploaded a fresh bundle in `preparePersonaDeploy`. Without
    // this UPDATE the cold-start tick handler reads `bundleSha256 = null`
    // and can't provision a sandbox.
    await getDb().execute(sql`
      UPDATE persona_versions
      SET bundle_sha256 = ${input.bundleSha256}
      WHERE id = ${row.id}
    `);
    return { ...row, created: false };
  }

  const existing = await getDb().execute(sql`
    SELECT id, version
    FROM persona_versions
    WHERE persona_id = ${input.personaId}
      AND spec_hash = ${input.specHash}
    LIMIT 1
  `);
  const existingRow = rowsOf<{ id: string; version: number }>(existing)[0];
  if (existingRow) {
    // Update the bundle pointer on a re-deploy even when the spec didn't
    // change — the bundle content may be different (e.g. dependency
    // update changed agent.bundle.mjs without changing persona JSON).
    await getDb().execute(sql`
      UPDATE persona_versions
      SET bundle_sha256 = ${input.bundleSha256}
      WHERE id = ${existingRow.id}
    `);
    return { ...existingRow, created: false };
  }

  const id = crypto.randomUUID();
  // Bind timestamps with SQL `NOW()` (matching `upsertPersona`'s existing
  // pattern in this file at L653) rather than `${new Date()}`. On the
  // Cloudflare Worker the `pg`/`pg-cloudflare` path serializes parameters
  // through `Buffer.from(value)`, which throws
  //   `TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be
  //    of type string or an instance of Buffer or ArrayBuffer. Received
  //    an instance of Date`
  // synchronously — the query never reaches Postgres. Verified via the
  // PR #728 cause-chain log against prod. On Lambda this happened to
  // work because the native `pg-native`/`libpq` path coerces `Date` to
  // a timestamptz string before the Buffer step.
  const inserted = await getDb().execute(sql`
    INSERT INTO persona_versions (id, persona_id, version, spec, spec_hash, bundle_sha256, created_at)
    SELECT
      ${id},
      ${input.personaId},
      COALESCE(MAX(version), 0) + 1,
      ${JSON.stringify(input.spec)}::jsonb,
      ${input.specHash},
      ${input.bundleSha256},
      NOW()
    FROM persona_versions
    WHERE persona_id = ${input.personaId}
    ON CONFLICT (persona_id, spec_hash) DO UPDATE
      SET spec = EXCLUDED.spec,
          bundle_sha256 = EXCLUDED.bundle_sha256
    RETURNING id, version
  `);
  const row = rowsOf<{ id: string; version: number }>(inserted)[0];
  if (!row) {
    throw new PersonaDeployError("Failed to persist persona version", "persona_version_persist_failed", 500);
  }
  return { ...row, created: row.id === id };
}

async function upsertAgent(input: {
  workspaceId: string;
  personaId: string;
  deployedName: string;
  imageUrl: string | null;
  deployedByUserId: string;
  inputs: Record<string, string>;
  credentialSelections: Record<string, string>;
  pinnedVersionId: string;
  specHash: string;
  watchGlobs: string[];
  watchRules: unknown[] | null;
  inboxSelectors: string[];
  deliveryMaxConcurrency: number | null;
  deliveryMaxConcurrencyByTrigger: Record<string, number> | null;
}): Promise<{ id: string; created: boolean; previousScheduleIds: string[]; previousStatus: string | null }> {
  // Timestamps bound via `NOW()` — see the rationale on
  // `persistPersonaVersion` above (`pg-cloudflare` on the Worker can't
  // `Buffer.from(Date)`).
  const existing = await getDb().execute(sql`
    SELECT id, status, schedule_ids, input_values
    FROM agents
    WHERE workspace_id = ${input.workspaceId}
      AND persona_id = ${input.personaId}
      AND status != 'destroyed'
    LIMIT 1
  `);
  const watchGlobsLiteral = toPostgresTextArrayLiteral(input.watchGlobs);
  const inboxSelectorsLiteral = toPostgresTextArrayLiteral(input.inboxSelectors);
  const watchRulesJson = input.watchRules && input.watchRules.length > 0 ? JSON.stringify(input.watchRules) : null;
  const deliveryMaxConcurrencyByTriggerJson = input.deliveryMaxConcurrencyByTrigger
    ? JSON.stringify(input.deliveryMaxConcurrencyByTrigger)
    : null;
  const existingRow = rowsOf<{
    id: string;
    status: string | null;
    schedule_ids: string[] | null;
    input_values?: unknown;
  }>(existing)[0];
  if (existingRow) {
    const mergedInputs = {
      ...(isStringRecord(existingRow.input_values) ? existingRow.input_values : {}),
      ...input.inputs,
    };
    await getDb().execute(sql`
      UPDATE agents
      SET pinned_version_id = ${input.pinnedVersionId},
          credential_selections = ${JSON.stringify(input.credentialSelections)}::jsonb,
          input_values = ${JSON.stringify(mergedInputs)}::jsonb,
          image_url = COALESCE(${input.imageUrl}, image_url),
          spec_hash_at_deploy = ${input.specHash},
          watch_globs = ${watchGlobsLiteral}::text[],
          watch_rules = ${watchRulesJson}::jsonb,
          inbox_selectors = ${inboxSelectorsLiteral}::text[],
          delivery_max_concurrency = ${input.deliveryMaxConcurrency},
          delivery_max_concurrency_by_trigger = ${deliveryMaxConcurrencyByTriggerJson}::jsonb,
          last_error = NULL,
          updated_at = NOW(),
          status = 'active'
      WHERE id = ${existingRow.id}
    `);
    return {
      id: existingRow.id,
      created: false,
      previousScheduleIds: Array.isArray(existingRow.schedule_ids) ? existingRow.schedule_ids : [],
      previousStatus: existingRow.status ?? null,
    };
  }

  const id = crypto.randomUUID();
  const inserted = await getDb().execute(sql`
    INSERT INTO agents (
      id,
      workspace_id,
      persona_id,
      deployed_name,
      image_url,
      deployed_by_user_id,
      credential_selections,
      input_values,
      pinned_version_id,
      spec_hash_at_deploy,
      status,
      spawned_by_agent_id,
      watch_globs,
      watch_rules,
      inbox_selectors,
      delivery_max_concurrency,
      delivery_max_concurrency_by_trigger,
      schedule_ids,
      schedule_webhook_secret_hash,
      last_error,
      last_used_at,
      created_at,
      updated_at
    )
    VALUES (
      ${id},
      ${input.workspaceId},
      ${input.personaId},
      ${input.deployedName},
      ${input.imageUrl},
      ${input.deployedByUserId},
      ${JSON.stringify(input.credentialSelections)}::jsonb,
      ${JSON.stringify(input.inputs)}::jsonb,
      ${input.pinnedVersionId},
      ${input.specHash},
      'active',
      NULL,
      ${watchGlobsLiteral}::text[],
      ${watchRulesJson}::jsonb,
      ${inboxSelectorsLiteral}::text[],
      ${input.deliveryMaxConcurrency},
      ${deliveryMaxConcurrencyByTriggerJson}::jsonb,
      ARRAY[]::text[],
      NULL,
      NULL,
      NULL,
      NOW(),
      NOW()
    )
    RETURNING id
  `);
  const row = rowsOf<{ id: string }>(inserted)[0];
  if (!row) {
    throw new PersonaDeployError("Failed to upsert agent", "agent_upsert_failed", 500);
  }
  return { id: row.id, created: true, previousScheduleIds: [], previousStatus: null };
}

async function updateAgentScheduleState(input: {
  agentId: string;
  scheduleIds: string[];
  webhookSecretHash: string | null;
}): Promise<void> {
  const scheduleIdsLiteral = toPostgresTextArrayLiteral(input.scheduleIds);
  await getDb().execute(sql`
    UPDATE agents
    SET schedule_ids = ${scheduleIdsLiteral}::text[],
        schedule_webhook_secret_hash = ${input.webhookSecretHash},
        updated_at = NOW()
    WHERE id = ${input.agentId}
  `);
}

async function cancelRelaycronSchedules(input: {
  relaycronScheduleIds: string[];
  logPrefix?: string;
}): Promise<string[]> {
  if (input.relaycronScheduleIds.length === 0) {
    return [];
  }

  const failedScheduleIds: string[] = [];
  let env: ReturnType<typeof resolveAgentGatewayRelaycronEnv>;
  try {
    env = resolveAgentGatewayRelaycronEnv();
  } catch (error) {
    console.error(
      input.logPrefix ?? "[persona-bundle-deploy] failed to cancel relaycron schedule",
      "all",
      error instanceof Error ? error.message : String(error),
    );
    return [...input.relaycronScheduleIds];
  }
  for (const relaycronScheduleId of input.relaycronScheduleIds) {
    try {
      await cancelCronSchedule(env, relaycronScheduleId);
    } catch (error) {
      failedScheduleIds.push(relaycronScheduleId);
      console.error(
        input.logPrefix ?? "[persona-bundle-deploy] failed to cancel relaycron schedule",
        relaycronScheduleId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return failedScheduleIds;
}

async function readActiveRelaycronScheduleIdsForAgent(input: {
  workspaceId: string;
  agentId: string;
}): Promise<string[]> {
  const env = resolveAgentGatewayRelaycronEnv();
  let scannedScheduleCount = 0;
  const schedules = await listCronSchedules(env, {
    status: "active",
    filter: (schedule) => {
      const metadata = schedule.metadata;
      return Boolean(
        metadata
          && metadata.source === "cloud"
          && metadata.workspace === input.workspaceId
          && metadata.agentId === input.agentId,
      );
    },
    onPage: ({ count }) => {
      scannedScheduleCount += count;
    },
  });
  const matchedScheduleIds = schedules
    .map((schedule) => schedule.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  console.info(
    "[persona-bundle-deploy] reconciled active relaycron schedules",
    JSON.stringify({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      scannedScheduleCount,
      matchedScheduleCount: matchedScheduleIds.length,
    }),
  );
  return matchedScheduleIds;
}

export async function createInitialAgentDeployment(input: {
  agentId: string;
  specHash: string;
  triggerKind?: "inbox" | "clock";
  triggerPayload?: unknown;
}): Promise<string> {
  const id = crypto.randomUUID();
  const inserted = await getDb().execute(sql`
    INSERT INTO agent_deployments (
      id,
      agent_id,
      trigger_kind,
      trigger_payload,
      started_at,
      last_active_at,
      status,
      spec_hash_at_run,
      timed_out_at,
      compaction_summary,
      parent_deployment_id
    )
    VALUES (
      ${id},
      ${input.agentId},
      ${input.triggerKind ?? "inbox"},
      ${JSON.stringify(input.triggerPayload ?? {})}::jsonb,
      NOW(),
      NOW(),
      'running',
      ${input.specHash},
      NULL,
      NULL,
      NULL
    )
    RETURNING id
  `);
  const row = rowsOf<{ id: string }>(inserted)[0];
  if (!row) {
    throw new PersonaDeployError("Failed to create initial deployment", "deployment_insert_failed", 500);
  }
  return row.id;
}

export function generateDeploymentWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashDeploymentWebhookSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function verifyDeploymentWebhookSecret(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashDeploymentWebhookSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function getAgentDeploymentTickTarget(input: {
  workspaceId: string;
  agentId: string;
}): Promise<{
  agentId: string;
  deployedName: string;
  deployedByUserId: string;
  /** Pinned persona spec — needed to compute relayfile paths + cron context at tick time. */
  spec: Record<string, unknown> | null;
  /** Pinned agent spec when the stored persona version is a deployment snapshot. */
  agentSpec: DeploymentAgentSpec | null;
  inputValues: Record<string, string>;
  credentialSelections: Record<string, string>;
  specHash: string;
  /**
   * SHA256 of the persona bundle stored in S3. `null` for legacy agents
   * deployed before cold-start; those rows can't satisfy a cold-start
   * tick — the tick handler 410s when the pointer is missing.
   */
  bundleSha256: string | null;
  personaSlug: string;
  status: string;
  webhookSecretHash: string | null;
} | null> {
  // Join through agents → pinned persona_versions to grab the bundle
  // pointer + the spec snapshot at deploy time. Falls back to
  // `personas.spec` if pinnedVersionId is null (shouldn't happen
  // post-cloud#597 but defended for legacy rows).
  const result = await getDb().execute(sql`
    SELECT
      a.id,
      a.deployed_name,
      a.deployed_by_user_id,
      a.input_values,
      a.credential_selections,
      a.spec_hash_at_deploy,
      a.status,
      a.schedule_webhook_secret_hash,
      pv.bundle_sha256 AS pv_bundle_sha256,
      pv.spec AS pv_spec,
      p.slug AS persona_slug,
      p.spec AS p_spec
    FROM agents a
    LEFT JOIN persona_versions pv ON pv.id = a.pinned_version_id
    LEFT JOIN personas p ON p.id = a.persona_id
    WHERE a.id = ${input.agentId}
      AND a.workspace_id = ${input.workspaceId}
      AND a.status != 'destroyed'
    LIMIT 1
  `);
  const row = rowsOf<{
    id: string;
    deployed_name: string;
    deployed_by_user_id: string;
    input_values: unknown;
    credential_selections: unknown;
    spec_hash_at_deploy: string;
    status: string;
    schedule_webhook_secret_hash: string | null;
    pv_bundle_sha256: string | null;
    pv_spec: unknown;
    persona_slug: string | null;
    p_spec: unknown;
  }>(result)[0];
  if (!row) {
    return null;
  }
  const rawSpec = isRecord(row.pv_spec)
    ? row.pv_spec
    : isRecord(row.p_spec)
    ? row.p_spec
    : null;
  const spec = deploymentPersonaSpec(rawSpec);
  const agentSpec = deploymentAgentSpec(rawSpec);
  return {
    agentId: row.id,
    deployedName: row.deployed_name,
    deployedByUserId: row.deployed_by_user_id,
    spec,
    agentSpec,
    inputValues: isStringRecord(row.input_values) ? row.input_values : {},
    credentialSelections: isStringRecord(row.credential_selections) ? row.credential_selections : {},
    specHash: row.spec_hash_at_deploy,
    bundleSha256: row.pv_bundle_sha256,
    personaSlug: row.persona_slug ?? row.deployed_name,
    status: row.status,
    webhookSecretHash: row.schedule_webhook_secret_hash,
  };
}

export async function preparePersonaDeploy(input: PersonaBundleDeployInput): Promise<{
  persona: ParsedPersonaSpec;
  personaDbId: string;
  deployedName: string;
  specHash: string;
  watchGlobs: string[];
  versionId: string;
  agentId: string;
  scheduleIds: string[];
  relayfileMountPaths: string[];
  webhookSecret: string;
  relaycronScheduleIds: string[];
  versionCreated: boolean;
  agentCreated: boolean;
}> {
  const hasAgent = input.agent !== undefined;
  const personaSandbox = readPersonaSandboxSetting(input.persona);
  const personaSource = personaSandbox === undefined
    ? input.persona
    : personaForKitParser(input.persona);
  if (hasAgent) {
    assertNoLegacyListenerFieldsWhenAgentPresent(personaSource);
  }
  const agentSpec = hasAgent
    ? await parseDeploymentAgentSpec(input.agent)
    : await parseDeploymentAgentSpec(legacyAgentSpecFromPersona(personaSource));
  validateAgentSchedules(agentSpec);
  const personaInput = hasAgent ? personaSource : stripLegacyListenerFields(personaSource);
  const persona = await parsePersonaSpec(personaInput);
  if (personaSandbox !== undefined) {
    persona.sandbox = personaSandbox;
  }
  // persona-kit >= 3.0.42 (workforce#183 / cloud#1732) preserves every declared
  // capability through `parseCapabilities`, including cloud-owned ones like
  // `teamSolve` that it does not model directly. So the cloud no longer
  // re-attaches dropped capabilities — the bundled persona-kit parse is the
  // single functional mechanism.
  //
  // We previously (cloud#1729) SILENTLY re-attached a dropped cloud-owned
  // capability. That backstop MASKED the team-N=1 root cause for weeks: a
  // pre-3.0.42 parser stripped `teamSolve`, the cloud quietly restored it, and
  // the only observable was a milestone that mysteriously did not fire. A
  // silent fix for a silent strip is exactly the fragility that cost us that
  // time. So instead of papering over it, DETECT and surface it loudly: if the
  // source persona declared a cloud-owned capability but the parsed spec
  // dropped it, the cloud worker's bundled persona-kit stripped it (e.g. a
  // downgrade below 3.0.42) — fail the deploy with an alertable
  // `[capability-strip-regression]` signal rather than shipping a persona whose
  // capability was silently lost. See cloud#1724 / cloud#1732 / workforce#182.
  const sourceCapabilities = isRecord(input.persona)
    ? input.persona.capabilities
    : undefined;
  if (isRecord(sourceCapabilities)) {
    const parsedCapabilities = isRecord(persona.capabilities)
      ? persona.capabilities
      : {};
    const strippedCapabilities = CLOUD_OWNED_CAPABILITY_KEYS.filter(
      (key) =>
        Object.hasOwn(sourceCapabilities, key)
        && !Object.hasOwn(parsedCapabilities, key),
    );
    if (strippedCapabilities.length > 0) {
      const personaId = typeof persona.id === "string" ? persona.id : "(unknown)";
      // Structured, alertable log emitted BEFORE the throw so the regression is
      // observable even if the error is handled upstream.
      console.error(
        "[capability-strip-regression] persona-kit dropped declared cloud-owned capabilities during deploy",
        personaId,
        strippedCapabilities.join(","),
      );
      throw new PersonaDeployError(
        `[capability-strip-regression] persona-kit dropped declared cloud-owned capabilities (${strippedCapabilities.join(
          ", ",
        )}); the cloud worker's @agentworkforce/persona-kit must be >= 3.0.42 to preserve them`,
        "capability_strip_regression",
        500,
        strippedCapabilities.map((key) => ({
          path: `capabilities.${key}`,
          message: "declared cloud-owned capability dropped by persona-kit parse",
        })),
      );
    }
  }
  // Resolve `${INPUT}` references in trigger/watch paths against the
  // deploy-resolved inputs (picker selections, env, defaults) BEFORE deriving
  // the spec snapshot, watch_globs, watch_rules, mount paths, and token scopes —
  // so all of them see concrete paths. Lets a channel be chosen via a picker
  // input instead of hardcoded (cloud#1999). Mutates persona/agentSpec in place.
  interpolateTriggerPathInputs(persona, agentSpec, effectiveDeployInputs(persona, input.inputs));
  // Cloud keeps this raw overlay until every deployed persona-kit version
  // preserves maxConcurrency during parseAgentSpec. Without it, trigger-keyed
  // watch rules would not be emitted for capped triggers in the current
  // package even though the raw deploy payload declared the cap.
  copyTriggerMaxConcurrencyFromRawAgent(agentSpec, input.agent);
  const deploymentSpec: DeploymentSpecSnapshot = {
    persona,
    agent: agentSpec,
    ...(persona.sandbox !== undefined ? { sandbox: persona.sandbox } : {}),
  };
  const personaDbId = normalizePersonaDatabaseId(persona.id);
  const deployedName =
    typeof persona.slug === "string" && persona.slug.trim()
      ? persona.slug.trim()
      : typeof persona.name === "string" && persona.name.trim()
      ? persona.name.trim()
      : persona.id;
  const imageUrl =
    input.summary?.imageUrl ??
    (isRecord(input.persona) ? normalizeHttpUrl(input.persona.imageUrl) : null);
  const personaSpecHash = stableSpecHash(persona);
  const specHash = stableSpecHash(deploymentSpec);
  const watchGlobs = translatePersonaTriggersToWatchGlobs(persona, agentSpec);
  const watchRules = readDeploymentWatchRules(persona, agentSpec);
  const inboxSelectors = translatePersonaRelayToInboxSelectors({
    persona,
    agent: agentSpec,
    rawPersona: input.persona,
    rawAgent: input.agent,
  });
  const deliveryMaxConcurrency = deriveDeliveryMaxConcurrency(input.agent);
  const deliveryMaxConcurrencyByTrigger = deriveDeliveryMaxConcurrencyByTrigger(input.agent);
  const relayfileMountPaths = deriveRelayfileMountPaths(persona, agentSpec);
  const scheduleWebhookSecret = generateDeploymentWebhookSecret();

  // `persona_versions.persona_id` is a FK to `personas.id`. The
  // upsert below ensures the parent row exists before the version
  // insert — first-time deploys would otherwise hit a Postgres FK
  // violation and the route would 500 with `deployment_failed`.
  await upsertPersona({
    personaDbId,
    ownerUserId: input.userId,
    organizationId: input.organizationId,
    slug: persona.id,
    spec: persona,
    specHash: personaSpecHash,
  });

  // Cold-start runtime: persist the bundle in S3 keyed by SHA256. The
  // tick handler reads by this hash when provisioning a sandbox at
  // first trigger fire. Idempotent — re-deploying the same bundle is
  // an S3 PutObject overwrite to the same key.
  const storedBundle = await storeBundle(input.bundle);

  const version = await persistPersonaVersion({
    personaId: personaDbId,
    spec: deploymentSpec,
    specHash,
    bundleSha256: storedBundle.sha256,
    pinnedVersion: input.pinnedVersion,
  });
  const agent = await upsertAgent({
    workspaceId: input.workspaceId,
    personaId: personaDbId,
    deployedName,
    imageUrl,
    deployedByUserId: input.userId,
    inputs: input.inputs ?? {},
    credentialSelections: input.credentialSelections ?? {},
    pinnedVersionId: version.id,
    specHash,
    watchGlobs,
    watchRules,
    inboxSelectors,
    deliveryMaxConcurrency,
    deliveryMaxConcurrencyByTrigger,
  });
  let scheduleRegistrations: RegisteredCronSchedule[] = [];
  let scheduleIds: string[] = [];
  try {
    const declaredSchedules = Array.isArray(agentSpec.schedules) ? agentSpec.schedules : [];
    const shouldReconcileRelaycronSchedules =
      !agent.created
      && (
        agent.previousStatus === "error"
        || (declaredSchedules.length > 0 && agent.previousScheduleIds.length === 0)
      );
    const activeRelaycronScheduleIds = shouldReconcileRelaycronSchedules
      ? await readActiveRelaycronScheduleIdsForAgent({
          workspaceId: input.workspaceId,
          agentId: agent.id,
        })
      : [];
    scheduleRegistrations = await registerPersonaCronSchedules({
      workspaceId: input.workspaceId,
      agentId: agent.id,
      schedules: declaredSchedules,
      requestOrigin: input.requestOrigin,
      webhookSecret: scheduleWebhookSecret,
      existingRelaycronScheduleIds: agent.previousScheduleIds,
    });
    scheduleIds = scheduleRegistrations.map((schedule) => schedule.relaycronScheduleId);
    await updateAgentScheduleState({
      agentId: agent.id,
      scheduleIds,
      webhookSecretHash: hashDeploymentWebhookSecret(scheduleWebhookSecret),
    });
    const knownScheduleIds = new Set([...agent.previousScheduleIds, ...activeRelaycronScheduleIds]);
    const obsoleteScheduleIds = [...knownScheduleIds].filter((scheduleId) => !scheduleIds.includes(scheduleId));
    const failedObsoleteScheduleIds = await cancelRelaycronSchedules({ relaycronScheduleIds: obsoleteScheduleIds });
    if (failedObsoleteScheduleIds.length > 0) {
      await updateAgentScheduleState({
        agentId: agent.id,
        scheduleIds: [...scheduleIds, ...failedObsoleteScheduleIds.filter((scheduleId) => !scheduleIds.includes(scheduleId))],
        webhookSecretHash: hashDeploymentWebhookSecret(scheduleWebhookSecret),
      });
    }
  } catch (error) {
    const createdScheduleIds = scheduleRegistrations
      .filter((schedule) => schedule.created)
      .map((schedule) => schedule.relaycronScheduleId);
    await rollbackPreparedPersonaDeploy({
      agentId: agent.id,
      agentCreated: agent.created,
      versionId: version.id,
      versionCreated: version.created,
      relaycronScheduleIds: createdScheduleIds,
      reason: "prepare failed after registration",
    });
    throw error;
  }
  return {
    persona,
    personaDbId,
    deployedName,
    specHash,
    watchGlobs,
    versionId: version.id,
    agentId: agent.id,
    scheduleIds,
    relayfileMountPaths,
    webhookSecret: scheduleWebhookSecret,
    relaycronScheduleIds: scheduleRegistrations
      .filter((schedule) => schedule.created)
      .map((schedule) => schedule.relaycronScheduleId),
    versionCreated: version.created,
    agentCreated: agent.created,
  };
}

export type DestroyAgentResult = {
  agentId: string;
  destroyedAt: Date;
  cancelledScheduleIds: string[];
};

/**
 * Tear down a deployed agent. Cancels all relaycron schedules referenced
 * by `agent.schedule_ids` (best-effort; individual failures are logged but
 * never block the destroy) and marks the agent row `status = 'destroyed'`.
 *
 * Returns `null` if the agent doesn't exist, isn't owned by `workspaceId`,
 * or is already `status === 'destroyed'` (idempotent — callers should treat
 * this as a 404).
 */
const DESTROY_TARGET_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function destroyAgent(input: {
  workspaceId: string;
  agentId: string;
  userId: string;
}): Promise<DestroyAgentResult | null> {
  // `agentId` may be a real agent UUID or a human-friendly deployed name
  // (what `agentworkforce destroy <name>` forwards). Resolve names against the
  // workspace's live agents — the `agents_workspace_deployed_name_live_unique`
  // partial index guarantees at most one non-destroyed match. Passing a
  // non-UUID straight into the `uuid`-typed `id` column would otherwise raise a
  // Postgres `22P02` cast error and surface as an opaque 500.
  const lookup = await getDb().execute(
    DESTROY_TARGET_UUID_PATTERN.test(input.agentId)
      ? sql`
          SELECT id, workspace_id, status, schedule_ids
          FROM agents
          WHERE workspace_id = ${input.workspaceId}
            AND status != 'destroyed'
            AND (
              id = ${input.agentId}::uuid
              OR deployed_name = ${input.agentId}
            )
          ORDER BY CASE WHEN id = ${input.agentId}::uuid THEN 0 ELSE 1 END
          LIMIT 1
        `
      : sql`
          SELECT id, workspace_id, status, schedule_ids
          FROM agents
          WHERE workspace_id = ${input.workspaceId}
            AND deployed_name = ${input.agentId}
            AND status != 'destroyed'
          LIMIT 1
        `,
  );
  const row = rowsOf<{
    id: string;
    workspace_id: string;
    status: string;
    schedule_ids: string[] | null;
  }>(lookup)[0];
  if (!row) {
    return null;
  }
  if (row.workspace_id !== input.workspaceId) {
    return null;
  }
  if (row.status === "destroyed") {
    return null;
  }

  // From here on, target the resolved UUID — `input.agentId` may be a name.
  const resolvedAgentId = row.id;

  const scheduleIds = Array.isArray(row.schedule_ids) ? row.schedule_ids : [];
  const failedScheduleIds = await cancelRelaycronSchedules({
    relaycronScheduleIds: scheduleIds,
    logPrefix: "[persona-bundle-destroy] failed to cancel relaycron schedule",
  });
  const failedScheduleIdSet = new Set(failedScheduleIds);
  const cancelledScheduleIds = scheduleIds.filter((scheduleId) => !failedScheduleIdSet.has(scheduleId));
  const retainedScheduleIdsLiteral = toPostgresTextArrayLiteral(failedScheduleIds);

  // Keep `destroyedAt` as a JS Date for the returned result shape, but
  // bind the ISO string to SQL — see `persistPersonaVersion` above for
  // why a raw `${Date}` bind fails on the Worker (`pg-cloudflare`).
  const destroyedAt = new Date();
  const destroyedAtIso = destroyedAt.toISOString();
  const updated = await getDb().execute(sql`
    UPDATE agents
    SET status = 'destroyed',
        destroyed_at = ${destroyedAtIso},
        destroyed_by_user_id = ${input.userId},
        schedule_ids = ${retainedScheduleIdsLiteral}::text[],
        schedule_webhook_secret_hash = NULL,
        updated_at = ${destroyedAtIso}
    WHERE id = ${resolvedAgentId}::uuid
      AND workspace_id = ${input.workspaceId}
      AND status != 'destroyed'
    RETURNING id
  `);
  if (rowsOf<{ id: string }>(updated).length !== 1) {
    return null;
  }

  // Cascade: cancel any non-terminal teams this agent spawned (spec §13).
  try {
    const { cancelTeamsForParentAgent } = await import("@/lib/teams/reaper");
    await cancelTeamsForParentAgent(resolvedAgentId, destroyedAt);
  } catch (error) {
    console.error(
      "[persona-bundle-destroy] team cascade-cancel failed",
      resolvedAgentId,
      error instanceof Error ? error.message : String(error),
    );
  }

  console.info(
    "[persona-bundle-destroy] agent destroyed",
    JSON.stringify({
      agentId: resolvedAgentId,
      requestedTarget: input.agentId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      cancelledScheduleIds,
      failedScheduleIds,
      totalScheduleIds: scheduleIds.length,
    }),
  );

  return {
    agentId: resolvedAgentId,
    destroyedAt,
    cancelledScheduleIds,
  };
}

export async function rollbackPreparedPersonaDeploy(input: {
  agentId: string;
  agentCreated: boolean;
  versionId: string;
  versionCreated: boolean;
  relaycronScheduleIds: string[];
  reason: string;
}): Promise<void> {
  const env =
    input.relaycronScheduleIds.length > 0
      ? resolveAgentGatewayRelaycronEnv()
      : null;

  for (const relaycronScheduleId of input.relaycronScheduleIds) {
    try {
      await cancelCronSchedule(env!, relaycronScheduleId);
    } catch (error) {
      console.error(
        "[persona-bundle-deploy] failed to cancel relaycron schedule",
        relaycronScheduleId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (input.agentCreated) {
    await getDb().execute(sql`
      DELETE FROM agents
      WHERE id = ${input.agentId}
    `);
  } else {
    await getDb().execute(sql`
      UPDATE agents
      SET status = 'error',
          schedule_ids = ARRAY[]::text[],
          schedule_webhook_secret_hash = NULL,
          last_error = ${input.reason},
          updated_at = NOW()
      WHERE id = ${input.agentId}
    `);
  }

  if (input.versionCreated && input.agentCreated) {
    await getDb().execute(sql`
      DELETE FROM persona_versions
      WHERE id = ${input.versionId}
    `);
  }
}
