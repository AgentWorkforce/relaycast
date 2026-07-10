import assert from "node:assert/strict";
import test from "node:test";
import type { AgentConfiguration, EndpointAuthMode, GrantType, TokenSigningAlgorithm } from "@relayauth/types";
import { createTestApp, createTestRequest } from "./test-helpers.js";

const DISCOVERY_PATH = "/.well-known/agent-configuration";

const VALID_GRANT_TYPES = new Set<GrantType>([
  "client_credentials",
  "refresh_token",
  "urn:ietf:params:oauth:grant-type:token-exchange",
  "urn:relayauth:params:oauth:grant-type:delegation",
]);

const VALID_AUTH_METHODS = new Set<EndpointAuthMode>([
  "none",
  "bearer_token",
  "client_secret_post",
  "private_key_jwt",
]);

const VALID_SIGNING_ALGORITHMS = new Set<TokenSigningAlgorithm>(["RS256", "EdDSA"]);

const VALID_ACTIONS = new Set([
  "read",
  "write",
  "create",
  "delete",
  "manage",
  "run",
  "send",
  "invoke",
  "*",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, fieldName: string): asserts value is string {
  assert.equal(typeof value, "string", `${fieldName} should be a string`);
}

function assertBoolean(value: unknown, fieldName: string): asserts value is boolean {
  assert.equal(typeof value, "boolean", `${fieldName} should be a boolean`);
}

function assertStringArray(value: unknown, fieldName: string): asserts value is string[] {
  assert.ok(Array.isArray(value), `${fieldName} should be an array`);

  for (const item of value) {
    assert.equal(typeof item, "string", `${fieldName} entries should be strings`);
  }
}

function assertUniqueArray(values: readonly unknown[], fieldName: string): void {
  assert.equal(new Set(values).size, values.length, `${fieldName} should contain unique values`);
}

function assertUrl(value: unknown, fieldName: string): asserts value is string {
  assertString(value, fieldName);
  assert.doesNotThrow(() => new URL(value), `${fieldName} should be a valid absolute URL`);
}

function assertPublishedScopeFormat(config: AgentConfiguration): void {
  assert.equal(config.scope_format.pattern, "{plane}:{resource}:{action}:{path?}");
  assert.equal(config.scope_format.separator, ":");
  assert.equal(config.scope_format.wildcard, "*");
  assertBoolean(config.scope_format.path_optional, "scope_format.path_optional");
  assertStringArray(config.scope_format.planes, "scope_format.planes");
  assert.ok(config.scope_format.planes.length > 0, "scope_format.planes should not be empty");
  assertStringArray(config.scope_format.actions, "scope_format.actions");
  assert.ok(config.scope_format.actions.length > 0, "scope_format.actions should not be empty");
  assertUniqueArray(config.scope_format.planes, "scope_format.planes");
  assertUniqueArray(config.scope_format.actions, "scope_format.actions");

  for (const action of config.scope_format.actions) {
    assert.ok(
      VALID_ACTIONS.has(action),
      `scope_format.actions contains unsupported action ${JSON.stringify(action)}`,
    );
  }

  assert.ok(Array.isArray(config.scope_definitions), "scope_definitions should be an array");
  assert.ok(config.scope_definitions.length > 0, "scope_definitions should not be empty");

  for (const definition of config.scope_definitions) {
    assertString(definition.name, "scope_definitions[].name");
    assertString(definition.plane, "scope_definitions[].plane");
    assertString(definition.resource, "scope_definitions[].resource");
    assertString(definition.pattern, "scope_definitions[].pattern");
    assertString(definition.description, "scope_definitions[].description");
    assertStringArray(definition.actions, "scope_definitions[].actions");
    assert.ok(definition.actions.length > 0, "scope_definitions[].actions should not be empty");
    assertStringArray(definition.examples, "scope_definitions[].examples");
    assert.ok(definition.examples.length > 0, "scope_definitions[].examples should not be empty");
    assert.equal(
      definition.pattern.includes("{action}"),
      false,
      "scope_definitions[].pattern should publish a concrete scope family pattern",
    );
    assert.match(
      definition.pattern,
      /^[a-z*][a-z0-9_-]*:[a-z*][a-z0-9_-]*:/i,
      "scope_definitions[].pattern should resemble the documented scope grammar",
    );

    assert.equal(typeof definition.path_schema, "object");
    assert.ok(definition.path_schema !== null, "scope_definitions[].path_schema should be present");
    assertBoolean(definition.path_schema.required, "scope_definitions[].path_schema.required");
    assertBoolean(
      definition.path_schema.wildcard_allowed,
      "scope_definitions[].path_schema.wildcard_allowed",
    );
    assertString(definition.path_schema.description, "scope_definitions[].path_schema.description");

    if (definition.path_schema.examples !== undefined) {
      assertStringArray(
        definition.path_schema.examples,
        "scope_definitions[].path_schema.examples",
      );
    }
  }
}

function assertAgentConfiguration(value: unknown): asserts value is AgentConfiguration {
  assert.ok(isRecord(value), "agent configuration response should be a JSON object");

  assertString(value.schema_version, "schema_version");
  assert.match(value.schema_version, /^[0-9]+\.[0-9]+$/, "schema_version should be MAJOR.MINOR");

  assertUrl(value.issuer, "issuer");
  assertUrl(value.jwks_uri, "jwks_uri");
  assertUrl(value.token_endpoint, "token_endpoint");
  assertUrl(value.identity_endpoint, "identity_endpoint");

  assertStringArray(value.grant_types_supported, "grant_types_supported");
  assert.ok(value.grant_types_supported.length > 0, "grant_types_supported should not be empty");
  assertUniqueArray(value.grant_types_supported, "grant_types_supported");
  for (const grantType of value.grant_types_supported) {
    assert.ok(
      VALID_GRANT_TYPES.has(grantType as GrantType),
      `grant_types_supported contains unsupported grant type ${JSON.stringify(grantType)}`,
    );
  }

  assertStringArray(
    value.token_endpoint_auth_methods_supported,
    "token_endpoint_auth_methods_supported",
  );
  assert.ok(
    value.token_endpoint_auth_methods_supported.length > 0,
    "token_endpoint_auth_methods_supported should not be empty",
  );
  assertUniqueArray(
    value.token_endpoint_auth_methods_supported,
    "token_endpoint_auth_methods_supported",
  );
  for (const authMethod of value.token_endpoint_auth_methods_supported) {
    assert.ok(
      VALID_AUTH_METHODS.has(authMethod as EndpointAuthMode),
      `token_endpoint_auth_methods_supported contains unsupported auth method ${JSON.stringify(authMethod)}`,
    );
  }

  assertStringArray(
    value.token_signing_alg_values_supported,
    "token_signing_alg_values_supported",
  );
  assert.ok(
    value.token_signing_alg_values_supported.length > 0,
    "token_signing_alg_values_supported should not be empty",
  );
  assertUniqueArray(
    value.token_signing_alg_values_supported,
    "token_signing_alg_values_supported",
  );
  for (const algorithm of value.token_signing_alg_values_supported) {
    assert.ok(
      VALID_SIGNING_ALGORITHMS.has(algorithm as TokenSigningAlgorithm),
      `token_signing_alg_values_supported contains unsupported algorithm ${JSON.stringify(algorithm)}`,
    );
  }

  assert.ok(isRecord(value.scope_format), "scope_format should be an object");
  assert.ok(Array.isArray(value.scope_definitions), "scope_definitions should be an array");
  assertBoolean(value.sponsor_required, "sponsor_required");

  assert.ok(isRecord(value.scope_delegation), "scope_delegation should be an object");
  assertBoolean(value.scope_delegation.enabled, "scope_delegation.enabled");
  assertString(value.scope_delegation.mode, "scope_delegation.mode");
  assert.match(
    value.scope_delegation.mode,
    /^(intersection|explicit_subset)$/,
    "scope_delegation.mode should be a supported value",
  );
  assertString(value.scope_delegation.escalation_policy, "scope_delegation.escalation_policy");
  assert.match(
    value.scope_delegation.escalation_policy,
    /^(hard_error|silent_deny|audit_only)$/,
    "scope_delegation.escalation_policy should be a supported value",
  );

  assert.ok(isRecord(value.budgets), "budgets should be an object");
  assertBoolean(value.budgets.enabled, "budgets.enabled");
  assertStringArray(value.budgets.supported_limits, "budgets.supported_limits");
  assertBoolean(
    value.budgets.alert_webhook_supported,
    "budgets.alert_webhook_supported",
  );
  assertBoolean(
    value.budgets.auto_suspend_supported,
    "budgets.auto_suspend_supported",
  );

  assert.ok(isRecord(value.token_lifetimes), "token_lifetimes should be an object");
  assertString(value.token_lifetimes.access_token_default, "token_lifetimes.access_token_default");
  assertString(value.token_lifetimes.refresh_token_default, "token_lifetimes.refresh_token_default");
  assertString(value.token_lifetimes.maximum, "token_lifetimes.maximum");
  assertBoolean(
    value.token_lifetimes.permanent_tokens_allowed,
    "token_lifetimes.permanent_tokens_allowed",
  );

  assert.ok(isRecord(value.endpoints), "endpoints should be an object");
  assert.ok(Object.keys(value.endpoints).length > 0, "endpoints should not be empty");

  for (const [name, endpoint] of Object.entries(value.endpoints)) {
    assert.ok(isRecord(endpoint), `endpoints.${name} should be an object`);
    assertUrl(endpoint.url, `endpoints.${name}.url`);
    assertStringArray(endpoint.methods, `endpoints.${name}.methods`);
    assert.ok(endpoint.methods.length > 0, `endpoints.${name}.methods should not be empty`);
    assertUniqueArray(endpoint.methods, `endpoints.${name}.methods`);
    assertString(endpoint.auth, `endpoints.${name}.auth`);
    assertString(endpoint.description, `endpoints.${name}.description`);

    if (endpoint.rate_limited !== undefined) {
      assertBoolean(endpoint.rate_limited, `endpoints.${name}.rate_limited`);
    }
  }
}

async function getAgentConfiguration(): Promise<Response> {
  const app = createTestApp();
  const request = createTestRequest("GET", DISCOVERY_PATH);
  return app.request(request, undefined, app.bindings);
}

async function getAgentConfigurationJson(): Promise<AgentConfiguration> {
  const response = await getAgentConfiguration();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
  const body = await response.json();
  assertAgentConfiguration(body);
  return body;
}

test("GET /.well-known/agent-configuration returns 200 with correct JSON", async () => {
  const body = await getAgentConfigurationJson();

  assert.equal(typeof body.schema_version, "string");
});

test("discovery response includes issuer, jwks_uri, token_endpoint, and identity_endpoint", async () => {
  const body = await getAgentConfigurationJson();

  assertUrl(body.issuer, "issuer");
  assertUrl(body.jwks_uri, "jwks_uri");
  assertUrl(body.token_endpoint, "token_endpoint");
  assertUrl(body.identity_endpoint, "identity_endpoint");
});

test("discovery response publishes supported scopes metadata with the documented format", async () => {
  const body = await getAgentConfigurationJson();
  assertPublishedScopeFormat(body);
});

test("discovery response includes supported grant types", async () => {
  const body = await getAgentConfigurationJson();

  assert.ok(body.grant_types_supported.length > 0);
  assert.ok(body.grant_types_supported.includes("client_credentials"));
});

test("discovery response sets Cache-Control to a public 1 hour TTL", async () => {
  const response = await getAgentConfiguration();

  const cacheControl = response.headers.get("cache-control") ?? "";
  assert.match(cacheControl, /\bpublic\b/i);
  assert.match(cacheControl, /\bmax-age=3600\b/i);
});

test("discovery response content type is application/json", async () => {
  const response = await getAgentConfiguration();

  assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
});

test("discovery response validates against the AgentConfiguration contract", async () => {
  const body = await getAgentConfigurationJson();

  const typedBody: AgentConfiguration = body;
  assert.equal(typeof typedBody.schema_version, "string");
});
