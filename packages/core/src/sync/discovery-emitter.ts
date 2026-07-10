// Writeback discovery materialization.
//
// THE DEFECT THIS FIXES
// ---------------------
// Every nango-backed provider's adapter package ships three things:
//
//   1. `layoutPromptFile()` — produces `<provider>/LAYOUT.md`, whose text
//      advertises a writeback discovery contract: "read
//      `discovery/<provider>/.../.schema.json` and
//      `.../.create.example.json` before writing".
//   2. `resources` — a `readonly AdapterResourceConfig[]` declaring the
//      EXACT `discovery/...` schema + create-example paths for each
//      writable resource (the same literal strings LAYOUT.md advertises;
//      both come from the same adapter package version).
//   3. `executeFileNativeWriteback(...)` (adapter-core) — the writeback
//      router that CONSUMES `resource.schema` to validate payloads.
//
// What no code anywhere ever did: WRITE those discovery files. The cloud
// `record-writer.ts` calls `writeCommonLayouts` (LAYOUT.md, advertising the
// contract) and `emitXAuxiliaryFiles` (record/index/alias trees) but never
// materialized `.schema.json` / `.create.example.json` / `.adapter.md`.
// `git log -S "discovery/"` on record-writer.ts is empty: the producer side
// of the discovery contract was never implemented, even though the LAYOUT
// (advertiser) and the writeback router (consumer) both shipped.
//
// THE FIX (generic, no per-provider special casing)
// -------------------------------------------------
// This module is the producer. It is driven entirely by each adapter's
// exported `resources[]` — the same array the LAYOUT text and the writeback
// router are derived from — so the advertised contract and the materialized
// files cannot diverge. For every resource it emits, at the resource's
// LITERAL advertised paths (placeholders like `{owner}` intact, exactly as
// LAYOUT.md prints them and exactly as the router's `loadSchema` reads
// `resource.schema`):
//
//   - `<resource.schema>`         JSON Schema draft 2020-12 inferred from the
//                                  synced records, server-managed fields
//                                  marked `readOnly`.
//   - `<resource.createExample>`  Minimal create payload, read-only and
//                                  server-managed fields omitted.
//   - `discovery/<provider>/.adapter.md`  One provider doc enumerating the
//                                  writable resources and the contract.
//
// CONSISTENCY INVARIANT
// ---------------------
// `assertLayoutDiscoveryConsistency` is called from the same code path that
// writes `<provider>/LAYOUT.md`. If the LAYOUT advertises `discovery/...`
// but the adapter exports no `resources` to materialize from (or vice
// versa), it logs loudly. The advertiser and the producer are now wired to
// the same source of truth so the original silent contradiction cannot
// recur.
//
// IDEMPOTENCY / BACKFILL
// ----------------------
// All writes go through `writeManagedFile`, which no-ops when the content is
// byte-identical. Discovery emission therefore runs on EVERY sync (not just
// first connect), so pre-existing workspaces (e.g. rw_fc7b534b) backfill the
// entire discovery surface on their next normal sync — no migration needed.

import type { RelayfileWriteClient } from "./record-writer.js";
import { AUTHORED_ADAPTER_DISCOVERY_ARTIFACTS } from "./adapter-discovery-authored.generated.js";

/**
 * The resource-config shape every nango adapter exports as `resources`.
 * Structurally identical to each adapter's `AdapterResourceConfig`
 * (re-declared here so this module doesn't depend on a specific adapter
 * package's type export).
 */
export interface AdapterResourceConfig {
  readonly name: string;
  readonly path: string;
  readonly pathPattern: RegExp;
  readonly idPattern: RegExp;
  /**
   * Optional concrete index root for resources whose advertised writeback path
   * contains placeholders but whose sync materializes a provider-level
   * enumeration index. Example: Google Calendar events are advertised at
   * `/google-calendar/calendars/{calendarId}/events`, while the sampler can
   * enumerate `/google-calendar/events/_index.json`.
   */
  readonly sampleIndexPath?: string;
  /** Literal advertised discovery schema path, e.g. `discovery/linear/issues/.schema.json`. */
  readonly schema: string;
  /** Literal advertised create-example path. */
  readonly createExample: string;
}

const DISCOVERY_JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const DISCOVERY_MD_CONTENT_TYPE = "text/markdown; charset=utf-8";

