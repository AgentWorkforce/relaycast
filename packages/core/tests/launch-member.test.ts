import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { CredentialBundle } from "../src/auth/credentials.js";
import { launchMember, scopesFromRelayfileAccessToken } from "../src/bootstrap/launch-member.js";
import {
  SANDBOX_FALLBACK_DEPENDENCY_SPECS,
  collectWorkflowAgentConfigs,
  isDaytonaThrottleError,
  launchOrchestratorSandbox,
  prepareLauncherRelayfileAccess,
} from "../src/bootstrap/launcher.js";
import { pathScope, readPathScope } from "../src/proactive-runtime/member-token-scope.js";

function relayPaToken(scopes: string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ scopes })).toString("base64url");
  return `relay_pa_${header}.${payload}.sig`;
}

function credentialBundle(): CredentialBundle {
  return {
    s3Credentials: {
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      sessionToken: "session-token",
      bucket: "bucket",
      prefix: "runs/run-1",
    },
    cliCredentials: "{}",
    workspaceId: "workspace-1",
    relayApiKey: "relay-key",
    relayBaseUrl: "https://relaycast.example",
    runId: "run-1",
    userId: "user-1",
    daytonaApiKey: "daytona-token",
  };
}

test("launcher fallback dependency install uses reviewed package specs", () => {
  const corePkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const deps = corePkg.dependencies ?? {};

  assert.deepEqual([...SANDBOX_FALLBACK_DEPENDENCY_SPECS], [
    `@aws-sdk/client-s3@${deps["@aws-sdk/client-s3"]}`,
    `@aws-sdk/client-sts@${deps["@aws-sdk/client-sts"]}`,
    `@aws-sdk/lib-storage@${deps["@aws-sdk/lib-storage"]}`,
    `@smithy/smithy-client@${deps["@smithy/smithy-client"]}`,
    `@agent-relay/sdk@${deps["@agent-relay/sdk"]}`,
    `@agent-relay/config@${deps["@agent-relay/config"]}`,
    `@agent-relay/credential-proxy@${deps["@agent-relay/credential-proxy"]}`,
    `@relayflows/core@${deps["@relayflows/core"]}`,
    `tar@${deps.tar}`,
    `ignore@${deps.ignore}`,
    `@daytonaio/sdk@${deps["@daytonaio/sdk"]}`,
    `drizzle-orm@${deps["drizzle-orm"]}`,
    `pg@${deps.pg}`,
    `postgres@${deps.postgres}`,
  ]);

  for (const spec of SANDBOX_FALLBACK_DEPENDENCY_SPECS) {
    assert.match(spec, /@[^@\s]+$|^[^@\s]+@[^@\s]+$/, `${spec} must include an explicit npm range`);
  }
});

test("aws-sdk + smithy fallback specs are pinned exact (no caret) so the lockfile-less box install can't float the smithy tree", () => {
  // The box runs `npm install <specs>` with no lockfile; a `^` range re-floats
  // @smithy/smithy-client past 4.12.13 and breaks Node v25 with
  // "emitWarningIfUnsupportedVersion is not a function". Keep these exact.
  const mustBeExact = [
    "@aws-sdk/client-s3",
    "@aws-sdk/client-sts",
    "@aws-sdk/lib-storage",
    "@smithy/smithy-client",
  ];
  for (const name of mustBeExact) {
    const spec = SANDBOX_FALLBACK_DEPENDENCY_SPECS.find((s) =>
      s.startsWith(`${name}@`),
    );
    assert.ok(spec, `${name} must be present in fallback specs`);
    const range = spec.slice(name.length + 1);
    assert.match(
      range,
      /^\d+\.\d+\.\d+$/,
      `${name} must be pinned to an exact version, got "${range}"`,
    );
  }
});

