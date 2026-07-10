import { NextRequest, NextResponse } from "next/server";
import { handleComposioConnectCallback } from "@/lib/integrations/composio-connect-callback";
import { captureError, logger } from "@/lib/logger";
import { getRelayWorkspace } from "@/lib/relay-workspaces";

export const runtime = "nodejs";

function appendStatus(returnTo: string, requestUrl: string, status: "connected" | "failed"): URL {
  const requestOrigin = new URL(requestUrl).origin;
  const isAbsoluteUrl = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(returnTo);
  const isRelativePath = returnTo.startsWith("/") && !returnTo.startsWith("//");
  if (!isAbsoluteUrl && !isRelativePath) {
    throw new Error("invalid_return_to");
  }

  const redirect = new URL(returnTo, requestUrl);
  if (redirect.origin !== requestOrigin) {
    throw new Error("invalid_return_to");
  }

  redirect.searchParams.set("composioStatus", status);
  return redirect;
}

function statusForError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === "missing_state" ||
    message === "invalid_state" ||
    message === "invalid_state_signature" ||
    message === "invalid_state_payload" ||
    message === "expired_state" ||
    message === "invalid_return_to" ||
    message === "unknown_provider" ||
    message === "missing_connected_account_id" ||
    message === "composio_connection_failed"
  ) {
    return 400;
  }
  if (message === "connected_account_not_found") {
    return 404;
  }
  if (message.startsWith("connected_account_not_active")) {
    return 409;
  }
  if (message === "nango_bridge_connection_failed" || message === "nango_sync_trigger_failed") {
    return 502;
  }
  if (message.includes("COMPOSIO_API_KEY") || message.includes("NANGO_SECRET_KEY")) {
    return 503;
  }
  return 500;
}

function publicErrorForError(error: unknown, status: number): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === "missing_state" ||
    message === "invalid_state" ||
    message === "invalid_state_signature" ||
    message === "invalid_state_payload" ||
    message === "expired_state" ||
    message === "invalid_return_to" ||
    message === "unknown_provider" ||
    message === "missing_connected_account_id" ||
    message === "composio_connection_failed" ||
    message === "connected_account_not_found" ||
    message === "nango_bridge_connection_failed" ||
    message === "nango_sync_trigger_failed"
  ) {
    return message;
  }
  if (message.startsWith("connected_account_not_active")) {
    return "connected_account_not_active";
  }
  if (status === 503) {
    return "composio_callback_not_configured";
  }
  return "composio_callback_failed";
}