/**
 * Field names that are always server-managed for synced provider records
 * across every provider we materialize. Marked `readOnly:true` in the
 * emitted schema and omitted from `.create.example.json`. Provider-specific
 * server fields are additionally covered by {@link isServerManagedField}'s
 * heuristics (timestamps, urls, *_id back-references) so this stays generic.
 */
const ALWAYS_SERVER_MANAGED = new Set<string>([
  "id",
  "url",
  "html_url",
  "self",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "editedAt",
  "edited_at",
  "completedAt",
  "completed_at",
  "archivedAt",
  "archived_at",
  "canceledAt",
  "deletedAt",
  "number",
  "iid",
  "identifier",
  "key",
  "revision",
  "version",
  "etag",
  "_relayfile",
]);

/**
 * Heuristic: is this top-level field server-managed (i.e. an agent must not
 * set it in a create payload)? Generic across providers — timestamps, urls,
 * the Nango sync metadata envelope, and explicit always-managed names.
 */
function isServerManagedField(name: string): boolean {
  if (ALWAYS_SERVER_MANAGED.has(name)) return true;
  if (name.startsWith("_")) return true; // _deleted, _nango_*, etc.
  if (/(^|_)(created|updated|edited|deleted|completed|archived|canceled)([_A-Z]|$)/i.test(name)) {
    return true;
  }
  if (/(url|uri|href)$/i.test(name)) return true;
  if (/^(node|global)?id$/i.test(name)) return true;
  return false;
}

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  readOnly?: boolean;
  additionalProperties?: boolean;
  description?: string;
  $schema?: string;
  title?: string;
};

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value as number) && typeof value === "number") {
    return "integer";
  }
  return typeof value;
}

/**
 * Merge a single sample value into an accumulating schema node. Union of
 * observed types; recurses objects/arrays. Deterministic (sorted keys) so
 * idempotent re-sync produces byte-identical output.
 */
function mergeSchema(
  acc: JsonSchema | undefined,
  value: unknown,
): JsonSchema {
  const node: JsonSchema = acc ? { ...acc } : {};
  const t = jsonTypeOf(value);

  const types = new Set<string>(
    node.type === undefined
      ? []
      : Array.isArray(node.type)
        ? node.type
        : [node.type],
  );
  types.add(t);
  node.type =
    types.size === 1
      ? [...types][0]
      : [...types].sort((a, b) => a.localeCompare(b));

  if (t === "object" && value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const properties: Record<string, JsonSchema> = { ...(node.properties ?? {}) };
    for (const key of Object.keys(record)) {
      properties[key] = mergeSchema(properties[key], record[key]);
    }
    node.properties = sortObject(properties);
    node.additionalProperties = true;
  } else if (t === "array" && Array.isArray(value)) {
    let items: JsonSchema | undefined = node.items;
    for (const element of value) {
      items = mergeSchema(items, element);
    }
    node.items = items ?? {};
  }

  return node;
}

function sortObject<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)),
  ) as Record<string, T>;
}

/**
 * Build a JSON Schema (draft 2020-12) describing the synced records for one
 * resource. Server-managed top-level fields are marked `readOnly:true`.
 * `required` is the set of top-level fields present in EVERY sample (stable
 * fields), excluding read-only ones — that's the create contract.
 */
export function buildResourceSchema(
  provider: string,
  resource: AdapterResourceConfig,
  records: readonly Record<string, unknown>[],
): JsonSchema {
  let merged: JsonSchema | undefined;
  for (const record of records) {
    merged = mergeSchema(merged, record);
  }

  const schema: JsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `${provider} ${resource.name}`,
    description: `Record shape for ${resource.path} (inferred from synced ${provider} ${resource.name}). Fields marked readOnly are server-managed; omit them from create payloads.`,
    type: "object",
    additionalProperties: true,
    properties: {},
  };

  const properties = merged?.properties ?? {};
  const requiredEverywhere = computeRequiredEverywhere(records);
  const required: string[] = [];

  for (const [key, propSchema] of Object.entries(properties)) {
    const node: JsonSchema = { ...propSchema };
    if (isServerManagedField(key)) {
      node.readOnly = true;
    } else if (requiredEverywhere.has(key)) {
      required.push(key);
    }
    schema.properties![key] = node;
  }

  if (required.length > 0) {
    schema.required = required.sort((a, b) => a.localeCompare(b));
  }
  return schema;
}