test("isDaytonaThrottleError recognizes throttle/429 responses and ignores others", () => {
  assert.equal(
    isDaytonaThrottleError(new Error("ThrottlerException: Too Many Requests")),
    true,
  );
  assert.equal(isDaytonaThrottleError({ status: 429 }), true);
  assert.equal(isDaytonaThrottleError({ response: { status: 429 } }), true);
  assert.equal(isDaytonaThrottleError(new Error("rate limit exceeded")), true);
  // axios-style / plain-object error shapes (no `.message`) must still match.
  assert.equal(isDaytonaThrottleError({ error: "Too Many Requests" }), true);
  assert.equal(
    isDaytonaThrottleError({ response: { data: { message: "rate limit exceeded" } } }),
    true,
  );
  assert.equal(
    isDaytonaThrottleError({ response: { data: { error: "ThrottlerException" } } }),
    true,
  );
  assert.equal(isDaytonaThrottleError("Too Many Requests"), true);
  assert.equal(isDaytonaThrottleError(new Error("Snapshot not found")), false);
  assert.equal(isDaytonaThrottleError({ status: 500 }), false);
  assert.equal(isDaytonaThrottleError({ response: { data: { message: "boom" } } }), false);
  assert.equal(isDaytonaThrottleError(undefined), false);
});

test("scopesFromRelayfileAccessToken decodes relay_pa_ JWT scopes", () => {
  const scopes = ["relayfile:fs:read:/*", pathScope("/Packages/Web")];

  assert.deepEqual(scopesFromRelayfileAccessToken(relayPaToken(scopes)), scopes);
  assert.throws(
    () => scopesFromRelayfileAccessToken(relayPaToken(scopes).replace("relay_pa_", "relay_ws_")),
    /relay_pa_/,
  );
  assert.throws(
    () => scopesFromRelayfileAccessToken("relay_pa_header.not-json.sig"),
    /payload is invalid/,
  );
});

test("prepareLauncherRelayfileAccess member mode skips broad mints and ACL seed", async () => {
  const writeScope = pathScope("/packages/web");
  const calls = {
    broadMints: 0,
    pathMints: 0,
    seeds: 0,
  };

  const access = await prepareLauncherRelayfileAccess(
    {
      relayfileUrl: "https://relayfile.example",
      relayAuthUrl: "https://relayauth.example",
      relayWorkspaceId: "workspace-1",
      relayAuthApiKey: "",
      memberAccess: {
        agentName: "member-a",
        token: "relay_pa_member",
        scopes: [writeScope],
      },
      agents: [
        {
          name: "member-a",
          scopes: [writeScope],
        },
      ],
    },
    {
      mintRelayfileToken: async () => {
        calls.broadMints += 1;
        return "relay_ws_broad";
      },
      provisionAgentAccess: async () => {
        calls.pathMints += 1;
        return new Map([["member-a", { token: "relay_pa_path", scopes: [writeScope] }]]);
      },
      seedAgentPermissions: async () => {
        calls.seeds += 1;
      },
    },
  );

  assert.equal(calls.broadMints, 0);
  assert.equal(calls.pathMints, 0);
  assert.equal(calls.seeds, 0);
  assert.equal(access.envToken, "relay_pa_member");
  assert.equal(access.relayfileWorkspaceToken, "");
  assert.deepEqual(access.relayfileAgentAccess.get("member-a"), {
    token: "relay_pa_member",
    scopes: [writeScope],
  });
});

