type RelayfileCredentials = {
  url: string;
  token: string;
  workspaceId: string;
};

export type IssueDispatchClaim = {
  relayfileUrl: string;
  relayfileToken: string;
  workspaceId: string;
  path: string;
  issueNumber: number;
};

export type IssueDispatchClaimResult =
  | { proceed: false; diagnostic?: Record<string, unknown> }
  | { proceed: true; claim?: IssueDispatchClaim; diagnostic?: Record<string, unknown> };

export type IssueDispatchClaimConfig = {
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  claimRoot: string;
  correlationId: string;
  agentIdFallback: string;
  credentialSource: "ctx-with-env-fallback" | "legacy-ctx-direct";
  claimPutPolicy:
    | { kind: "bounded-timeout"; maxAttempts: number; timeoutMs: number; backoffMs: number }
    | { kind: "single-attempt" };
  unknownStatePolicy: "fail-closed" | "none";
  degradedHttpPolicy: "fail-open";
  diagnostics: "include" | "omit";
};

export async function claimIssueDispatch(
  ctx: any,
  issue: {
    eventId?: string;
    issueNumber: number;
    issueTitle: string;
  },
  config: IssueDispatchClaimConfig,
): Promise<IssueDispatchClaimResult> {
  return config.claimPutPolicy.kind === "bounded-timeout"
    ? claimIssueDispatchBounded(ctx, issue, config)
    : claimIssueDispatchSingleAttempt(ctx, issue, config);
}

export async function releaseIssueDispatchClaim(
  ctx: any,
  claim: IssueDispatchClaim,
  config: Pick<IssueDispatchClaimConfig, "correlationId">,
): Promise<void> {
  try {
    const response = await fetch(relayfileFileUrl(claim), {
      method: "DELETE",
      headers: {
        ...relayfileRequestHeaders(claim.relayfileToken, config.correlationId),
        "if-match": "*",
      },
    });
    if (!response.ok && response.status !== 404) {
      ctx.log?.("error", "issue dispatch claim release failed", {
        issueNumber: claim.issueNumber,
        claimPath: claim.path,
        status: response.status,
        body: await response.text().catch(() => ""),
      });
    }
  } catch (error) {
    ctx.log?.("error", "issue dispatch claim release errored", {
      issueNumber: claim.issueNumber,
      claimPath: claim.path,
      error: errMsg(error),
    });
  }
}

export function issueDispatchClaimOutcome(claim: IssueDispatchClaimResult): string {
  if (claim.proceed) return claim.claim ? "acquired" : "fail-open";
  return claim.diagnostic?.result === "duplicate" ? "duplicate" : "claim-unavailable";
}

function result(
  config: IssueDispatchClaimConfig,
  value: IssueDispatchClaimResult,
): IssueDispatchClaimResult {
  if (config.diagnostics === "include") return value;
  if (value.proceed) {
    return value.claim ? { proceed: true, claim: value.claim } : { proceed: true };
  }
  return { proceed: false };
}