/**
 * Monotonically merge an on-disk schema (`prior`, parsed from an existing
 * `.schema.json`) with a freshly-inferred one (`next`) so the materialized
 * surface CONVERGES instead of churning per pagination page.
 *
 * `writeBatchToRelayfile` runs once per page of a multi-page sync; each page's
 * `next` is inferred from only that page's records, so without merging the
 * schema content differs page-to-page and `writeManagedFile`'s byte-identical
 * dedup misses, rewriting the discovery file (and bumping revision + writeback
 * /event churn) on most pages of a large initial sync. Merging makes the
 * surface widen monotonically: once every field/type has been observed the
 * content stabilizes and dedup holds for the rest of the sync (and across
 * subsequent incremental single-batch syncs).
 *
 * Merge rules (all monotonic / widening, all deterministic):
 *   - `type`: union of both sides (sorted when >1 — same ordering as
 *     {@link mergeSchema}).
 *   - `properties`: union of keys; shared keys merged recursively. A field
 *     never disappears once observed.
 *   - `required`: INTERSECTION (a field stays required only if required in
 *     BOTH prior and next) so a field absent from a later page relaxes to
 *     optional and never re-tightens. Sorted; dropped when empty.
 *   - `readOnly`: OR (sticky — once server-managed, always server-managed).
 *   - `additionalProperties`: OR (stays permissive — `true` wins) so empty
 *     /not-yet-synced schemas keep `additionalProperties:true` and writeback
 *     validation is never tightened by a partial page.
 *   - Scalar metadata (`$schema`, `title`, `description`): prefer `next`'s
 *     (deterministic for a given provider/resource), fall back to prior.
 *
 * Deterministic: object keys are re-sorted via {@link sortObject} and unions
 * /required are sorted, so the merged JSON serializes byte-identically given
 * the same observed surface regardless of page order.
 */
export function mergeResourceSchemas(
  prior: JsonSchema,
  next: JsonSchema,
): JsonSchema {
  return mergeSchemaNodes(prior, next, true);
}

function unionTypes(
  a: JsonSchema["type"],
  b: JsonSchema["type"],
): JsonSchema["type"] {
  const set = new Set<string>();
  for (const t of a === undefined ? [] : Array.isArray(a) ? a : [a]) set.add(t);
  for (const t of b === undefined ? [] : Array.isArray(b) ? b : [b]) set.add(t);
  if (set.size === 0) return undefined;
  if (set.size === 1) return [...set][0];
  return [...set].sort((x, y) => x.localeCompare(y));
}

function mergeSchemaNodes(
  prior: JsonSchema | undefined,
  next: JsonSchema | undefined,
  topLevel: boolean,
): JsonSchema {
  if (!prior) return next ? { ...next } : {};
  if (!next) return { ...prior };

  const node: JsonSchema = {};

  // Scalar metadata: prefer next (deterministic per provider/resource).
  const $schema = next.$schema ?? prior.$schema;
  if ($schema !== undefined) node.$schema = $schema;
  const title = next.title ?? prior.title;
  if (title !== undefined) node.title = title;
  const description = next.description ?? prior.description;
  if (description !== undefined) node.description = description;

  const type = unionTypes(prior.type, next.type);
  if (type !== undefined) node.type = type;

  // readOnly is sticky (OR) — once server-managed, always server-managed.
  if (prior.readOnly === true || next.readOnly === true) {
    node.readOnly = true;
  }

  // additionalProperties stays permissive (OR) so writeback validation is
  // never tightened by a partial / not-yet-synced page.
  if (prior.additionalProperties === true || next.additionalProperties === true) {
    node.additionalProperties = true;
  } else if (
    prior.additionalProperties === false &&
    next.additionalProperties === false
  ) {
    node.additionalProperties = false;
  }

  // Union of properties; shared keys merged recursively.
  const priorProps = prior.properties;
  const nextProps = next.properties;
  if (priorProps || nextProps) {
    const merged: Record<string, JsonSchema> = {};
    const keys = new Set<string>([
      ...Object.keys(priorProps ?? {}),
      ...Object.keys(nextProps ?? {}),
    ]);
    for (const key of keys) {
      merged[key] = mergeSchemaNodes(
        priorProps?.[key],
        nextProps?.[key],
        false,
      );
    }
    node.properties = sortObject(merged);
  }

  // Array items: widen by merging both sides' item schemas.
  if (prior.items || next.items) {
    node.items = mergeSchemaNodes(prior.items, next.items, false);
  }

  // required: INTERSECTION so a field absent from a later page relaxes to
  // optional (and never re-tightens). Only emitted at the object root /
  // nested object level when non-empty.
  if (topLevel || node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"))) {
    const priorRequired = new Set(prior.required ?? []);
    const nextRequired = next.required ?? [];
    const intersection = nextRequired
      .filter((k) => priorRequired.has(k))
      .sort((a, b) => a.localeCompare(b));
    if (intersection.length > 0) {
      node.required = intersection;
    }
  }

  return node;
}