test("prepareLauncherRelayfileAccess member mode rejects broad tokens and broad member scopes", async () => {
  await assert.rejects(
    () =>
      prepareLauncherRelayfileAccess({
        relayfileUrl: "https://relayfile.example",
        relayAuthUrl: "https://relayauth.example",
        relayWorkspaceId: "workspace-1",
        relayAuthApiKey: "",
        memberAccess: {
          agentName: "member-a",
          token: "relay_ws_workspace",
          scopes: [pathScope("/packages/web")],
        },
        agents: [],
      }),
    /path-scoped relay_pa_/,
  );

  await assert.rejects(
    () =>
      prepareLauncherRelayfileAccess({
        relayfileUrl: "https://relayfile.example",
        relayAuthUrl: "https://relayauth.example",
        relayWorkspaceId: "workspace-1",
        relayAuthApiKey: "",
        memberAccess: {
          agentName: "member-a",
          token: "relay_pa_member",
          scopes: ["fs:write", "admin:acl", "relayfile:fs:write:/*"],
        },
        agents: [],
      }),
    /too broad for member mode/,
  );

  await assert.rejects(
    () =>
      prepareLauncherRelayfileAccess({
        relayfileUrl: "https://relayfile.example",
        relayAuthUrl: "https://relayauth.example",
        relayWorkspaceId: "workspace-1",
        relayAuthApiKey: "",
        memberAccess: {
          agentName: "member-a",
          token: "relay_pa_member",
          scopes: ["relayfile:fs:write:/packages/../secrets/*"],
        },
        agents: [],
      }),
    /path traversal/,
  );

  await assert.rejects(
    () =>
      prepareLauncherRelayfileAccess({
        relayfileUrl: "https://relayfile.example",
        relayAuthUrl: "https://relayauth.example",
        relayWorkspaceId: "workspace-1",
        relayAuthApiKey: "",
        memberAccess: {
          agentName: "member-a",
          token: "relay_pa_member",
          scopes: ["relayfile:fs:read:/packages/web/*"],
        },
        agents: [],
      }),
    /narrow relayfile write scope/,
  );

  await assert.rejects(
    () =>
      prepareLauncherRelayfileAccess({
        relayfileUrl: "https://relayfile.example",
        relayAuthUrl: "https://relayauth.example",
        relayWorkspaceId: "workspace-1",
        relayAuthApiKey: "",
        memberAccess: {
          agentName: "member-a",
          token: "relay_pa_member",
          scopes: [pathScope("/packages/web"), "relayfile:fs:read:/*"],
        },
        agents: [],
      }),
    /too broad for member mode|member read scope/,
  );
});

test("prepareLauncherRelayfileAccess normal mode keeps broad workspace mint and provisioning path", async () => {
  const calls = {
    broadMintScopes: [] as string[][],
    provisionAgents: [] as string[],
    seedTokens: [] as string[],
  };

  const access = await prepareLauncherRelayfileAccess(
    {
      relayfileUrl: "https://relayfile.example",
      relayAuthUrl: "https://relayauth.example",
      relayWorkspaceId: "workspace-1",
      relayAuthApiKey: "relay-auth-key",
      workspaceToken: "relay_ws_workspace",
      agents: [
        {
          name: "member-a",
          scopes: [pathScope("/packages/web")],
        },
      ],
    },
    {
      mintRelayfileToken: async (input) => {
        calls.broadMintScopes.push(input.scopes ?? []);
        return "relay_ws_broad";
      },
      provisionAgentAccess: async (input) => {
        calls.provisionAgents.push(...input.agents.map((agent) => agent.name));
        return new Map([["member-a", { token: "relay_pa_path", scopes: [pathScope("/packages/web")] }]]);
      },
      seedAgentPermissions: async (_relayfileUrl, _workspaceId, workspaceToken) => {
        calls.seedTokens.push(workspaceToken);
      },
    },
  );

  assert.deepEqual(calls.broadMintScopes, [
    ["fs:read", "fs:write", "sync:read", "sync:trigger", "admin:acl"],
  ]);
  assert.deepEqual(calls.provisionAgents, ["member-a"]);
  assert.deepEqual(calls.seedTokens, ["relay_ws_broad"]);
  assert.equal(access.envToken, "relay_ws_broad");
  assert.equal(access.relayfileWorkspaceToken, "relay_ws_broad");
});

