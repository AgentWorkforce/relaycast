import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Header } from "@/app/components/Header";
import { Badge } from "@/app/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import { getAuthContext } from "@/lib/auth/auth-api";
import { getAuthSessionSecret } from "@/lib/auth/secrets";
import { readSessionFromRequest } from "@/lib/auth/session";
import {
  getNangoHost,
  getProviderConfigKey,
} from "@/lib/integrations/nango-service";
import {
  WORKSPACE_INTEGRATION_PROVIDERS,
  type WorkspaceIntegrationProvider,
} from "@/lib/integrations/providers";
import { getWorkspaceIntegration } from "@/lib/integrations/workspace-integrations";
import { IntegrationsCatalog } from "./IntegrationsCatalog";

const PROVIDER_DESCRIPTIONS: Record<WorkspaceIntegrationProvider, string> = {
  github: "Connect the GitHub App OAuth integration used by Relayfile-backed repository views.",
  gitlab: "Connect GitLab OAuth to sync merge requests from selected projects.",
  x: "Connect X OAuth for capped social-search syncs into Relayfile.",
  slack: "Store the workspace Slack connection used for event handling and proactive messaging.",
  telegram: "Store the workspace Telegram bot connection used for rich bot messaging, commands, inline queries, callbacks, and reactions.",
  "slack-ricky": "Store the Ricky Slack connection used to run, monitor, and approve workflow repairs.",
  "slack-my-senior-dev": "Store the Senior Dev agent Slack connection for event handling and proactive messaging.",
  "slack-nightcto": "Store the NightCTO agent Slack connection for event handling and proactive messaging.",
  notion: "Store a workspace-scoped Notion connection for future document sync and agent access.",
  hubspot: "Store a workspace-scoped HubSpot connection for CRM object sync and writeback.",
  granola: "Store a workspace-scoped Granola connection for notes and folders sync.",
  fathom: "Store a workspace-scoped Fathom connection for meeting metadata, transcript, and summary sync.",
  "docker-hub": "Store a workspace-scoped Docker Hub connection for repository, tag, and webhook sync.",
  reddit: "Store a workspace-scoped Reddit connection for tracked-subreddit and post sync via Composio.",
  dropbox: "Store a workspace-scoped Dropbox connection for metadata-only files, folders, shared-folder, and shared-link sync.",
  daytona: "Store a workspace-scoped Daytona connection for hookdeck-delivered sandbox, snapshot, and volume webhooks.",
  gcp: "Store a workspace-scoped GCP connection for Cloud Run, Monitoring, Billing, and Error Reporting sync.",
  cloudflare: "Store a workspace-scoped Cloudflare connection for Workers, Pages, DNS, Notifications, and Hookdeck-delivered alert webhooks.",
  neon: "Store a workspace-scoped Neon connection for database project topology, operations, consumption, and advisor sync.",
  recall: "Store a workspace-scoped Recall connection for desktop recording upload and NB-Whisper transcription webhook delivery.",
  linear: "Store a workspace-scoped Linear connection for issue and project workflow access.",
  "linear-ricky": "Store the Ricky Linear app connection used for Linear Agent Session events and Agent Activities.",
  jira: "Store a workspace-scoped Jira connection for privacy-safe issue, project, sprint, and comment sync.",
  confluence: "Store a workspace-scoped Confluence connection for page and space sync.",
  "google-mail": "Store a workspace-scoped Google Mail connection for message, thread, label, filter, and alias sync.",
  "google-calendar": "Store a workspace-scoped Google Calendar connection for calendar, event, ACL, and settings sync.",
};

const PROVIDER_SETUP_INSTRUCTIONS: Partial<Record<WorkspaceIntegrationProvider, string[]>> = {
  telegram: [
    "Create a bot in @BotFather with /newbot, then use the bot token when connecting Telegram.",
    "Enable inline queries in @BotFather with /setinline, choose the bot, and enter the placeholder text users should see when they type @your_bot query.",
    "For group conversations, use /setprivacy in @BotFather and disable privacy mode only if the bot should receive regular group messages beyond commands, mentions, and replies.",
    "After connecting, configure bot commands, menu buttons, callbacks, reactions, and rich replies through the Telegram Bot API proxy.",
  ],
};

const PROVIDER_GROUPS: {
  title: string;
  description: string;
  providers: WorkspaceIntegrationProvider[];
}[] = [
  {
    title: "Sage",
    description: "Connections used by the Sage agent.",
    providers: ["slack", "telegram", "github", "gitlab", "hubspot", "docker-hub", "reddit", "x"],
  },
  {
    title: "Ricky",
    description: "Connections used by the Ricky workflow operator.",
    providers: ["slack-ricky", "linear-ricky"],
  },
  {
    title: "Senior Dev",
    description: "Connections used by the Senior Dev agent.",
    providers: ["slack-my-senior-dev"],
  },
  {
    title: "NightCTO",
    description: "Connections used by the NightCTO agent.",
    providers: ["slack-nightcto"],
  },
  {
    title: "Workspace",
    description: "Shared workspace-level connections.",
    providers: ["notion", "granola", "fathom", "dropbox", "daytona", "gcp", "cloudflare", "linear", "jira", "confluence", "google-mail", "google-calendar"],
  },
];

async function requireAuthContext() {
  const cookieStore = await cookies();
  const session = readSessionFromRequest(
    { cookies: cookieStore as never },
    getAuthSessionSecret(),
  );

  if (!session) {
    redirect("/");
  }

  return getAuthContext(session.userId, session.currentWorkspaceId);
}

export default async function IntegrationsPage() {
  const context = await requireAuthContext();
  const workspaceId = context.currentWorkspace.id;
  const nangoHost = getNangoHost();

  const integrations = await Promise.all(
    WORKSPACE_INTEGRATION_PROVIDERS.map(async (provider) => ({
      provider,
      integration: await getWorkspaceIntegration(workspaceId, provider),
      providerConfigKey: getProviderConfigKey(provider),
    })),
  );

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <Header />
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Workspace Integrations</CardTitle>
            <CardDescription>
              Connections are stored per workspace and created through server-issued Nango connect sessions.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3 text-sm text-[var(--muted-foreground)]">
            <Badge variant="info">{context.currentWorkspace.name}</Badge>
            <span>Manage GitHub, GitLab, Reddit, X, Slack, Telegram, Notion, Dropbox, Daytona, GCP, Cloudflare, Linear, Jira, Confluence, Google Mail, and Google Calendar connections for this workspace.</span>
          </CardContent>
        </Card>

        <IntegrationsCatalog
          workspaceId={workspaceId}
          nangoHost={nangoHost}
          providerGroups={PROVIDER_GROUPS}
          providerDescriptions={PROVIDER_DESCRIPTIONS}
          providerSetupInstructions={PROVIDER_SETUP_INSTRUCTIONS}
          initialEntries={integrations.map(({ provider, integration, providerConfigKey }) => ({
            provider,
            integration: integration
              ? {
                providerConfigKey: integration.providerConfigKey,
                connectionId: integration.connectionId,
                installationId: integration.installationId,
              }
              : null,
            providerConfigKey,
          }))}
        />
      </main>
    </div>
  );
}