/** Top-level keys present in every record (and there is at least one record). */
function computeRequiredEverywhere(
  records: readonly Record<string, unknown>[],
): Set<string> {
  if (records.length === 0) return new Set();
  let common: Set<string> | null = null;
  for (const record of records) {
    const keys = new Set(Object.keys(record));
    if (common === null) {
      common = keys;
    } else {
      for (const key of [...common]) {
        if (!keys.has(key)) common.delete(key);
      }
    }
  }
  return common ?? new Set();
}

/**
 * Re-serialize a schema node with a FIXED key order, recursively. Both the
 * batch-inferred path ({@link buildResourceSchema} → {@link mergeSchema}) and
 * the monotonic-merge path ({@link mergeResourceSchemas}) can emit the same
 * logical schema with different physical key insertion order; routing both
 * through this canonicalizer makes `JSON.stringify` byte-identical for an
 * identical surface, so `writeManagedFile`'s dedup actually holds across the
 * pages of a multi-page sync (the whole point of the merge). Property and
 * required key ordering is already sorted upstream; this only fixes the
 * order of the node's OWN keys.
 */
export function canonicalizeSchema(node: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  if (node.$schema !== undefined) out.$schema = node.$schema;
  if (node.title !== undefined) out.title = node.title;
  if (node.description !== undefined) out.description = node.description;
  if (node.type !== undefined) out.type = node.type;
  if (node.readOnly !== undefined) out.readOnly = node.readOnly;
  if (node.additionalProperties !== undefined) {
    out.additionalProperties = node.additionalProperties;
  }
  if (node.properties !== undefined) {
    const props: Record<string, JsonSchema> = {};
    for (const [k, v] of Object.entries(node.properties).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      props[k] = canonicalizeSchema(v);
    }
    out.properties = props;
  }
  if (node.items !== undefined) out.items = canonicalizeSchema(node.items);
  if (node.required !== undefined) {
    out.required = [...node.required].sort((a, b) => a.localeCompare(b));
  }
  return out;
}

/**
 * Minimal create payload: required, non-readOnly fields with a type-shaped
 * placeholder value. Deterministic so re-sync is idempotent.
 */
export function buildCreateExample(schema: JsonSchema): Record<string, unknown> {
  const example: Record<string, unknown> = {};
  const properties = schema.properties ?? {};
  const writableKeys = Object.keys(properties)
    .filter((key) => properties[key]?.readOnly !== true)
    .sort((a, b) => a.localeCompare(b));
  const required = (schema.required ?? [])
    .filter((key) => writableKeys.includes(key))
    .sort((a, b) => a.localeCompare(b));
  const keys = required.length > 0 ? required : writableKeys.slice(0, 5);
  for (const key of keys) {
    const prop = schema.properties?.[key];
    if (!prop || prop.readOnly) continue;
    example[key] = placeholderFor(prop);
  }
  return example;
}

function placeholderFor(prop: JsonSchema): unknown {
  const type = Array.isArray(prop.type)
    ? prop.type.find((t) => t !== "null") ?? prop.type[0]
    : prop.type;
  switch (type) {
    case "string":
      return "";
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return null;
  }
}