test("launchOrchestratorSandbox member mode puts relay_pa token in env without broad re-mint", async () => {
  const token = relayPaToken([pathScope("/packages/web")]);
  const originalEnv = {
    SANDBOX_PROVIDER: process.env.SANDBOX_PROVIDER,
    LOCAL_SANDBOX_URL: process.env.LOCAL_SANDBOX_URL,
    LOCAL_SANDBOX_RUNNER_URL: process.env.LOCAL_SANDBOX_RUNNER_URL,
  };
  const originalFetch = globalThis.fetch;
  const uploadedFiles = new Map<string, string>();
  const fetchedUrls: string[] = [];

  process.env.SANDBOX_PROVIDER = "local";
  process.env.LOCAL_SANDBOX_URL = "http://local-sandbox.test";
  delete process.env.LOCAL_SANDBOX_RUNNER_URL;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchedUrls.push(url);

    if (url === "https://relayfile.example/health") {
      return new Response("ok", { status: 200 });
    }
    if (url === "http://local-sandbox.test/sandboxes" && init?.method === "POST") {
      return Response.json({ sandboxId: "local-1", homeDir: "/home/daytona" });
    }
    if (url === "http://local-sandbox.test/sandboxes/local-1/exec") {
      return Response.json({ exitCode: 0, result: "" });
    }
    if (url === "http://local-sandbox.test/sandboxes/local-1/files" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as {
        entries: Array<{ destination: string; source: string }>;
      };
      for (const entry of body.entries) {
        uploadedFiles.set(entry.destination, Buffer.from(entry.source, "base64").toString("utf8"));
      }
      return Response.json({});
    }
    if (url === "https://assets.example/orchestrator-lib.tar.gz") {
      return new Response(Buffer.from("fake-tarball"), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const result = await launchOrchestratorSandbox({
      credentialBundle: credentialBundle(),
      runId: "run-1",
      fileType: "typescript",
      workspaceId: "workspace-1",
      relayfileUrl: "https://relayfile.example",
      relayAuthUrl: "https://relayauth.example",
      codeMountPath: "/home/daytona/workspace/packages/web",
      relayfileMountPaths: ["/packages/web", "/packages/web/"],
      relayfileMemberAccess: {
        agentName: "member-a",
        token,
        scopes: [pathScope("/packages/web")],
      },
      orchestratorLibUrl: "https://assets.example/orchestrator-lib.tar.gz",
      workflowFileContent: "console.log('member');",
      workflowFileName: "member.ts",
    });

    assert.equal(result.workdir, "/home/daytona/workspace/packages/web");
    assert.match(
      uploadedFiles.get("/home/daytona/.bootstrap-env") ?? "",
      new RegExp(`^export RELAYFILE_TOKEN='${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'$`, "m"),
    );
    assert.match(
      uploadedFiles.get("/home/daytona/.bootstrap-env") ?? "",
      /^export RELAYFILE_MOUNT_PATHS='\["\/packages\/web"\]'$/m,
    );
    assert.match(
      uploadedFiles.get("/home/daytona/.bootstrap-env") ?? "",
      /^export WORKFORCE_SANDBOX_ROOT='\/home\/daytona\/workspace'$/m,
    );
    assert.equal(
      fetchedUrls.some((url) => url.startsWith("https://relayauth.example")),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv.SANDBOX_PROVIDER === undefined) {
      delete process.env.SANDBOX_PROVIDER;
    } else {
      process.env.SANDBOX_PROVIDER = originalEnv.SANDBOX_PROVIDER;
    }
    if (originalEnv.LOCAL_SANDBOX_URL === undefined) {
      delete process.env.LOCAL_SANDBOX_URL;
    } else {
      process.env.LOCAL_SANDBOX_URL = originalEnv.LOCAL_SANDBOX_URL;
    }
    if (originalEnv.LOCAL_SANDBOX_RUNNER_URL === undefined) {
      delete process.env.LOCAL_SANDBOX_RUNNER_URL;
    } else {
      process.env.LOCAL_SANDBOX_RUNNER_URL = originalEnv.LOCAL_SANDBOX_RUNNER_URL;
    }
  }
});

test("launchOrchestratorSandbox member mode requires mounted roots covered by member scopes", async () => {
  const token = relayPaToken([pathScope("/packages/web")]);

  await assert.rejects(
    () =>
      launchOrchestratorSandbox({
        credentialBundle: credentialBundle(),
        runId: "run-1",
        fileType: "typescript",
        workspaceId: "workspace-1",
        relayfileUrl: "http://127.0.0.1:9",
        relayAuthUrl: "https://relayauth.example",
        relayfileMountPaths: ["/packages/web", "/packages/web/"],
        relayfileMemberAccess: {
          agentName: "member-a",
          token,
          scopes: [pathScope("/packages/web")],
        },
      }),
    /Relayfile service not healthy/,
  );

  await assert.rejects(
    () =>
      launchOrchestratorSandbox({
        credentialBundle: credentialBundle(),
        runId: "run-1",
        fileType: "typescript",
        workspaceId: "workspace-1",
        relayfileUrl: "https://relayfile.example",
        relayAuthUrl: "https://relayauth.example",
        relayfileMemberAccess: {
          agentName: "member-a",
          token: relayPaToken([pathScope("/packages/web")]),
          scopes: [pathScope("/packages/web")],
        },
      }),
    /relayfileMountPaths is required/,
  );

  await assert.rejects(
    () =>
      launchOrchestratorSandbox({
        credentialBundle: credentialBundle(),
        runId: "run-1",
        fileType: "typescript",
        workspaceId: "workspace-1",
        relayfileUrl: "https://relayfile.example",
        relayAuthUrl: "https://relayauth.example",
        relayfileMountPaths: ["/packages/api"],
        relayfileMemberAccess: {
          agentName: "member-a",
          token: relayPaToken([pathScope("/packages/web")]),
          scopes: [pathScope("/packages/web")],
        },
      }),
    /member write scope/,
  );
});

test("launchMember mints direct workspace-path relay_pa token and launches member env with narrow mount", async () => {
  const writeScope = pathScope("/packages/web");
  const token = relayPaToken([readPathScope("/packages/web"), writeScope]);
  const mintCalls: unknown[] = [];
  const launchCalls: unknown[] = [];
  const joins: unknown[] = [];

  const result = await launchMember(
    {
      memberName: "member-a",
      role: "implementer",
      channel: "team-1569",
      assignedRoot: "/packages/web",
      localRoot: "/workspace/packages/web",
      workspaceId: "workspace-1",
      relayfileUrl: "https://relayfile.example",
      relayAuthUrl: "https://relayauth.example",
      relayAuthApiKey: "relay-auth-key",
      runId: "run-1",
      harness: "claude",
      model: "claude-sonnet-4-6",
      credentialBundle: credentialBundle(),
      fileType: "typescript",
      workflowFileContent: "console.log('member');",
      workflowFileName: "member.ts",
      s3CodeKey: "s3://seed/member.ts",
    },
    {
      mintWorkspacePathScopedRelayfileToken: async (input) => {
        mintCalls.push(input);
        return token;
      },
      launchOrchestratorSandbox: async (options) => {
        launchCalls.push(options);
        return {
          sandboxId: "sandbox-1",
          runId: "run-1",
          workspaceId: "workspace-1",
          workdir: "/workspace",
        };
      },
      joinRelaycastChannel: async (input) => {
        joins.push(input);
      },
    },
  );

  assert.deepEqual(mintCalls, [
    {
      workspaceId: "workspace-1",
      relayAuthUrl: "https://relayauth.example",
      relayAuthApiKey: "relay-auth-key",
      agentName: "member-a",
      paths: ["/packages/web/*"],
      scopes: [writeScope],
      ttlSeconds: 120,
    },
  ]);

  assert.equal(launchCalls.length, 1);
  assert.deepEqual(launchCalls[0], {
    credentialBundle: credentialBundle(),
    runId: "run-1",
    memberHarness: "claude",
    memberModel: "claude-sonnet-4-6",
    fileType: "typescript",
    workspaceId: "workspace-1",
    relayfileUrl: "https://relayfile.example",
    relayAuthUrl: "https://relayauth.example",
    s3CodeKey: "s3://seed/member.ts",
    workflowFileContent: "console.log('member');",
    workflowFileName: "member.ts",
    codeMountPath: "/workspace/packages/web",
    relayfileMountPaths: ["/packages/web"],
    relayfileMemberAccess: {
      agentName: "member-a",
      token,
      scopes: [readPathScope("/packages/web"), writeScope],
    },
    metadata: {
      LAUNCH_MEMBER_ASSIGNED_ROOT: "/packages/web",
      LAUNCH_MEMBER_CHANNEL: "team-1569",
      LAUNCH_MEMBER_LOCAL_ROOT: "/workspace/packages/web",
      LAUNCH_MEMBER_NAME: "member-a",
      LAUNCH_MEMBER_ROLE: "implementer",
      LAUNCH_MEMBER_HARNESS: "claude",
      LAUNCH_MEMBER_MODEL: "claude-sonnet-4-6",
    },
  });

  assert.deepEqual(joins, [{ channel: "team-1569", memberName: "member-a", role: "implementer" }]);
  assert.deepEqual(result, {
    memberName: "member-a",
    role: "implementer",
    channel: "team-1569",
    sandboxId: "sandbox-1",
    assignedRoot: "/packages/web",
    localRoot: "/workspace/packages/web",
    relayfileToken: token,
    writeScopes: [writeScope],
  });
});

test("launchMember forwards provisioning sandbox id so launcher reattaches existing member sandbox", async () => {
  const writeScope = pathScope("/packages/web");
  const token = relayPaToken([readPathScope("/packages/web"), writeScope]);
  const launchCalls: unknown[] = [];
  const provisioningCallbacks: string[] = [];
  const orchestratorLibTarball = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);

  const result = await launchMember(
    {
      memberName: "member-a",
      role: "implementer",
      channel: "team-1569",
      assignedRoot: "/packages/web",
      localRoot: "/workspace/packages/web",
      workspaceId: "workspace-1",
      relayfileUrl: "https://relayfile.example",
      relayAuthUrl: "https://relayauth.example",
      relayfileToken: token,
      runId: "run-1",
      credentialBundle: credentialBundle(),
      fileType: "typescript",
      orchestratorLibTarball,
      orchestratorLibUrl: "https://assets.example/orchestrator-lib.tar.gz",
      provisioningSandboxId: "sandbox-existing",
      onProvisioningSandboxCreated: (sandboxId) => {
        provisioningCallbacks.push(sandboxId);
      },
    },
    {
      launchOrchestratorSandbox: async (options) => {
        launchCalls.push(options);
        assert.equal(options.orchestratorLibTarball, orchestratorLibTarball);
        assert.equal(options.orchestratorLibUrl, "https://assets.example/orchestrator-lib.tar.gz");
        assert.equal(options.provisioningSandboxId, "sandbox-existing");
        assert.equal(typeof options.onProvisioningSandboxCreated, "function");
        return {
          sandboxId: options.provisioningSandboxId,
          runId: "run-1",
          workspaceId: "workspace-1",
        };
      },
    },
  );

  assert.equal(launchCalls.length, 1);
  assert.deepEqual(provisioningCallbacks, []);
  assert.deepEqual(result, {
    memberName: "member-a",
    role: "implementer",
    channel: "team-1569",
    sandboxId: "sandbox-existing",
    assignedRoot: "/packages/web",
    localRoot: "/workspace/packages/web",
    relayfileToken: token,
    writeScopes: [writeScope],
  });
});