async function claimIssueDispatchBounded(
  ctx: any,
  issue: {
    eventId?: string;
    issueNumber: number;
    issueTitle: string;
  },
  config: IssueDispatchClaimConfig & {
    claimPutPolicy: { kind: "bounded-timeout"; maxAttempts: number; timeoutMs: number; backoffMs: number };
  },
): Promise<IssueDispatchClaimResult> {
  const credentialLookup = readRelayfileCredentials(ctx, config);
  const relayfileCredentials = credentialLookup.credentials;
  const claimPath = claimPathForIssue(issue.issueNumber, config);

  if (!relayfileCredentials) {
    ctx.log?.("error", "issue dispatch claim unavailable; proceeding fail-open", {
      issueNumber: issue.issueNumber,
      error: credentialLookup.error,
    });
    return result(config, {
      proceed: true,
      diagnostic: { result: "credentials_unavailable", error: credentialLookup.error },
    });
  }

  const claim = buildClaim(issue.issueNumber, claimPath, relayfileCredentials);
  const body = claimRequestBody(ctx, issue, config);
  let claimStateUnknown = false;
  let lastClaimTimeoutError: unknown;

  for (let attempt = 1; attempt <= config.claimPutPolicy.maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        relayfileFileUrl(claim),
        {
          method: "PUT",
          headers: {
            ...relayfileRequestHeaders(relayfileCredentials.token, config.correlationId),
            "X-Relayfile-Write-Class": "foreground_control",
            "content-type": "application/json",
            "if-match": "0",
          },
          body,
        },
        config.claimPutPolicy.timeoutMs,
      );

      if (response.status === 409) {
        if (claimStateUnknown) {
          ctx.log?.("error", "issue dispatch claim state unknown after timeout; skipping dispatch", {
            issueNumber: issue.issueNumber,
            claimPath,
            attempt,
            status: response.status,
            timeoutMs: config.claimPutPolicy.timeoutMs,
          });
          return result(config, {
            proceed: false,
            diagnostic: {
              status: response.status,
              result: "claim_state_unknown",
              attempts: attempt,
              timeoutMs: config.claimPutPolicy.timeoutMs,
            },
          });
        }
        ctx.log?.("info", "duplicate issue dispatch claim; skipping", {
          issueNumber: issue.issueNumber,
          claimPath,
        });
        return result(config, { proceed: false, diagnostic: { status: 409, result: "duplicate" } });
      }

      if (!response.ok) {
        const responseBody = await response.text().catch(() => "");
        if (claimStateUnknown) {
          if (attempt < config.claimPutPolicy.maxAttempts) {
            ctx.log?.("warn", "issue dispatch claim state unknown; retrying", {
              issueNumber: issue.issueNumber,
              claimPath,
              attempt,
              status: response.status,
              timeoutMs: config.claimPutPolicy.timeoutMs,
              body: responseBody,
            });
            await sleep(config.claimPutPolicy.backoffMs * attempt);
            continue;
          }
          ctx.log?.("error", "issue dispatch claim state unknown; skipping dispatch", {
            issueNumber: issue.issueNumber,
            claimPath,
            attempt,
            status: response.status,
            timeoutMs: config.claimPutPolicy.timeoutMs,
            body: responseBody,
          });
          return result(config, {
            proceed: false,
            diagnostic: {
              status: response.status,
              result: "claim_state_unknown",
              attempts: attempt,
              timeoutMs: config.claimPutPolicy.timeoutMs,
              bodyPreview: responseBody.slice(0, 1000),
            },
          });
        }
        if (response.status === 429) {
          ctx.log?.("warn", "write_admission.fail_open", {
            issueNumber: issue.issueNumber,
            claimPath,
            status: response.status,
            retryAfter: response.headers.get("retry-after"),
            body: responseBody,
          });
          return result(config, {
            proceed: true,
            diagnostic: {
              status: response.status,
              result: "workspace_busy",
              retryAfter: response.headers.get("retry-after"),
              bodyPreview: responseBody.slice(0, 1000),
            },
          });
        }
        ctx.log?.("error", "issue dispatch claim failed; proceeding fail-open", {
          issueNumber: issue.issueNumber,
          claimPath,
          status: response.status,
          body: responseBody,
        });
        return result(config, {
          proceed: true,
          diagnostic: {
            status: response.status,
            result: response.status >= 500 ? "server_error" : "http_error",
            bodyPreview: responseBody.slice(0, 1000),
          },
        });
      }

      return result(config, {
        proceed: true,
        claim,
        diagnostic: { status: response.status, result: "acquired", attempt },
      });
    } catch (error) {
      if (isAbortError(error)) {
        claimStateUnknown = true;
        lastClaimTimeoutError = error;
        if (attempt < config.claimPutPolicy.maxAttempts) {
          ctx.log?.("warn", "issue dispatch claim timed out; retrying", {
            issueNumber: issue.issueNumber,
            claimPath,
            attempt,
            timeoutMs: config.claimPutPolicy.timeoutMs,
            error: errMsg(error),
          });
          await sleep(config.claimPutPolicy.backoffMs * attempt);
          continue;
        }
        ctx.log?.("error", "issue dispatch claim timed out; skipping dispatch", {
          issueNumber: issue.issueNumber,
          claimPath,
          attempt,
          timeoutMs: config.claimPutPolicy.timeoutMs,
          error: errMsg(error),
        });
        break;
      }
      if (claimStateUnknown) {
        if (attempt < config.claimPutPolicy.maxAttempts) {
          ctx.log?.("warn", "issue dispatch claim state unknown after error; retrying", {
            issueNumber: issue.issueNumber,
            claimPath,
            attempt,
            timeoutMs: config.claimPutPolicy.timeoutMs,
            error: errMsg(error),
          });
          await sleep(config.claimPutPolicy.backoffMs * attempt);
          continue;
        }
        ctx.log?.("error", "issue dispatch claim state unknown after error; skipping dispatch", {
          issueNumber: issue.issueNumber,
          claimPath,
          attempt,
          timeoutMs: config.claimPutPolicy.timeoutMs,
          error: errMsg(error),
        });
        return result(config, {
          proceed: false,
          diagnostic: {
            result: "claim_state_unknown",
            attempts: attempt,
            timeoutMs: config.claimPutPolicy.timeoutMs,
            error: errMsg(error),
          },
        });
      }
      ctx.log?.("error", "issue dispatch claim errored; proceeding fail-open", {
        issueNumber: issue.issueNumber,
        claimPath,
        error: errMsg(error),
      });
      return result(config, { proceed: true, diagnostic: { result: "exception", error: errMsg(error) } });
    }
  }

  return result(config, {
    proceed: false,
    diagnostic: {
      result: "claim_timeout",
      attempts: config.claimPutPolicy.maxAttempts,
      timeoutMs: config.claimPutPolicy.timeoutMs,
      error: lastClaimTimeoutError ? errMsg(lastClaimTimeoutError) : undefined,
    },
  });
}