function buildAdapterDoc(
  provider: string,
  resources: readonly AdapterResourceConfig[],
): string {
  const lines: string[] = [];
  lines.push(`# ${provider} writeback adapter`);
  lines.push("");
  lines.push(
    "This provider supports file-native writeback. Before creating or",
  );
  lines.push(
    "updating a resource, read its schema and create example so you do not",
  );
  lines.push("guess the payload shape.");
  lines.push("");
  lines.push("## Writable resources");
  lines.push("");
  for (const resource of [...resources].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    lines.push(`### ${resource.name} — \`${resource.path}\``);
    lines.push("");
    lines.push(`- schema: \`${resource.schema}\``);
    lines.push(`- create example: \`${resource.createExample}\``);
    lines.push("");
  }
  lines.push("## Contract");
  lines.push("");
  lines.push(
    "- Read `<resource>/.schema.json` (JSON Schema draft 2020-12). Fields",
  );
  lines.push("  with `readOnly: true` are server-managed; never set them.");
  lines.push(
    "- Read `<resource>/.create.example.json` for a minimal valid create",
  );
  lines.push("  payload (read-only fields already omitted).");
  lines.push("- Schemas are inferred from synced records and refine on each");
  lines.push("  sync; treat unknown extra fields as allowed.");
  lines.push("");
  return lines.join("\n");
}

/**
 * The discovery root for a provider, e.g. `discovery/linear`. Derived from
 * the resource's advertised schema path so it always matches the LAYOUT.
 */
function discoveryRootFor(
  provider: string,
  resources: readonly AdapterResourceConfig[],
): string {
  for (const resource of resources) {
    const m = /^discovery\/[^/]+/.exec(resource.schema);
    if (m) return m[0];
  }
  return `discovery/${provider}`;
}

function readAuthoredDiscoveryFile(path: string): string | undefined {
  return AUTHORED_ADAPTER_DISCOVERY_ARTIFACTS[stripLeadingSlash(path)];
}

export interface DiscoveryEmitDeps {
  /** Idempotent managed write (no-ops when content is byte-identical). */
  writeManagedFile(input: {
    client: RelayfileWriteClient;
    workspaceId: string;
    path: string;
    content: string;
    contentType: string;
  }): Promise<void>;
  /**
   * Read the current text body of a managed file (or `undefined` if absent
   * /unreadable). Used to monotonically merge the prior on-disk
   * `.schema.json` so the materialized surface converges across the pages of
   * a multi-page sync instead of churning per page. Optional: when absent the
   * emitter falls back to batch-only inference (pre-merge behaviour).
   */
  readManagedFile?(input: {
    client: RelayfileWriteClient;
    workspaceId: string;
    path: string;
  }): Promise<string | undefined>;
}

/**
 * Parse an on-disk `.schema.json` body into a {@link JsonSchema}, or
 * `undefined` if it is missing / not valid JSON / not an object. Never throws
 * — a corrupt prior schema must not block the sync; we simply fall back to
 * this batch's inferred schema (which still converges on subsequent pages).
 */
function parsePriorSchema(body: string | undefined): JsonSchema | undefined {
  if (body === undefined) return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonSchema;
    }
  } catch {
    // Corrupt prior schema — ignore and let this batch's schema take over.
  }
  return undefined;
}

/**
 * Emit the full writeback discovery surface for a provider's synced records.
 * Generic across every nango provider — driven only by the adapter's
 * exported `resources[]` (the same array LAYOUT.md and the writeback router
 * derive from). Idempotent: safe to call on every sync; pre-existing
 * workspaces backfill on next sync.
 *
 * `recordsByResourceName` maps a resource `name` to the synced records for
 * it (the caller buckets per the adapter's model→resource mapping). A
 * resource with no records this sync still gets `.create.example.json` +
 * `.adapter.md`, and a best-effort empty-shape schema, so the advertised
 * contract is NEVER absent — schema fidelity then improves as that resource
 * type syncs.
 */