test("collectWorkflowAgentConfigs preserves explicit model constraints", () => {
  const agents = collectWorkflowAgentConfigs(JSON.stringify({
    agents: [
      {
        name: "cloud-team-issue-n1",
        cli: "claude",
        constraints: { model: "claude-sonnet-4-6" },
      },
    ],
  }));

  assert.deepEqual(agents[0]?.constraints, { model: "claude-sonnet-4-6" });
});

test("launchMember accepts a direct relay_pa token and never mints relay_ws-derived member access", async () => {
  const writeScope = pathScope("/github/repos/acme/cloud/issues/123");
  const readScope = readPathScope("/github/repos/acme/cloud/issues/123");
  const token = relayPaToken([readScope, writeScope]);
  const mintCalls: unknown[] = [];
  const launchCalls: unknown[] = [];

  const result = await launchMember(
    {
      memberName: "member-a",
      role: "implementer",
      channel: "team-1569",
      assignedRoot: "/github/repos/acme/cloud/issues/123",
      localRoot: "/workspace/github/repos/acme/cloud/issues/123",
      workspaceId: "workspace-1",
      relayfileUrl: "https://relayfile.example",
      relayAuthUrl: "https://relayauth.example",
      relayfileToken: token,
      runId: "run-1",
      credentialBundle: credentialBundle(),
      fileType: "typescript",
    },
    {
      mintWorkspacePathScopedRelayfileToken: async (input) => {
        mintCalls.push(input);
        return relayPaToken([writeScope]);
      },
      launchOrchestratorSandbox: async (options) => {
        launchCalls.push(options);
        return {
          sandboxId: "sandbox-1",
          runId: "run-1",
          workspaceId: "workspace-1",
        };
      },
    },
  );

  assert.equal(mintCalls.length, 0);
  assert.equal(JSON.stringify(launchCalls), JSON.stringify(launchCalls).replaceAll("relay_ws_", ""));
  assert.deepEqual(result.writeScopes, [writeScope]);
});

