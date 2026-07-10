import { APP_BASE_PATH } from "@/lib/app-path";

type JsonSchema = Record<string, unknown>;

export const PUBLIC_OPENAPI_PATH = "/openapi.json";
const DEFAULT_PUBLIC_SERVER = "https://agentrelay.com/cloud";

const timestampSchema = { type: "string", format: "date-time" } satisfies JsonSchema;

function makeErrorSchema(description = "Error response") {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            error: { type: "string" },
          },
          required: ["error"],
        },
      },
    },
  } satisfies JsonSchema;
}

function makeJson(schema: JsonSchema, description?: string) {
  return {
    ...(description ? { description } : {}),
    content: {
      "application/json": {
        schema,
      },
    },
  } satisfies JsonSchema;
}

export function getPublicServerUrl(origin?: string): string {
  if (!origin) {
    return DEFAULT_PUBLIC_SERVER;
  }

  return `${origin}${APP_BASE_PATH}`;
}

export function getPublicOpenApiDocument(origin?: string) {
  const serverUrl = getPublicServerUrl(origin);

  return {
    openapi: "3.1.0",
    info: {
      title: "Agent Relay Cloud API",
      version: "1.0.0",
      summary: "Public HTTP API for Agent Relay cloud workflows and CLI authentication.",
      description:
        "Machine-readable OpenAPI document for the Agent Relay cloud service, covering the routes currently exercised by the public relay CLI and workflow runtime.",
    },
    servers: [
      {
        url: serverUrl,
        description: origin ? "Current deployment" : "Production",
      },
    ],
    tags: [
      { name: "system", description: "Public system and health endpoints." },
      { name: "auth", description: "Browser login and API token lifecycle endpoints." },
      { name: "cli", description: "Interactive CLI/provider authentication endpoints." },
      { name: "credentials", description: "Credential write-back endpoints used by running sandboxes." },
      { name: "integrations", description: "Workspace integration configuration endpoints." },
      { name: "workflows", description: "Workflow preparation, execution, status, logs, and patch retrieval." },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "Bearer token",
          description: "API token returned by the CLI login flow.",
        },
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "agent_relay_session",
          description: "Browser session cookie set after interactive login.",
        },
        callbackTokenHeader: {
          type: "apiKey",
          in: "header",
          name: "x-callback-token",
          description: "Workflow callback token passed by the orchestrator sandbox.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          additionalProperties: true,
          properties: {
            error: { type: "string" },
          },
          required: ["error"],
        },
        HealthResponse: {
          type: "object",
          properties: {
            status: { type: "string", example: "ok" },
            timestamp: timestampSchema,
            version: { type: "string", example: "1.0.0" },
          },
          required: ["status", "timestamp", "version"],
        },
        TokenResponse: {
          type: "object",
          properties: {
            accessToken: { type: "string" },
            accessTokenExpiresAt: timestampSchema,
            refreshToken: { type: "string" },
            refreshTokenExpiresAt: timestampSchema,
            tokenType: { type: "string", example: "Bearer" },
          },
          required: ["accessToken", "accessTokenExpiresAt", "refreshToken", "refreshTokenExpiresAt", "tokenType"],
        },
        WhoAmIResponse: {
          type: "object",
          additionalProperties: true,
          properties: {
            authenticated: { type: "boolean" },
            source: { type: "string", enum: ["session", "token"] },
            subjectType: { type: ["string", "null"] },
            scopes: {
              type: "array",
              items: { type: "string" },
            },
            user: {
              type: "object",
              additionalProperties: true,
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
            currentOrganization: {
              type: ["object", "null"],
              additionalProperties: true,
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
            currentWorkspace: {
              type: ["object", "null"],
              additionalProperties: true,
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
            workspaceRequired: { type: "boolean" },
          },
          required: ["authenticated", "source", "scopes", "user", "currentOrganization", "currentWorkspace"],
        },
        CliAuthRequest: {
          type: "object",
          properties: {
            provider: { type: "string", example: "anthropic" },
            language: { type: "string", example: "typescript" },
          },
          required: ["provider"],
        },
        CliAuthResponse: {
          type: "object",
          additionalProperties: true,
          description: "Provider-specific auth bootstrap response returned by createAuthSandbox().",
        },
        CliAuthCompleteRequest: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            success: { type: "boolean" },
          },
          required: ["sessionId"],
        },
        DaytonaCredentialUploadRequest: {
          type: "object",
          properties: {
            accessToken: { type: "string" },
            refreshToken: { type: "string" },
            expiresAt: timestampSchema,
            orgId: { type: "string" },
          },
          required: ["accessToken", "refreshToken", "expiresAt"],
        },
        DaytonaCredentialUploadResponse: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            provider: { type: "string", enum: ["daytona"] },
            providerCredentialId: { type: "string" },
            id: { type: "string" },
            credentialExpiresAt: timestampSchema,
          },
          required: [
            "success",
            "provider",
            "providerCredentialId",
            "id",
            "credentialExpiresAt",
          ],
        },
        CredentialsRefreshRequest: {
          type: "object",
          properties: {
            provider: { type: "string", enum: ["openai", "anthropic", "xai", "daytona"] },
            credentials: {
              type: "object",
              additionalProperties: true,
            },
          },
          required: ["provider", "credentials"],
        },
        CredentialsRefreshResponse: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            provider: { type: "string" },
            refreshedAt: timestampSchema,
          },
          required: ["success", "provider", "refreshedAt"],
        },
        AllowedRepo: {
          type: "object",
          properties: {
            workspaceId: { type: "string", format: "uuid" },
            repoOwner: { type: "string", minLength: 1, maxLength: 100 },
            repoName: { type: "string", minLength: 1, maxLength: 100 },
            installationId: { type: "string" },
            pushAllowed: { type: "boolean" },
            allowedAt: timestampSchema,
            allowedBy: { type: "string", format: "uuid" },
          },
          required: [
            "workspaceId",
            "repoOwner",
            "repoName",
            "installationId",
            "pushAllowed",
            "allowedAt",
            "allowedBy",
          ],
        },
        AllowedRepoListResponse: {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: { $ref: "#/components/schemas/AllowedRepo" },
            },
          },
          required: ["rows"],
        },
        AllowedRepoUpsertRequest: {
          type: "object",
          properties: {
            repoOwner: { type: "string", minLength: 1, maxLength: 100 },
            repoName: { type: "string", minLength: 1, maxLength: 100 },
            pushAllowed: { type: "boolean", default: false },
          },
          required: ["repoOwner", "repoName"],
        },
        AllowedRepoPatchRequest: {
          type: "object",
          properties: {
            pushAllowed: { type: "boolean" },
          },
          required: ["pushAllowed"],
        },
        WaitlistRequest: {
          type: "object",
          properties: {
            email: { type: "string", format: "email", maxLength: 320 },
            source: { type: "string", maxLength: 128 },
          },
          required: ["email"],
        },
        WaitlistResponse: {
          type: "object",
          properties: {
            message: { type: "string", example: "Added to waitlist" },
            email: { type: "string", format: "email" },
          },
          required: ["message", "email"],
        },
        WorkflowPrepareResponse: {
          type: "object",
          properties: {
            runId: { type: "string" },
            s3CodeKey: { type: "string", example: "code.tar.gz" },
            s3Credentials: {
              type: "object",
              properties: {
                accessKeyId: { type: "string" },
                secretAccessKey: { type: "string" },
                sessionToken: { type: "string" },
                bucket: { type: "string" },
                prefix: { type: "string" },
                backend: { type: "string", enum: ["s3", "cloud-api"] },
                cloudApiUrl: { type: "string" },
                cloudApiAccessToken: { type: "string" },
              },
              required: ["accessKeyId", "secretAccessKey", "sessionToken", "bucket", "prefix"],
            },
            workflowStorage: {
              type: "object",
              properties: {
                backend: { type: "string", enum: ["s3", "cloud-api"] },
              },
            },
          },
          required: ["runId", "s3CodeKey", "s3Credentials"],
        },
        WorkflowRunRequest: {
          type: "object",
          properties: {
            workflow: { type: "string", description: "Raw YAML, JSON, or source-derived workflow payload." },
            fileType: { type: "string", enum: ["yaml", "ts", "py"] },
            sourceFileType: { type: "string", enum: ["yaml", "ts", "py", "workflow"] },
            runId: { type: "string" },
            s3CodeKey: { type: "string" },
            resume: { type: "string", description: "Resume a previously failed workflow run inside the cloud sandbox." },
            startFrom: { type: "string", description: "Start execution from this workflow step inside the cloud sandbox." },
            previousRunId: { type: "string", description: "Prior run id whose cached outputs satisfy skipped predecessor steps." },
          },
          required: ["workflow", "fileType"],
        },
        WorkflowRunResponse: {
          type: "object",
          additionalProperties: true,
          properties: {
            runId: { type: "string" },
            sandboxId: { type: ["string", "null"] },
            dispatchType: { type: "string", enum: ["sandbox", "worker"] },
            dispatchedTo: { type: "string" },
            assignmentId: { type: "string" },
            status: { type: "string" },
          },
          required: ["runId", "status"],
        },
        WorkflowRecord: {
          type: "object",
          additionalProperties: true,
          properties: {
            runId: { type: "string" },
            sandboxId: { type: ["string", "null"] },
            dispatchType: { type: "string", enum: ["sandbox", "worker"] },
            userId: { type: "string" },
            workspaceId: { type: "string" },
            workflow: { type: "string" },
            fileType: { type: "string", enum: ["yaml", "ts", "py"] },
            status: { type: "string" },
            createdAt: timestampSchema,
            updatedAt: timestampSchema,
            result: {},
            error: { type: "string" },
          },
          required: ["runId", "sandboxId", "dispatchType", "userId", "workspaceId", "workflow", "fileType", "status", "createdAt", "updatedAt"],
        },
        WorkflowRunListResponse: {
          type: "object",
          properties: {
            runs: {
              type: "array",
              items: { $ref: "#/components/schemas/WorkflowRecord" },
            },
          },
          required: ["runs"],
        },
        WorkflowLogsResponse: {
          type: "object",
          properties: {
            content: { type: "string" },
            offset: { type: "integer", minimum: 0 },
            totalSize: { type: "integer", minimum: 0 },
            done: { type: "boolean" },
          },
          required: ["content", "offset", "totalSize", "done"],
        },
        WorkflowPatchResponse: {
          type: "object",
          properties: {
            patch: { type: "string" },
            hasChanges: { type: "boolean" },
          },
          required: ["patch", "hasChanges"],
        },
        WorkflowCallbackRequest: {
          type: "object",
          properties: {
            runId: { type: "string" },
            callbackToken: { type: "string" },
            status: { type: "string" },
            result: {},
            error: { type: "string" },
          },
          required: ["runId", "status"],
        },
      },
    },
    paths: {
      "/api/health": {
        get: {
          tags: ["system"],
          operationId: "getHealth",
          summary: "Health check",
          description: "Public liveness endpoint.",
          responses: {
            "200": makeJson({ $ref: "#/components/schemas/HealthResponse" }),
          },
        },
      },
      "/api/v1/cli/login": {
        get: {
          tags: ["auth"],
          operationId: "startCliLogin",
          summary: "Start CLI login",
          description:
            "Starts the browser login flow. On success, the browser is redirected to the supplied localhost redirect URI with access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, and api_url query params. CLI operator refresh tokens are long-lived and are intended to be rotated silently through the token refresh endpoint.",
          parameters: [
            {
              name: "redirect_uri",
              in: "query",
              required: true,
              schema: { type: "string", format: "uri" },
              description: "Must point to localhost or 127.0.0.1.",
            },
            {
              name: "state",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Opaque caller-provided state echoed back to the localhost redirect.",
            },
          ],
          responses: {
            "302": { description: "Redirect to Google auth or to the localhost callback." },
            "400": makeErrorSchema("Invalid redirect URI."),
          },
        },
      },
      "/api/v1/auth/token/refresh": {
        post: {
          tags: ["auth"],
          operationId: "refreshApiToken",
          summary: "Refresh API token",
          description:
            "Rotates an API token refresh token and returns the next access and refresh token pair. CLI operator sessions preserve their long-lived refresh-token TTL across rotation.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    refreshToken: { type: "string" },
                  },
                  required: ["refreshToken"],
                },
              },
            },
          },
          responses: {
            "200": makeJson({ $ref: "#/components/schemas/TokenResponse" }),
            "400": makeErrorSchema("Missing refresh token."),
            "401": makeErrorSchema("Invalid or expired refresh token."),
          },
        },
      },
      "/api/v1/auth/token/revoke": {
        post: {
          tags: ["auth"],
          operationId: "revokeApiToken",
          summary: "Revoke API token session",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": makeJson({
              type: "object",
              properties: { revoked: { type: "boolean" } },
              required: ["revoked"],
            }),
            "400": makeErrorSchema("Missing token."),
            "404": makeErrorSchema("Token not found."),
          },
        },
      },
      "/api/v1/auth/whoami": {
        get: {
          tags: ["auth"],
          operationId: "getWhoAmI",
          summary: "Inspect current identity",
          security: [{ sessionCookie: [] }, { bearerAuth: [] }],
          responses: {
            "200": makeJson({ $ref: "#/components/schemas/WhoAmIResponse" }),
            "401": makeErrorSchema("Unauthorized."),
          },
        },
      },
      "/api/v1/cli/auth": {
        post: {
          tags: ["cli"],
          operationId: "createCliAuthSandbox",
          summary: "Create provider auth sandbox",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CliAuthRequest" },
              },
            },
          },
          responses: {
            "200": makeJson({ $ref: "#/components/schemas/CliAuthResponse" }),
            "400": makeErrorSchema("Invalid provider or JSON body."),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
            "500": makeErrorSchema("Failed to create auth sandbox."),
          },
        },
      },
      "/api/v1/cli/auth/complete": {
        post: {
          tags: ["cli"],
          operationId: "completeCliAuthSandbox",
          summary: "Complete provider auth sandbox",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CliAuthCompleteRequest" },
              },
            },
          },
          responses: {
            "200": makeJson({
              type: "object",
              additionalProperties: true,
              description: "Provider-specific completion result from completeAuthSession().",
            }),
            "400": makeErrorSchema("Invalid or missing sessionId."),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
            "404": makeErrorSchema("Session not found or expired."),
            "500": makeErrorSchema("Failed to complete auth session."),
          },
        },
      },
      "/api/v1/cli/auth/daytona/credential": {
        post: {
          tags: ["cli"],
          operationId: "uploadDaytonaCredential",
          summary: "Upload locally captured Daytona credentials",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DaytonaCredentialUploadRequest" },
              },
            },
          },
          responses: {
            "200": makeJson({ $ref: "#/components/schemas/DaytonaCredentialUploadResponse" }),
            "201": makeJson({ $ref: "#/components/schemas/DaytonaCredentialUploadResponse" }),
            "400": makeErrorSchema("Invalid Daytona credential body."),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
            "502": makeErrorSchema("Failed to store Daytona credential."),
          },
        },
      },
      "/api/v1/credentials/refresh": {
        post: {
          tags: ["credentials"],
          operationId: "refreshCredentials",
          summary: "Write back refreshed credentials",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CredentialsRefreshRequest" },
              },
            },
          },
          responses: {
            "200": makeJson({ $ref: "#/components/schemas/CredentialsRefreshResponse" }),
            "400": makeErrorSchema("Invalid provider, credentials, or JSON body."),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
            "500": makeErrorSchema("Failed to refresh credentials."),
          },
        },
      },
      "/api/waitlist": {
        post: {
          tags: ["system"],
          operationId: "createWaitlistEntry",
          summary: "Join the public waitlist",
          description: "Accepts a public waitlist signup and stores it in the cloud app database.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WaitlistRequest" },
              },
            },
          },
          responses: {
            "200": makeJson({ $ref: "#/components/schemas/WaitlistResponse" }),
            "400": makeErrorSchema("Invalid request body."),
          },
        },
      },
      "/api/v1/workspaces/{workspaceId}": {
        get: {
          tags: ["workspaces"],
          operationId: "getWorkspace",
          summary: "Get a relay workspace",
          security: [{ sessionCookie: [] }, { bearerAuth: [] }],
          parameters: [
            {
              name: "workspaceId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": makeJson({ type: "object" }),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
            "404": makeErrorSchema("Workspace not found."),
          },
        },
        delete: {
          tags: ["workspaces"],
          operationId: "deleteWorkspace",
          summary: "Hard-delete a relay workspace and all its server-side state",
          description:
            "Cascade-deletes the workspace: revokes every provider integration (Nango/Composio), tears down the relayfile Durable Object storage + R2 object bodies + D1 metadata, removes workspace-scoped DB rows, and finally the relay_workspaces registry row. Requires a confirmation body matching the workspace id. Only the workspace owner may delete it. Idempotent: an unknown or already-deleted workspace returns 404.",
          security: [{ sessionCookie: [] }, { bearerAuth: [] }],
          parameters: [
            {
              name: "workspaceId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    confirm: {
                      type: "string",
                      description:
                        "Must exactly equal the workspaceId being deleted.",
                    },
                  },
                  required: ["confirm"],
                },
              },
            },
          },
          responses: {
            "200": makeJson({
              type: "object",
              properties: {
                deleted: { type: "boolean" },
                summary: {
                  type: "object",
                  properties: {
                    workspaceId: { type: "string" },
                    integrationsRevoked: { type: "integer" },
                    integrationsFailed: { type: "integer" },
                    relayfileObjectsDeleted: { type: "integer" },
                    githubCloneJobsDeleted: { type: "integer" },
                    integrationDisconnectTombstonesDeleted: {
                      type: "integer",
                    },
                    relayWorkspaceRowDeleted: { type: "boolean" },
                    failures: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          phase: { type: "string" },
                          detail: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            }),
            "400": makeErrorSchema(
              "Invalid body or missing/mismatched confirmation.",
            ),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
            "404": makeErrorSchema("Workspace not found or already deleted."),
            "500": makeErrorSchema("Cascade teardown failed."),
          },
        },
      },
      "/api/v1/workspaces/{workspaceId}/join": {
        post: {
          tags: ["workspaces"],
          operationId: "joinWorkspace",
          summary: "Mint a scoped Relayfile workspace token",
          description:
            "Accepts either a Relayfile workspace id (rw_*) or a Cloud app workspace UUID. Authenticated workspaces require owner access or active organization membership. Returns the canonical Relayfile workspace id and a short-lived token for the requested scopes.",
          security: [{ sessionCookie: [] }, { bearerAuth: [] }],
          parameters: [
            {
              name: "workspaceId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    agentName: { type: "string" },
                    scopes: {
                      type: "array",
                      items: { type: "string" },
                    },
                    permissions: {
                      type: "object",
                      properties: {
                        ignored: {
                          type: "array",
                          items: { type: "string" },
                        },
                        readonly: {
                          type: "array",
                          items: { type: "string" },
                        },
                      },
                    },
                  },
                  required: ["agentName"],
                },
              },
            },
          },
          responses: {
            "200": makeJson({
              type: "object",
              properties: {
                workspaceId: { type: "string" },
                token: { type: "string" },
                tokenIssuedAt: timestampSchema,
                tokenExpiresAt: timestampSchema,
                suggestedRefreshAt: timestampSchema,
                relayfileUrl: { type: "string", format: "uri" },
                wsUrl: { type: "string" },
                relaycastApiKey: { type: "string" },
                relaycastBaseUrl: { type: "string", format: "uri" },
                scopes: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: [
                "workspaceId",
                "token",
                "tokenIssuedAt",
                "tokenExpiresAt",
                "suggestedRefreshAt",
                "relayfileUrl",
                "wsUrl",
                "scopes",
              ],
            }),
            "400": makeErrorSchema("Invalid request body."),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
            "404": makeErrorSchema("Workspace not found."),
            "500": makeErrorSchema("Failed to join workspace."),
          },
        },
      },
      "/api/v1/workspaces/{workspaceId}/integrations/github/allowed-repos": {
        get: {
          tags: ["integrations"],
          operationId: "listGitHubAllowedRepos",
          summary: "List GitHub workflow repository allowlist rows",
          security: [{ sessionCookie: [] }, { bearerAuth: [] }],
          parameters: [
            {
              name: "workspaceId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": makeJson({ $ref: "#/components/schemas/AllowedRepoListResponse" }),
            "400": makeErrorSchema("Invalid workspaceId."),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
          },
        },
        post: {
          tags: ["integrations"],
          operationId: "upsertGitHubAllowedRepo",
          summary: "Add or update a GitHub workflow repository allowlist row",
          security: [{ sessionCookie: [] }, { bearerAuth: [] }],
          parameters: [
            {
              name: "workspaceId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AllowedRepoUpsertRequest" },
              },
            },
          },
          responses: {
            "201": makeJson({ $ref: "#/components/schemas/AllowedRepo" }),
            "400": makeErrorSchema("Invalid workspaceId, repoOwner, repoName, or body."),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
            "409": makeErrorSchema("GitHub integration is not connected."),
          },
        },
      },
      "/api/v1/workspaces/{workspaceId}/integrations/github/allowed-repos/{owner}/{repo}": {
        get: {
          tags: ["integrations"],
          operationId: "getGitHubAllowedRepo",
          summary: "Get one GitHub workflow repository allowlist row",
          security: [{ sessionCookie: [] }, { bearerAuth: [] }],
          parameters: [
            {
              name: "workspaceId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "owner",
              in: "path",
              required: true,
              schema: { type: "string", minLength: 1, maxLength: 100 },
            },
            {
              name: "repo",
              in: "path",
              required: true,
              schema: { type: "string", minLength: 1, maxLength: 100 },
            },
          ],
          responses: {
            "200": makeJson({ $ref: "#/components/schemas/AllowedRepo" }),
            "400": makeErrorSchema("Invalid workspaceId, owner, or repo."),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
            "404": makeErrorSchema("Repository is not allowlisted."),
          },
        },
        patch: {
          tags: ["integrations"],
          operationId: "updateGitHubAllowedRepoPushAccess",
          summary: "Toggle push access for a GitHub workflow repository allowlist row",
          security: [{ sessionCookie: [] }, { bearerAuth: [] }],
          parameters: [
            {
              name: "workspaceId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "owner",
              in: "path",
              required: true,
              schema: { type: "string", minLength: 1, maxLength: 100 },
            },
            {
              name: "repo",
              in: "path",
              required: true,
              schema: { type: "string", minLength: 1, maxLength: 100 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AllowedRepoPatchRequest" },
              },
            },
          },
          responses: {
            "200": makeJson({ $ref: "#/components/schemas/AllowedRepo" }),
            "400": makeErrorSchema("Invalid workspaceId, owner, repo, or body."),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
            "404": makeErrorSchema("Repository is not allowlisted."),
          },
        },
        delete: {
          tags: ["integrations"],
          operationId: "deleteGitHubAllowedRepo",
          summary: "Remove one GitHub workflow repository allowlist row",
          security: [{ sessionCookie: [] }, { bearerAuth: [] }],
          parameters: [
            {
              name: "workspaceId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "owner",
              in: "path",
              required: true,
              schema: { type: "string", minLength: 1, maxLength: 100 },
            },
            {
              name: "repo",
              in: "path",
              required: true,
              schema: { type: "string", minLength: 1, maxLength: 100 },
            },
          ],
          responses: {
            "204": { description: "Repository removed from the allowlist." },
            "400": makeErrorSchema("Invalid workspaceId, owner, or repo."),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
            "404": makeErrorSchema("Repository is not allowlisted."),
          },
        },
      },
      "/api/v1/workflows/prepare": {
        post: {
          tags: ["workflows"],
          operationId: "prepareWorkflowRun",
          summary: "Prepare workflow run",
          security: [{ sessionCookie: [] }, { bearerAuth: [] }],
          responses: {
            "200": makeJson({ $ref: "#/components/schemas/WorkflowPrepareResponse" }),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
            "500": makeErrorSchema("Server misconfigured."),
          },
        },
      },
      "/api/v1/workflows/run": {
        post: {
          tags: ["workflows"],
          operationId: "runWorkflow",
          summary: "Start workflow run",
          security: [{ sessionCookie: [] }, { bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WorkflowRunRequest" },
              },
            },
          },
          responses: {
            "200": makeJson({ $ref: "#/components/schemas/WorkflowRunResponse" }),
            "400": makeErrorSchema("Invalid request body or YAML."),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
            "500": makeErrorSchema("Server misconfigured or sandbox launch failed."),
          },
        },
      },
      "/api/v1/workflows/callback": {
        post: {
          tags: ["workflows"],
          operationId: "submitWorkflowCallback",
          summary: "Submit workflow callback",
          description:
            "The callback token may be supplied either as `x-callback-token` or `callbackToken` in the JSON body. This endpoint is intended for orchestrator sandboxes, not end-user clients.",
          security: [{ callbackTokenHeader: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WorkflowCallbackRequest" },
              },
            },
          },
          responses: {
            "200": makeJson({
              type: "object",
              properties: {
                runId: { type: "string" },
                status: { type: "string" },
              },
              required: ["runId", "status"],
            }),
            "400": makeErrorSchema("Invalid callback body."),
            "401": makeErrorSchema("Invalid callback token."),
            "404": makeErrorSchema("Run not found."),
          },
        },
      },
      "/api/v1/workflows/runs": {
        get: {
          tags: ["workflows"],
          operationId: "listWorkflowRuns",
          summary: "List workflow runs",
          security: [{ sessionCookie: [] }],
          responses: {
            "200": makeJson({ $ref: "#/components/schemas/WorkflowRunListResponse" }),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
          },
        },
      },
      "/api/v1/workflows/runs/{runId}": {
        get: {
          tags: ["workflows"],
          operationId: "getWorkflowRun",
          summary: "Get workflow run",
          security: [{ sessionCookie: [] }, { bearerAuth: [] }],
          parameters: [
            {
              name: "runId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": makeJson({ $ref: "#/components/schemas/WorkflowRecord" }),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Missing required scope."),
            "404": makeErrorSchema("Run not found."),
          },
        },
      },
      "/api/v1/workflows/runs/{runId}/logs": {
        get: {
          tags: ["workflows"],
          operationId: "getWorkflowLogs",
          summary: "Read workflow logs",
          security: [{ sessionCookie: [] }, { bearerAuth: [] }],
          parameters: [
            {
              name: "runId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "offset",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 0 },
              description: "Byte offset for incremental log reads.",
            },
            {
              name: "sandboxId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "When provided, reads step-agent logs instead of orchestrator logs.",
            },
          ],
          responses: {
            "200": makeJson({ $ref: "#/components/schemas/WorkflowLogsResponse" }),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
            "404": makeErrorSchema("Run not found."),
            "500": makeErrorSchema("Failed to read logs."),
          },
        },
      },
      "/api/v1/workflows/runs/{runId}/patch": {
        get: {
          tags: ["workflows"],
          operationId: "getWorkflowPatch",
          summary: "Download workflow patch",
          security: [{ sessionCookie: [] }, { bearerAuth: [] }],
          parameters: [
            {
              name: "runId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": makeJson({ $ref: "#/components/schemas/WorkflowPatchResponse" }),
            "401": makeErrorSchema("Unauthorized."),
            "403": makeErrorSchema("Forbidden."),
            "404": makeErrorSchema("Run not found."),
            "409": makeErrorSchema("Run is still in progress."),
            "500": makeErrorSchema("Failed to read patch."),
          },
        },
      },
    },
  };
}