async function claimIssueDispatchSingleAttempt(
  ctx: any,
  issue: {
    eventId?: string;
    issueNumber: number;
    issueTitle: string;
  },
  config: IssueDispatchClaimConfig,
): Promise<IssueDispatchClaimResult> {
  const runtimeCredentials = ctx.credentials;
  const tryRequire = runtimeCredentials?.tryRequire;
  const relayfileCredentials =
    typeof tryRequire === "function" ? tryRequire.call(runtimeCredentials)?.relayfile : undefined;
  const claimPath = claimPathForIssue(issue.issueNumber, config);

  if (!relayfileCredentials) {
    let error =
      typeof tryRequire === "function"
        ? "Runtime credentials are required: missing relayfile.url, relayfile.token, relayfile.workspaceId"
        : "Runtime credentials are required: missing ctx.credentials";
    const requireCredentials = runtimeCredentials?.require;
    if (typeof requireCredentials === "function") {
      try {
        requireCredentials.call(runtimeCredentials);
      } catch (credentialError) {
        error = errMsg(credentialError);
      }
    }
    ctx.log?.("error", "issue dispatch claim unavailable; proceeding fail-open", {
      issueNumber: issue.issueNumber,
      error,
    });
    return result(config, { proceed: true });
  }

  const claim = buildClaim(issue.issueNumber, claimPath, relayfileCredentials);

  try {
    const response = await fetch(
      relayfileFileUrl(claim),
      {
        method: "PUT",
        headers: {
          ...relayfileRequestHeaders(relayfileCredentials.token, config.correlationId),
          "X-Relayfile-Write-Class": "foreground_control",
          "content-type": "application/json",
          "if-match": "0",
        },
        body: claimRequestBody(ctx, issue, config),
      },
    );

    if (response.status === 409) {
      ctx.log?.("info", "duplicate issue dispatch claim; skipping", {
        issueNumber: issue.issueNumber,
        claimPath,
      });
      return result(config, { proceed: false });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (response.status === 429) {
        ctx.log?.("warn", "write_admission.fail_open", {
          issueNumber: issue.issueNumber,
          claimPath,
          status: response.status,
          retryAfter: response.headers.get("retry-after"),
          body,
        });
        return result(config, { proceed: true });
      }
      ctx.log?.("error", "issue dispatch claim failed; proceeding fail-open", {
        issueNumber: issue.issueNumber,
        claimPath,
        status: response.status,
        body,
      });
      return result(config, { proceed: true });
    }

    return result(config, { proceed: true, claim });
  } catch (error) {
    ctx.log?.("error", "issue dispatch claim errored; proceeding fail-open", {
      issueNumber: issue.issueNumber,
      claimPath,
      error: errMsg(error),
    });
    return result(config, { proceed: true });
  }
}

function buildClaim(
  issueNumber: number,
  claimPath: string,
  relayfileCredentials: RelayfileCredentials,
): IssueDispatchClaim {
  return {
    relayfileUrl: relayfileCredentials.url,
    relayfileToken: relayfileCredentials.token,
    workspaceId: relayfileCredentials.workspaceId,
    path: claimPath,
    issueNumber,
  };
}