test("launchMember rejects direct relay_ws member tokens by construction", async () => {
  const launchCalls: unknown[] = [];

  await assert.rejects(
    () =>
      launchMember(
        {
          memberName: "member-a",
          role: "implementer",
          channel: "team-1569",
          assignedRoot: "/github/repos/acme/cloud/issues/123",
          localRoot: "/workspace/github/repos/acme/cloud/issues/123",
          workspaceId: "workspace-1",
          relayfileUrl: "https://relayfile.example",
          relayAuthUrl: "https://relayauth.example",
          relayfileToken: "relay_ws_workspace",
          runId: "run-1",
          credentialBundle: credentialBundle(),
          fileType: "typescript",
        },
        {
          launchOrchestratorSandbox: async (options) => {
            launchCalls.push(options);
            return {
              sandboxId: "sandbox-1",
              runId: "run-1",
              workspaceId: "workspace-1",
            };
          },
        },
      ),
    /must not be a relay_ws_/,
  );

  assert.equal(launchCalls.length, 0);
});

test("launchMember fails before launch when direct minted relay_pa scopes do not match assigned root", async () => {
  const mintCalls: unknown[] = [];
  const launchCalls: unknown[] = [];

  await assert.rejects(
    () =>
      launchMember(
        {
          memberName: "member-a",
          role: "implementer",
          channel: "team-1569",
          assignedRoot: "/packages/web",
          localRoot: "/workspace/packages/web",
          workspaceId: "workspace-1",
          relayfileUrl: "https://relayfile.example",
          relayAuthUrl: "https://relayauth.example",
          relayAuthApiKey: "relay-auth-key",
          runId: "run-1",
          credentialBundle: credentialBundle(),
          fileType: "typescript",
          workflowFileContent: "console.log('member');",
          workflowFileName: "member.ts",
        },
        {
          mintWorkspacePathScopedRelayfileToken: async (input) => {
            mintCalls.push(input);
            return relayPaToken([pathScope("/packages/api")]);
          },
          launchOrchestratorSandbox: async (options) => {
            launchCalls.push(options);
            return {
              sandboxId: "sandbox-1",
              runId: "run-1",
              workspaceId: "workspace-1",
            };
          },
        },
      ),
    /Invalid member write scope/,
  );

  assert.equal(mintCalls.length, 1);
  assert.equal(launchCalls.length, 0);
});