export async function writeDiscoveryArtifacts(
  deps: DiscoveryEmitDeps,
  client: RelayfileWriteClient,
  workspaceId: string,
  provider: string,
  resources: readonly AdapterResourceConfig[],
  recordsByResourceName: Map<string, readonly Record<string, unknown>[]>,
): Promise<{ written: number; errors: { path: string; error: string }[] }> {
  const errors: { path: string; error: string }[] = [];
  let written = 0;

  if (resources.length === 0) {
    return { written, errors };
  }

  for (const resource of resources) {
    const records = recordsByResourceName.get(resource.name) ?? [];

    const schemaPath = `/${stripLeadingSlash(resource.schema)}`;
    const examplePath = `/${stripLeadingSlash(resource.createExample)}`;
    const authoredSchema = readAuthoredDiscoveryFile(resource.schema);
    const authoredCreateExample = readAuthoredDiscoveryFile(
      resource.createExample,
    );

    let schemaContent: string;
    let createExampleContent: string;
    if (authoredSchema !== undefined) {
      schemaContent = authoredSchema;
    } else {
      const inferred = buildResourceSchema(provider, resource, records);

      // Monotonically merge the prior on-disk schema (if any) so the surface
      // CONVERGES instead of churning per pagination page. Without this, each
      // page of a multi-page sync infers from only that page's records, the
      // schema content differs page-to-page, and `writeManagedFile`'s
      // byte-identical dedup misses — rewriting the discovery file (and bumping
      // revision + writeback/event churn) on most pages of a large sync.
      let prior: JsonSchema | undefined;
      if (deps.readManagedFile) {
        try {
          prior = parsePriorSchema(
            await deps.readManagedFile({ client, workspaceId, path: schemaPath }),
          );
        } catch {
          prior = undefined; // Read failure must not block sync.
        }
      }
      const schema = canonicalizeSchema(
        prior ? mergeResourceSchemas(prior, inferred) : inferred,
      );
      schemaContent = `${JSON.stringify(schema, null, 2)}\n`;
    }

    if (authoredCreateExample !== undefined) {
      createExampleContent = authoredCreateExample;
    } else {
      const schema = parsePriorSchema(schemaContent) ?? {};
      createExampleContent = `${JSON.stringify(buildCreateExample(schema), null, 2)}\n`;
    }

    try {
      await deps.writeManagedFile({
        client,
        workspaceId,
        path: schemaPath,
        content: schemaContent,
        contentType: DISCOVERY_JSON_CONTENT_TYPE,
      });
      written += 1;
    } catch (error) {
      errors.push({ path: schemaPath, error: String(error) });
    }

    try {
      await deps.writeManagedFile({
        client,
        workspaceId,
        path: examplePath,
        content: createExampleContent,
        contentType: DISCOVERY_JSON_CONTENT_TYPE,
      });
      written += 1;
    } catch (error) {
      errors.push({ path: examplePath, error: String(error) });
    }
  }

  const adapterDocPath = `/${stripLeadingSlash(
    discoveryRootFor(provider, resources),
  )}/.adapter.md`;
  const authoredAdapterDoc = readAuthoredDiscoveryFile(
    `${discoveryRootFor(provider, resources)}/.adapter.md`,
  );
  try {
    await deps.writeManagedFile({
      client,
      workspaceId,
      path: adapterDocPath,
      content: authoredAdapterDoc ?? buildAdapterDoc(provider, resources),
      contentType: DISCOVERY_MD_CONTENT_TYPE,
    });
    written += 1;
  } catch (error) {
    errors.push({ path: adapterDocPath, error: String(error) });
  }

  return { written, errors };
}

function stripLeadingSlash(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

/**
 * Consistency invariant. Called from the SAME code path that writes
 * `<provider>/LAYOUT.md`. If the LAYOUT advertises a `discovery/...`
 * contract but the adapter exports no `resources` to materialize from (or
 * resources exist but the LAYOUT never mentions discovery), the
 * advertiser and producer have diverged — log loudly so this can't recur
 * silently. Returns `true` when consistent.
 */
export function assertLayoutDiscoveryConsistency(
  provider: string,
  layoutContent: string,
  resources: readonly AdapterResourceConfig[],
): boolean {
  const layoutAdvertisesDiscovery = /discovery\/[^\s`)]+\.schema\.json/.test(
    layoutContent,
  );
  const hasResources = resources.length > 0;

  if (layoutAdvertisesDiscovery && !hasResources) {
    console.error("[discovery] LAYOUT advertises discovery but no resources", {
      area: "nango-sync-worker",
      provider,
      detail:
        "Provider LAYOUT.md advertises a discovery/<provider>/.../.schema.json contract but the adapter exports no `resources` to materialize. Agents will be told to read schemas that are never written.",
    });
    return false;
  }

  if (hasResources && !layoutAdvertisesDiscovery) {
    // Not fatal (slack/gitlab ship resources without advertising in LAYOUT)
    // but the discovery files ARE still emitted so the writeback router's
    // schema load works. Surface it so LAYOUT can be brought in line.
    console.warn("[discovery] resources without LAYOUT advertising", {
      area: "nango-sync-worker",
      provider,
      detail:
        "Adapter exports writable `resources` (discovery files are materialized) but the provider LAYOUT.md does not advertise the discovery contract.",
    });
  }

  return true;
}
