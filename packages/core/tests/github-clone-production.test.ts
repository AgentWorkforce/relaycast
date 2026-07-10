import assert from "node:assert/strict";
import { test } from "node:test";

import {
  __githubCloneProductionTestHooks,
  resolveRelayfileWorkspaceIdForClone,
} from "../src/clone/github-clone-production.js";
import {
  importGithubTarballByRelayfileFetch,
  startGithubTarballFetchImport,
} from "../src/clone/github-clone-tar-importer.js";

function dbReturningRelayWorkspaceId(relayWorkspaceId: string | null) {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                async limit() {
                  return relayWorkspaceId === null
                    ? []
                    : [{ relayWorkspaceId }];
                },
              };
            },
          };
        },
      };
    },
  };
}

function dbReturningGithubIntegrations(
  rows: Array<{
    connectionId: string;
    provider?: string | null;
    providerConfigKey?: string | null;
  }>,
) {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                orderBy() {
                  return {
                    async limit() {
                      return rows;
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

function dbForCloneIntegration(input: {
  integrationRows: Array<{
    connectionId: string;
    provider?: string | null;
    providerConfigKey?: string | null;
  }>;
  relayWorkspaceId?: string | null;
  updates?: Array<{ values: unknown; condition: unknown }>;
  updateReturningRows?: Array<{
    connectionId?: string;
    provider?: string | null;
    providerConfigKey?: string | null;
  }>;
  updateReturningError?: Error;
  afterUpdateIntegrationRows?: Array<{
    connectionId: string;
    provider?: string | null;
    providerConfigKey?: string | null;
  }>;
}) {
  let selectCount = 0;
  let updateCount = 0;
  return {
    select() {
      selectCount += 1;
      return {
        from() {
          return {
            where() {
              return {
                orderBy() {
                  return {
                    async limit() {
                      return updateCount > 0 && input.afterUpdateIntegrationRows
                        ? input.afterUpdateIntegrationRows
                        : input.integrationRows;
                    },
                  };
                },
                async limit() {
                  return input.relayWorkspaceId === undefined
                    ? input.integrationRows
                    : input.relayWorkspaceId === null
                      ? []
                      : [{ relayWorkspaceId: input.relayWorkspaceId }];
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: unknown) {
          return {
            where(condition: unknown) {
              input.updates?.push({ values, condition });
              updateCount += 1;
              return {
                async returning() {
                  if (input.updateReturningError) {
                    throw input.updateReturningError;
                  }
                  return (
                    input.updateReturningRows ?? [
                      {
                        connectionId: (values as { connectionId?: string })
                          .connectionId,
                        providerConfigKey: (
                          values as { providerConfigKey?: string }
                        ).providerConfigKey,
                      },
                    ]
                  );
                },
              };
            },
          };
        },
      };
    },
    get selectCount() {
      return selectCount;
    },
    get updateCount() {
      return updateCount;
    },
  };
}

function workspaceIntegrationConnectionUniqueError() {
  const error = new Error(
    'duplicate key value violates unique constraint "workspace_integrations_provider_connection_unique"',
  );
  Object.assign(error, { code: "23505" });
  return error;
}

function nangoMissingConnectionError() {
  const error = new Error("Failed to get connection");
  Object.assign(error, {
    response: {
      status: 400,
      data: {
        error: { code: "server_error", message: "Failed to get connection" },
      },
    },
  });
  return error;
}

function collectSqlParams(value: unknown): unknown[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const ownValue =
    Object.prototype.hasOwnProperty.call(record, "value") &&
    !Array.isArray(record.value)
      ? [record.value]
      : [];
  const chunks = Array.isArray(record.queryChunks) ? record.queryChunks : [];
  return [...ownValue, ...chunks.flatMap((chunk) => collectSqlParams(chunk))];
}

function nangoConnection(input: {
  connectionId: string;
  relayWorkspaceId: string;
  createdAt?: string;
  tags?: Record<string, string>;
}) {
  return {
    connection_id: input.connectionId,
    provider_config_key: "github-relay",
    created_at: input.createdAt ?? "2026-05-29T00:00:00Z",
    end_user: {
      id: input.relayWorkspaceId,
      tags: { workspaceId: input.relayWorkspaceId },
    },
    tags: {
      workspaceId: input.relayWorkspaceId,
      end_user_id: input.relayWorkspaceId,
      ...(input.tags ?? {}),
    },
  };
}

async function captureConsoleWarn<T>(
  callback: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const result = await callback();
    return { result, warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test("GitHub clone uses rw workspace ids directly for the RelayFile plane", async () => {
  const workspaceId = await resolveRelayfileWorkspaceIdForClone(
    { db: dbReturningRelayWorkspaceId("rw_shouldnotread") } as never,
    "rw_7ccfea89",
  );

  assert.equal(workspaceId, "rw_7ccfea89");
});

test("GitHub clone resolves app workspace ids to their bound rw workspace", async () => {
  const workspaceId = await resolveRelayfileWorkspaceIdForClone(
    { db: dbReturningRelayWorkspaceId("rw_7ccfea89") } as never,
    "50587328-441d-4acb-b8f3-dbe1b3c5de99",
  );

  assert.equal(workspaceId, "rw_7ccfea89");
});

test("GitHub clone fails loud when an app workspace has no RelayFile binding", async () => {
  await assert.rejects(
    () =>
      resolveRelayfileWorkspaceIdForClone(
        { db: dbReturningRelayWorkspaceId(null) } as never,
        "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      ),
    /RelayFile workspace binding not found/,
  );
});

test("GitHub clone uses the stored connection when it resolves without enumerating Nango", async () => {
  let listed = false;
  const calls: Array<{
    connectionId: string;
    providerConfigKey: string;
    endpoint: string;
  }> = [];
  const client = {
    async proxy(input: {
      connectionId: string;
      providerConfigKey: string;
      endpoint: string;
    }) {
      calls.push({
        connectionId: input.connectionId,
        providerConfigKey: input.providerConfigKey,
        endpoint: input.endpoint,
      });
      return { status: 200, headers: {}, data: { default_branch: "main" } };
    },
    async listConnections() {
      listed = true;
      return { connections: [] };
    },
  };

  const selected =
    await __githubCloneProductionTestHooks.resolveGithubCloneIntegration(
      {
        db: dbReturningGithubIntegrations([
          {
            connectionId: "conn-live",
            provider: "github",
            providerConfigKey: "github-relay",
          },
        ]),
      } as never,
      {
        workspaceId: "ws-1",
        owner: "AgentWorkforce",
        repo: "cloud",
        ref: "HEAD",
        connectionId: "conn-live",
      },
      client as never,
    );

  assert.deepEqual(selected, {
    connectionId: "conn-live",
    providerConfigKey: "github-relay",
    provider: "github",
  });
  assert.equal(listed, false);
  assert.deepEqual(calls, [
    {
      connectionId: "conn-live",
      providerConfigKey: "github-relay",
      endpoint: "/repos/AgentWorkforce/cloud",
    },
  ]);
});

test("GitHub clone heals a stale connection using the same relay-workspace Nango connection and persists it with CAS", async () => {
  const calls: Array<{ connectionId: string; endpoint: string }> = [];
  const updates: Array<{ values: unknown; condition: unknown }> = [];
  const client = {
    async proxy(input: { connectionId: string; endpoint: string }) {
      calls.push({
        connectionId: input.connectionId,
        endpoint: input.endpoint,
      });
      if (input.connectionId === "conn-stale") {
        throw nangoMissingConnectionError();
      }
      return { status: 200, headers: {}, data: { default_branch: "main" } };
    },
    async listConnections() {
      return {
        connections: [
          nangoConnection({
            connectionId: "conn-live",
            relayWorkspaceId: "rw_7ccfea89",
          }),
        ],
      };
    },
  };

  const { result: selected, warnings } = await captureConsoleWarn(() =>
    __githubCloneProductionTestHooks.resolveGithubCloneIntegration(
      {
        db: dbForCloneIntegration({
          integrationRows: [
            {
              connectionId: "conn-stale",
              provider: "github",
              providerConfigKey: "github-relay",
            },
          ],
          relayWorkspaceId: "rw_7ccfea89",
          updates,
        }),
      } as never,
      {
        workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        owner: "AgentWorkforce",
        repo: "cloud",
        ref: "HEAD",
        connectionId: "conn-stale",
      },
      client as never,
    ),
  );

  assert.deepEqual(selected, {
    connectionId: "conn-live",
    providerConfigKey: "github-relay",
    provider: "github",
  });
  assert.deepEqual(calls, [
    { connectionId: "conn-stale", endpoint: "/repos/AgentWorkforce/cloud" },
    { connectionId: "conn-live", endpoint: "/repos/AgentWorkforce/cloud" },
  ]);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]?.values, {
    connectionId: "conn-live",
    providerConfigKey: "github-relay",
    updatedAt:
      updates[0]?.values &&
      (updates[0].values as { updatedAt: Date }).updatedAt,
  });
  assert.ok(
    (updates[0]?.values as { updatedAt?: unknown }).updatedAt instanceof Date,
  );
  assert.deepEqual(collectSqlParams(updates[0]?.condition), [
    "50587328-441d-4acb-b8f3-dbe1b3c5de99",
    "github",
    "conn-stale",
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /github_clone_connection_auto_healed/);
});

test("GitHub clone re-reads after CAS update affects zero rows and does not log a durable heal", async () => {
  const calls: Array<{ connectionId: string; endpoint: string }> = [];
  const updates: Array<{ values: unknown; condition: unknown }> = [];
  const client = {
    async proxy(input: { connectionId: string; endpoint: string }) {
      calls.push({
        connectionId: input.connectionId,
        endpoint: input.endpoint,
      });
      if (input.connectionId === "conn-stale") {
        throw nangoMissingConnectionError();
      }
      return { status: 200, headers: {}, data: { default_branch: "main" } };
    },
    async listConnections() {
      return {
        connections: [
          nangoConnection({
            connectionId: "conn-live",
            relayWorkspaceId: "rw_7ccfea89",
          }),
        ],
      };
    },
  };

  const db = dbForCloneIntegration({
    integrationRows: [
      {
        connectionId: "conn-stale",
        provider: "github",
        providerConfigKey: "github-relay",
      },
    ],
    relayWorkspaceId: "rw_7ccfea89",
    updates,
    updateReturningRows: [],
    afterUpdateIntegrationRows: [
      {
        connectionId: "conn-live",
        provider: "github",
        providerConfigKey: "github-relay",
      },
    ],
  });

  const { result: selected, warnings } = await captureConsoleWarn(() =>
    __githubCloneProductionTestHooks.resolveGithubCloneIntegration(
      {
        db,
      } as never,
      {
        workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        owner: "AgentWorkforce",
        repo: "cloud",
        ref: "HEAD",
        connectionId: "conn-stale",
      },
      client as never,
    ),
  );

  assert.deepEqual(selected, {
    connectionId: "conn-live",
    providerConfigKey: "github-relay",
    provider: "github",
  });
  assert.equal(updates.length, 1);
  assert.equal(db.selectCount >= 3, true);
  assert.deepEqual(calls, [
    { connectionId: "conn-stale", endpoint: "/repos/AgentWorkforce/cloud" },
    { connectionId: "conn-live", endpoint: "/repos/AgentWorkforce/cloud" },
    { connectionId: "conn-live", endpoint: "/repos/AgentWorkforce/cloud" },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /github_clone_connection_auto_heal_raced/);
  assert.doesNotMatch(warnings[0] ?? "", /github_clone_connection_auto_healed/);
});

test("GitHub clone fails loud when a CAS race leaves a different-tenant current connection", async () => {
  const updates: Array<{ values: unknown; condition: unknown }> = [];
  const client = {
    async proxy(input: { connectionId: string }) {
      if (input.connectionId === "conn-stale") {
        throw nangoMissingConnectionError();
      }
      return { status: 200, headers: {}, data: { default_branch: "main" } };
    },
    async listConnections() {
      return {
        connections: [
          nangoConnection({
            connectionId: "conn-live",
            relayWorkspaceId: "rw_7ccfea89",
          }),
          nangoConnection({
            connectionId: "conn-other-tenant",
            relayWorkspaceId: "rw_julian",
          }),
        ],
      };
    },
  };

  const db = dbForCloneIntegration({
    integrationRows: [
      {
        connectionId: "conn-stale",
        provider: "github",
        providerConfigKey: "github-relay",
      },
    ],
    relayWorkspaceId: "rw_7ccfea89",
    updates,
    updateReturningRows: [],
    afterUpdateIntegrationRows: [
      {
        connectionId: "conn-other-tenant",
        provider: "github",
        providerConfigKey: "github-relay",
      },
    ],
  });

  const { warnings } = await captureConsoleWarn(async () => {
    await assert.rejects(
      () =>
        __githubCloneProductionTestHooks.resolveGithubCloneIntegration(
          {
            db,
          } as never,
          {
            workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
            owner: "AgentWorkforce",
            repo: "cloud",
            ref: "HEAD",
            connectionId: "conn-stale",
          },
          client as never,
        ),
      /not proven to belong to relay workspace/,
    );
  });

  assert.equal(updates.length, 1);
  assert.deepEqual(warnings, []);
});

test("GitHub clone proceeds transiently with the validated healed connection after a persist unique collision", async () => {
  const calls: Array<{ connectionId: string; endpoint: string }> = [];
  const updates: Array<{ values: unknown; condition: unknown }> = [];
  const client = {
    async proxy(input: { connectionId: string; endpoint: string }) {
      calls.push({
        connectionId: input.connectionId,
        endpoint: input.endpoint,
      });
      if (input.connectionId === "conn-stale") {
        throw nangoMissingConnectionError();
      }
      return { status: 200, headers: {}, data: { default_branch: "main" } };
    },
    async listConnections() {
      return {
        connections: [
          nangoConnection({
            connectionId: "conn-live",
            relayWorkspaceId: "rw_7ccfea89",
          }),
        ],
      };
    },
  };

  const db = dbForCloneIntegration({
    integrationRows: [
      {
        connectionId: "conn-stale",
        provider: "github",
        providerConfigKey: "github-relay",
      },
    ],
    relayWorkspaceId: "rw_7ccfea89",
    updates,
    updateReturningError: workspaceIntegrationConnectionUniqueError(),
  });

  const { result: selected, warnings } = await captureConsoleWarn(() =>
    __githubCloneProductionTestHooks.resolveGithubCloneIntegration(
      {
        db,
      } as never,
      {
        workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        owner: "AgentWorkforce",
        repo: "cloud",
        ref: "HEAD",
        connectionId: "conn-stale",
      },
      client as never,
    ),
  );

  assert.deepEqual(selected, {
    connectionId: "conn-live",
    providerConfigKey: "github-relay",
    provider: "github",
  });
  assert.equal(updates.length, 1);
  assert.deepEqual(calls, [
    { connectionId: "conn-stale", endpoint: "/repos/AgentWorkforce/cloud" },
    { connectionId: "conn-live", endpoint: "/repos/AgentWorkforce/cloud" },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0] ?? "",
    /github_clone_connection_auto_heal_reconciled/,
  );
  assert.match(
    warnings[0] ?? "",
    /workspace_integrations_provider_connection_unique/,
  );
  assert.doesNotMatch(warnings[0] ?? "", /github_clone_connection_auto_healed/);
});

test("GitHub clone fails loud when persisting a healed connection fails for a non-collision error", async () => {
  const updates: Array<{ values: unknown; condition: unknown }> = [];
  const client = {
    async proxy(input: { connectionId: string }) {
      if (input.connectionId === "conn-stale") {
        throw nangoMissingConnectionError();
      }
      return { status: 200, headers: {}, data: { default_branch: "main" } };
    },
    async listConnections() {
      return {
        connections: [
          nangoConnection({
            connectionId: "conn-live",
            relayWorkspaceId: "rw_7ccfea89",
          }),
        ],
      };
    },
  };

  const db = dbForCloneIntegration({
    integrationRows: [
      {
        connectionId: "conn-stale",
        provider: "github",
        providerConfigKey: "github-relay",
      },
    ],
    relayWorkspaceId: "rw_7ccfea89",
    updates,
    updateReturningError: new Error("database unavailable"),
  });

  const { warnings } = await captureConsoleWarn(async () => {
    await assert.rejects(
      () =>
        __githubCloneProductionTestHooks.resolveGithubCloneIntegration(
          {
            db,
          } as never,
          {
            workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
            owner: "AgentWorkforce",
            repo: "cloud",
            ref: "HEAD",
            connectionId: "conn-stale",
          },
          client as never,
        ),
      /database unavailable/,
    );
  });

  assert.equal(updates.length, 1);
  assert.deepEqual(warnings, []);
});

test("GitHub clone refuses to heal with a different tenant's live connection", async () => {
  const client = {
    async proxy(input: { connectionId: string }) {
      if (input.connectionId === "conn-stale") {
        throw nangoMissingConnectionError();
      }
      return { status: 200, headers: {}, data: { default_branch: "main" } };
    },
    async listConnections() {
      return {
        connections: [
          nangoConnection({
            connectionId: "conn-other-tenant",
            relayWorkspaceId: "rw_julian",
          }),
        ],
      };
    },
  };

  await assert.rejects(
    () =>
      __githubCloneProductionTestHooks.resolveGithubCloneIntegration(
        {
          db: dbForCloneIntegration({
            integrationRows: [
              {
                connectionId: "conn-stale",
                provider: "github",
                providerConfigKey: "github-relay",
              },
            ],
            relayWorkspaceId: "rw_7ccfea89",
          }),
        } as never,
        {
          workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
          owner: "AgentWorkforce",
          repo: "cloud",
          ref: "HEAD",
          connectionId: "conn-stale",
        },
        client as never,
      ),
    /No same-tenant GitHub connection/,
  );
});

test("GitHub clone does not fallback when the stored live connection cannot access the repo", async () => {
  for (const status of [403, 404]) {
    const client = {
      async proxy() {
        const label = status === 403 ? "Forbidden" : "Not Found";
        const error = new Error(
          `Nango proxy /repos/AgentWorkforce/cloud failed: ${label}`,
        );
        Object.assign(error, { status, data: { message: label } });
        throw error;
      },
      async listConnections() {
        throw new Error(
          `listConnections should not be called for repo ${status}`,
        );
      },
    };

    await assert.rejects(
      () =>
        __githubCloneProductionTestHooks.resolveGithubCloneIntegration(
          {
            db: dbReturningGithubIntegrations([
              {
                connectionId: "conn-live-no-repo",
                provider: "github",
                providerConfigKey: "github-relay",
              },
            ]),
          } as never,
          {
            workspaceId: "ws-1",
            owner: "AgentWorkforce",
            repo: "cloud",
            ref: "HEAD",
            connectionId: "conn-live-no-repo",
          },
          client as never,
        ),
      status === 403 ? /Forbidden/ : /Not Found/,
    );
  }
});

test("GitHub clone picks the newest repo-capable same-tenant connection when timestamps disambiguate", async () => {
  const client = {
    async proxy(input: { connectionId: string }) {
      if (input.connectionId === "conn-stale") {
        throw nangoMissingConnectionError();
      }
      return { status: 200, headers: {}, data: { default_branch: "main" } };
    },
    async listConnections() {
      return {
        connections: [
          nangoConnection({
            connectionId: "conn-old",
            relayWorkspaceId: "rw_7ccfea89",
            createdAt: "2026-05-28T00:00:00Z",
          }),
          nangoConnection({
            connectionId: "conn-new",
            relayWorkspaceId: "rw_7ccfea89",
            createdAt: "2026-05-29T00:00:00Z",
          }),
        ],
      };
    },
  };

  const selected =
    await __githubCloneProductionTestHooks.resolveGithubCloneIntegration(
      {
        db: dbForCloneIntegration({
          integrationRows: [
            {
              connectionId: "conn-stale",
              provider: "github",
              providerConfigKey: "github-relay",
            },
          ],
          relayWorkspaceId: "rw_7ccfea89",
        }),
      } as never,
      {
        workspaceId: "ws-1",
        owner: "AgentWorkforce",
        repo: "cloud",
        ref: "HEAD",
        connectionId: "conn-stale",
      },
      client as never,
    );

  assert.equal(selected.connectionId, "conn-new");
});

test("GitHub clone fails loud when same-tenant repo-capable connections are ambiguous", async () => {
  const client = {
    async proxy(input: { connectionId: string }) {
      if (input.connectionId === "conn-stale") {
        throw nangoMissingConnectionError();
      }
      return { status: 200, headers: {}, data: { default_branch: "main" } };
    },
    async listConnections() {
      return {
        connections: [
          nangoConnection({
            connectionId: "conn-a",
            relayWorkspaceId: "rw_7ccfea89",
          }),
          nangoConnection({
            connectionId: "conn-b",
            relayWorkspaceId: "rw_7ccfea89",
          }),
        ],
      };
    },
  };

  await assert.rejects(
    () =>
      __githubCloneProductionTestHooks.resolveGithubCloneIntegration(
        {
          db: dbForCloneIntegration({
            integrationRows: [
              {
                connectionId: "conn-stale",
                provider: "github",
                providerConfigKey: "github-relay",
              },
            ],
            relayWorkspaceId: "rw_7ccfea89",
          }),
        } as never,
        {
          workspaceId: "ws-1",
          owner: "AgentWorkforce",
          repo: "cloud",
          ref: "HEAD",
          connectionId: "conn-stale",
        },
        client as never,
      ),
    /Multiple same-tenant GitHub connections/,
  );
});

test("GitHub clone fails loud when no same-tenant connection can access the repo", async () => {
  const client = {
    async proxy(input: { connectionId: string }) {
      if (input.connectionId === "conn-stale") {
        throw nangoMissingConnectionError();
      }
      const error = new Error(
        "Nango proxy /repos/AgentWorkforce/cloud failed: Not Found",
      );
      Object.assign(error, { status: 404, data: { message: "Not Found" } });
      throw error;
    },
    async listConnections() {
      return {
        connections: [
          nangoConnection({
            connectionId: "conn-no-repo",
            relayWorkspaceId: "rw_7ccfea89",
          }),
        ],
      };
    },
  };

  await assert.rejects(
    () =>
      __githubCloneProductionTestHooks.resolveGithubCloneIntegration(
        {
          db: dbForCloneIntegration({
            integrationRows: [
              {
                connectionId: "conn-stale",
                provider: "github",
                providerConfigKey: "github-relay",
              },
            ],
            relayWorkspaceId: "rw_7ccfea89",
          }),
        } as never,
        {
          workspaceId: "ws-1",
          owner: "AgentWorkforce",
          repo: "cloud",
          ref: "HEAD",
          connectionId: "conn-stale",
        },
        client as never,
      ),
    /No same-tenant GitHub connection/,
  );
});

test("GitHub tar fetch import resolves HEAD through the default branch and uses a SHA tarball URL", async () => {
  const calls: Array<{ endpoint?: string; token?: string }> = [];
  const client = {
    async getToken() {
      calls.push({ token: "requested" });
      return "github-token";
    },
    async proxy(input: { endpoint: string }) {
      calls.push({ endpoint: input.endpoint });
      if (input.endpoint === "/repos/AgentWorkforce/cloud") {
        return { status: 200, headers: {}, data: { default_branch: "main" } };
      }
      if (input.endpoint === "/repos/AgentWorkforce/cloud/commits/main") {
        return { status: 200, headers: {}, data: { sha: "abc123" } };
      }
      throw new Error(`unexpected endpoint ${input.endpoint}`);
    },
  };

  const resolved =
    await __githubCloneProductionTestHooks.resolveGithubTarballFetchImportInput(
      {
        client: client as never,
        connectionId: "conn-live",
        providerConfigKey: "github-relay",
        owner: "AgentWorkforce",
        repo: "cloud",
        ref: "HEAD",
      },
    );

  assert.deepEqual(resolved, {
    githubToken: "github-token",
    tarballUrl:
      "https://api.github.com/repos/AgentWorkforce/cloud/tarball/abc123",
    headSha: "abc123",
    defaultBranch: "main",
  });
  assert.deepEqual(calls, [
    { token: "requested" },
    { endpoint: "/repos/AgentWorkforce/cloud" },
    { endpoint: "/repos/AgentWorkforce/cloud/commits/main" },
  ]);
});

test("GitHub tar fetch import can start background cache fill without polling", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = async (
    url: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url: String(url), init });
    return Response.json(
      { jobId: "job-active", status: "importing" },
      { status: 202 },
    );
  };

  const job = await startGithubTarballFetchImport({
    relayfileUrl: "https://relayfile.example",
    workspaceId: "rw_test",
    owner: "octo",
    repo: "demo",
    ref: "main",
    headSha: "abc123",
    jobId: "job-background",
    tarballUrl: "https://api.github.com/repos/octo/demo/tarball/main",
    githubToken: "github-token",
    token: async () => "relayfile-token",
    fetchImpl,
  });

  assert.equal(job.jobId, "job-active");
  assert.equal(job.status, "importing");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    "https://relayfile.example/v1/workspaces/rw_test/fs/import/github-tarball/fetch",
  );
  assert.equal(calls[0]?.init?.method, "POST");
});

test("GitHub tar fetch import polls the admitted job returned by RelayFile", async () => {
  const polledUrls: string[] = [];
  const fetchImpl = async (
    url: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    const requestUrl = String(url);
    if (init?.method === "POST") {
      return Response.json(
        { jobId: "job-existing-active", status: "importing" },
        { status: 202 },
      );
    }
    polledUrls.push(requestUrl);
    return Response.json({
      jobId: "job-existing-active",
      status: "completed",
      imported: 2,
      errorCount: 0,
      errors: [],
      skipped: [],
      bytesWritten: 12,
    });
  };

  const result = await importGithubTarballByRelayfileFetch({
    relayfileUrl: "https://relayfile.example",
    workspaceId: "rw_test",
    owner: "octo",
    repo: "demo",
    ref: "main",
    headSha: "abc123",
    jobId: "job-requested",
    tarballUrl: "https://api.github.com/repos/octo/demo/tarball/main",
    githubToken: "github-token",
    token: async () => "relayfile-token",
    fetchImpl,
    pollIntervalMs: 1,
    timeoutMs: 100,
  });

  assert.equal(result.imported, 2);
  assert.equal(result.bytesWritten, 12);
  assert.deepEqual(polledUrls, [
    "https://relayfile.example/v1/workspaces/rw_test/fs/import/github-tarball/jobs/job-existing-active",
  ]);
});