test("launchMember rejects traversal roots before mint", async () => {
  const mintCalls: unknown[] = [];

  await assert.rejects(
    () =>
      launchMember(
        {
          memberName: "member-a",
          role: "implementer",
          channel: "team-1569",
          assignedRoot: "/packages/../secrets",
          localRoot: "/workspace/packages/../secrets",
          workspaceId: "workspace-1",
          relayfileUrl: "https://relayfile.example",
          relayAuthUrl: "https://relayauth.example",
          relayAuthApiKey: "relay-auth-key",
          runId: "run-1",
          credentialBundle: credentialBundle(),
          fileType: "typescript",
          workflowFileContent: "console.log('member');",
          workflowFileName: "member.ts",
        },
        {
          mintWorkspacePathScopedRelayfileToken: async (input) => {
            mintCalls.push(input);
            return relayPaToken([pathScope("/secrets")]);
          },
        },
      ),
    /path traversal/,
  );

  assert.equal(mintCalls.length, 0);
});

test("launchMember rejects degenerate roots before mint", async () => {
  const mintCalls: unknown[] = [];

  await assert.rejects(
    () =>
      launchMember(
        {
          memberName: "member-a",
          role: "implementer",
          channel: "team-1569",
          assignedRoot: "/",
          localRoot: "/workspace",
          workspaceId: "workspace-1",
          relayfileUrl: "https://relayfile.example",
          relayAuthUrl: "https://relayauth.example",
          relayAuthApiKey: "relay-auth-key",
          runId: "run-1",
          credentialBundle: credentialBundle(),
          fileType: "typescript",
          workflowFileContent: "console.log('member');",
          workflowFileName: "member.ts",
        },
        {
          mintWorkspacePathScopedRelayfileToken: async (input) => {
            mintCalls.push(input);
            return relayPaToken([pathScope("/")]);
          },
        },
      ),
    /non-root relayfile path/,
  );

  assert.equal(mintCalls.length, 0);
});