function claimRequestBody(
  ctx: any,
  issue: {
    eventId?: string;
    issueNumber: number;
    issueTitle: string;
  },
  config: IssueDispatchClaimConfig,
): string {
  return JSON.stringify({
    contentType: "application/json",
    encoding: "utf-8",
    content: JSON.stringify({
      agentId: stringValue(ctx.agent?.id) ?? config.agentIdFallback,
      repo: config.repoFullName,
      issueNumber: issue.issueNumber,
      issueTitle: issue.issueTitle,
      eventId: issue.eventId,
      claimedAt: new Date().toISOString(),
    }, null, 2),
  });
}

function claimPathForIssue(issueNumber: number, config: IssueDispatchClaimConfig): string {
  return `${config.claimRoot}/issues/${safeName(config.repoOwner)}__${safeName(config.repoName)}__${issueNumber}.json`;
}

function relayfileFileUrl(claim: Pick<IssueDispatchClaim, "relayfileUrl" | "workspaceId" | "path">): string {
  return `${claim.relayfileUrl.replace(/\/+$/u, "")}/v1/workspaces/${encodeURIComponent(claim.workspaceId)}/fs/file?path=${encodeURIComponent(claim.path)}`;
}

function relayfileRequestHeaders(relayfileToken: string, correlationId: string): Record<string, string> {
  return {
    authorization: `Bearer ${relayfileToken}`,
    "X-Correlation-Id": correlationId,
  };
}

function readRelayfileCredentials(
  ctx: any,
  config: IssueDispatchClaimConfig,
): { credentials?: RelayfileCredentials; error: string } {
  if (config.credentialSource === "legacy-ctx-direct") {
    const runtimeCredentials = ctx.credentials;
    const tryRequire = runtimeCredentials?.tryRequire;
    const requireCredentials = runtimeCredentials?.require;
    if (typeof tryRequire === "function") {
      const credentials = tryRequire.call(runtimeCredentials)?.relayfile;
      if (credentials) {
        return { credentials, error: "" };
      }

      let error =
        "Runtime credentials are required: missing relayfile.url, relayfile.token, relayfile.workspaceId";
      if (typeof requireCredentials === "function") {
        try {
          requireCredentials.call(runtimeCredentials);
        } catch (credentialError) {
          error = errMsg(credentialError);
        }
      }
      return { error };
    }
    return { error: "Runtime credentials are required: missing ctx.credentials" };
  }

  const runtimeCredentials = ctx.credentials;
  const tryRequire = runtimeCredentials?.tryRequire;
  if (typeof tryRequire === "function") {
    const credentials = normalizeRelayfileCredentials(tryRequire.call(runtimeCredentials)?.relayfile);
    if (credentials) {
      return { credentials, error: "" };
    }

    let error = "Runtime credentials are required: missing relayfile.url, relayfile.token, relayfile.workspaceId";
    if (typeof runtimeCredentials.require === "function") {
      try {
        runtimeCredentials.require();
      } catch (credentialError) {
        error = errMsg(credentialError);
      }
    }
    return { error };
  }

  const envCredentials = normalizeRelayfileCredentials({
    url: process.env.RELAYFILE_URL ?? process.env.RELAYFILE_BASE_URL,
    token: process.env.RELAYFILE_TOKEN,
    workspaceId:
      process.env.RELAYFILE_WORKSPACE_ID ??
      process.env.WORKFORCE_WORKSPACE_ID ??
      process.env.RELAYFILE_WORKSPACE ??
      process.env.RELAY_WORKSPACE_ID,
  });
  if (envCredentials) {
    return { credentials: envCredentials, error: "" };
  }

  return {
    error: "Runtime credentials are required: missing ctx.credentials and relayfile env credentials",
  };
}

function normalizeRelayfileCredentials(value: unknown): RelayfileCredentials | undefined {
  const record = maybeRecord(value);
  if (!record) return undefined;
  const url = stringValue(record.url)?.replace(/\/+$/u, "");
  const token = stringValue(record.token);
  const workspaceId = stringValue(record.workspaceId);
  if (!url || !token || !workspaceId) return undefined;
  return { url, token, workspaceId };
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function maybeRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