function wantsJson(request: NextRequest): boolean {
  const format = request.nextUrl.searchParams.get("format")?.trim().toLowerCase();
  if (format === "json") {
    return true;
  }

  return request.headers.get("accept")?.toLowerCase().includes("application/json") ?? false;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatProviderName(provider: string): string {
  const normalized = provider.trim().toLowerCase().replace(/[-_]+/g, " ");
  const knownNames: Record<string, string> = {
    "docker hub": "Docker Hub",
    dockerhub: "Docker Hub",
    github: "GitHub",
    gitlab: "GitLab",
    gmail: "Gmail",
    google: "Google",
    "google calendar": "Google Calendar",
    "google mail": "Google Mail",
    hubspot: "HubSpot",
    jira: "Jira",
    linear: "Linear",
    notion: "Notion",
    slack: "Slack",
    stripe: "Stripe",
  };
  const knownName = knownNames[normalized] ?? knownNames[provider.trim().toLowerCase()];
  if (knownName) {
    return knownName;
  }

  return normalized
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function resolveWorkspaceName(workspaceId: string): Promise<string | null> {
  try {
    return (await getRelayWorkspace(workspaceId))?.name ?? null;
  } catch {
    return null;
  }
}

function htmlPage(input: {
  title: string;
  heading: string;
  intro: string;
  status: "success" | "error";
  statusCode?: number;
  details: Record<string, string | null | undefined>;
}): Response {
  const accent = input.status === "success" ? "var(--status-success)" : "var(--status-danger)";
  const statusSurface =
    input.status === "success" ? "var(--status-success-soft)" : "var(--status-danger-soft)";
  const badgeLabel = input.status === "success" ? "Connected" : "Connection failed";
  const details = Object.entries(input.details)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) => `
      <div class="detail">
        <dt>${escapeHtml(label)}</dt>
        <dd>${escapeHtml(value)}</dd>
      </div>
    `)
    .join("");

  const body = `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(input.title)}</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --background: #08111a;
        --background-deep: #050c14;
        --foreground: #edf4fb;
        --fg: var(--foreground);
        --fg-muted: #a8b8c8;
        --fg-faint: #64707d;
        --brand-primary: #74b8e2;
        --brand-observer-soft: rgba(4, 209, 246, 0.18);
        --brand-warm: #ce9178;
        --surface-card: rgba(15, 27, 41, 0.94);
        --surface-soft: #0f1b29;
        --surface-strong: #132234;
        --border-default: rgba(116, 184, 226, 0.16);
        --border-strong: rgba(116, 184, 226, 0.3);
        --shadow-color: rgba(0, 0, 0, 0.42);
        --status-success: #63d18b;
        --status-success-soft: rgba(99, 209, 139, 0.14);
        --status-danger: #f0727f;
        --status-danger-soft: rgba(240, 114, 127, 0.14);
        --grid-dot: rgba(116, 184, 226, 0.1);
        background: var(--background);
        color: var(--fg);
      }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        min-height: 100dvh;
        margin: 0;
        padding: 32px 20px;
        background:
          radial-gradient(circle at top left, color-mix(in srgb, var(--brand-primary) 24%, transparent), transparent 32%),
          radial-gradient(circle at 82% 12%, var(--brand-observer-soft), transparent 26%),
          radial-gradient(circle at bottom right, color-mix(in srgb, var(--brand-warm) 18%, transparent), transparent 28%),
          linear-gradient(180deg, var(--background) 0%, var(--background-deep) 100%);
        color: var(--fg);
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image: radial-gradient(circle, var(--grid-dot) 1px, transparent 1px);
        background-size: 24px 24px;
        mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.55), transparent 95%);
      }
      .shell {
        position: relative;
        min-height: calc(100vh - 64px);
        min-height: calc(100dvh - 64px);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      main {
        width: min(100%, 768px);
        overflow: hidden;
        border: 1px solid var(--border-default);
        border-radius: 28px;
        background: var(--surface-card);
        box-shadow: 0 24px 60px -32px var(--shadow-color);
        backdrop-filter: blur(16px);
      }
      .header {
        border-bottom: 1px solid var(--border-default);
        background: linear-gradient(135deg, color-mix(in srgb, var(--brand-primary) 18%, transparent), var(--surface-strong), transparent);
        padding: 32px;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 30px;
        border: 1px solid ${accent};
        border-radius: 999px;
        background: ${statusSurface};
        padding: 5px 12px;
        color: ${accent};
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.2em;
        text-transform: uppercase;
      }
      .badge::before {
        content: "";
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: ${accent};
      }
      h1 {
        margin: 24px 0 16px;
        color: var(--fg);
        font-size: 40px;
        font-weight: 650;
        line-height: 1.18;
        letter-spacing: -0.01em;
      }
      p {
        margin: 0;
        max-width: 672px;
        color: var(--fg-muted);
        font-size: 16px;
        line-height: 1.75;
      }
      .content {
        padding: 32px;
      }
      dl {
        margin: 0;
        display: grid;
        gap: 14px;
      }
      .detail {
        display: grid;
        gap: 8px;
        border: 1px solid var(--border-default);
        border-radius: 16px;
        background: var(--surface-soft);
        padding: 18px;
      }
      dt {
        color: var(--fg-muted);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }
      dd {
        margin: 0;
        color: var(--fg);
        font-size: 15px;
        line-height: 1.5;
        overflow-wrap: anywhere;
      }
      .terminal {
        margin-top: 20px;
        border: 1px solid ${accent};
        border-radius: 16px;
        background: ${statusSurface};
        padding: 20px;
      }
      .terminal-label {
        color: ${accent};
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }
      .terminal-copy {
        margin-top: 12px;
        color: var(--fg);
        font-size: 15px;
        line-height: 1.65;
      }
      .footer {
        margin-top: 20px;
        color: var(--fg-faint);
        font-size: 14px;
      }
      @media (max-width: 520px) {
        body { padding: 16px; }
        .shell {
          min-height: calc(100vh - 32px);
          min-height: calc(100dvh - 32px);
        }
        .header,
        .content {
          padding: 24px;
        }
        h1 { font-size: 30px; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <main>
        <section class="header">
          <div class="badge">${badgeLabel}</div>
          <h1>${escapeHtml(input.heading)}</h1>
          <p>${escapeHtml(input.intro)}</p>
        </section>
        <section class="content">
          ${details ? `<dl>${details}</dl>` : ""}
          <div class="terminal">
            <div class="terminal-label">Next step</div>
            <div class="terminal-copy">Return to your terminal. You can close this tab once the CLI resumes.</div>
          </div>
          <div class="footer">Agent Relay Cloud</div>
        </section>
      </main>
    </div>
  </body>
</html>`;

  return new NextResponse(body, {
    status: input.statusCode ?? (input.status === "success" ? 200 : 500),
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}

function successJson(result: Awaited<ReturnType<typeof handleComposioConnectCallback>>) {
  return {
    ok: true,
    workspaceId: result.workspaceId,
    provider: result.provider,
    connectionId: result.connectionId,
    providerConfigKey: result.providerConfigKey,
    syncTriggered: result.syncTriggered,
    syncs: result.syncs,
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const result = await handleComposioConnectCallback(request.nextUrl);
    await logger.info("Composio connect callback finalized", {
      area: "composio-connect-callback",
      workspaceId: result.workspaceId,
      provider: result.provider,
      connectionId: result.connectionId,
      providerConfigKey: result.providerConfigKey,
      syncTriggered: result.syncTriggered,
      syncs: result.syncs,
    });

    if (result.returnTo) {
      return NextResponse.redirect(appendStatus(result.returnTo, request.url, "connected"), {
        status: 303,
      });
    }

    if (wantsJson(request)) {
      return NextResponse.json(successJson(result));
    }

    const providerName = formatProviderName(result.provider);
    const workspaceName = await resolveWorkspaceName(result.workspaceId);
    return htmlPage({
      status: "success",
      title: `${providerName} connected`,
      heading: `Connected ${providerName}. You can close this window.`,
      intro: "The connection finished successfully and Cloud has saved it for this workspace.",
      details: {
        Provider: providerName,
        Workspace: workspaceName ?? result.workspaceId,
        "Workspace ID": workspaceName ? result.workspaceId : null,
      },
    });
  } catch (error) {
    await captureError(error, {
      area: "composio-connect-callback",
      route: "/api/v1/webhooks/composio/connect/callback",
    });
    const status = statusForError(error);
    const publicError = publicErrorForError(error, status);
    if (wantsJson(request)) {
      return NextResponse.json({ ok: false, error: publicError }, { status });
    }

    return htmlPage({
      status: "error",
      statusCode: status,
      title: "Connection failed",
      heading: "The connection did not finish.",
      intro: "Cloud could not finalize the Composio connection. Return to your terminal and retry the setup command.",
      details: {
        Error: publicError,
      },
    });
  }
}
