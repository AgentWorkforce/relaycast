"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import Nango from "@nangohq/frontend";
import {
  Activity,
  Bot,
  Building2,
  CalendarClock,
  Command,
  ExternalLink,
  Eye,
  Files,
  Flame,
  Monitor,
  Network,
  Plug,
  RefreshCcw,
  Server,
  ShieldCheck,
  Terminal,
  Users2,
  Workflow,
} from "lucide-react";
import type { AuthContext } from "@/lib/auth/types";
import {
  FLEET_SPAWNABLE_CLIS,
  withDispatchCapabilities,
} from "@/lib/proactive-runtime/spawnable-clis";
import { buildGoogleAuthHref } from "@/lib/auth/google-redirect";
import { toAppPath } from "@/lib/app-path";
import { GithubJoinRequestsCard } from "./github-join-requests-card";
import {
  joinGithubInstallation,
  readSessionToken,
  requestGithubConnectSession,
  resolveGithubInstallationBranch,
} from "@/app/deploy/_lib/github-installation-flow-client";
import {
  listWorkspaceIntegrationCatalogEntries,
  resolveWorkspaceIntegrationProvider,
  type WorkspaceIntegrationProviderDefinition,
} from "@/lib/integrations/providers";
import { cn } from "@/lib/utils";
import { ProviderLogo } from "../../components/ProviderLogo";
import { SageLogo } from "../../components/SageLogo";
import { RickyLogo } from "../../components/RickyLogo";
import { SlackLogo } from "../../components/SlackLogo";
import { GitHubLogo } from "../../components/GitHubLogo";
import { GitLabLogo } from "../../components/GitLabLogo";
import { LinearLogo } from "../../components/LinearLogo";
import { NotionLogo } from "../../components/NotionLogo";
import { XLogo } from "../../components/XLogo";
import { LogDisplay } from "../../components/LogDisplay";
import { Avatar, AvatarFallback, AvatarImage } from "../../components/ui/avatar";
import { Badge } from "../../components/ui/badge";
import { Button, buttonVariants } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useLogStream } from "../../components/useLogStream";
import { AgentCardThumbnail } from "./agent-card-thumbnail";
import {
  formatRelative,
  formatTimestamp,
  getAgentInputEntries,
  getAgentBadgeVariant,
  getRunBadgeVariant,
  getUserInitials,
  getWorkflowDetail,
  getWorkflowName,
  trimText,
} from "./dashboard-data";
import {
  type ConnectCommand,
  type AccountUsageSnapshot,
  type AccountUsageWindow,
  type DeployedAgent,
  type DeploymentFire,
  type DeploymentFireDetail,
  type WorkflowSchedule,
  type WorkflowRun,
  type WorkflowRunRickySupervisor,
  useDashboard,
} from "./dashboard-data";
import { SlackChannelPicker } from "./slack-channel-picker";
import { GitLabProjectPicker } from "./gitlab-project-picker";
import { RedditSubredditPicker } from "./reddit-subreddit-picker";
import { SageNotifyChannelPicker } from "../integrations/SageNotifyChannelPicker";

const NANGO_HOST = process.env.NEXT_PUBLIC_NANGO_HOST || "https://api.nango.dev";

function IntegrationToggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-[var(--border-default)] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--dashboard-panel)] disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "bg-primary shadow-[0_0_0_1px_var(--primary)]"
          : "bg-[var(--surface-soft)]",
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block size-[18px] transform rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.35)] ring-0 transition-transform duration-200",
          checked ? "translate-x-[22px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

function useNangoConnect(workspaceId: string) {
  async function requestSession(allowedIntegrations: string[]): Promise<string> {
    const res = await fetch(
      toAppPath(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/connect-session`),
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedIntegrations }),
      },
    );
    if (!res.ok) throw new Error("Failed to create connect session.");
    const payload = (await res.json()) as { token?: string };
    if (!payload.token) throw new Error("Failed to create connect session.");
    return payload.token;
  }

  async function openConnectUi(sessionToken: string) {
    const nango = new Nango();
    return await new Promise<{ connectionId: string; providerConfigKey?: string }>((resolve, reject) => {
      let settled = false;
      let connectResult: { connectionId: string; providerConfigKey?: string } | null = null;
      const connectUi = nango.openConnectUI({
        sessionToken,
        apiURL: NANGO_HOST,
        detectClosedAuthWindow: true,
        onEvent: (event) => {
          if (settled) return;
          if (event.type === "connect") {
            const rawEvent = event as { connectionId?: string; connection_id?: string; providerConfigKey?: string; provider_config_key?: string };
            const rawConnectionId = rawEvent.connectionId ?? rawEvent.connection_id;
            if (typeof rawConnectionId !== "string" || !rawConnectionId.trim()) {
              settled = true;
              connectUi.close();
              reject(new Error("Failed to read connection result."));
              return;
            }
            connectResult = {
              connectionId: rawConnectionId.trim(),
              providerConfigKey: rawEvent.providerConfigKey ?? rawEvent.provider_config_key,
            };
          }
          if (event.type === "error") {
            settled = true;
            connectUi.close();
            const errorPayload = event.payload as { errorMessage?: string } | undefined;
            reject(new Error(errorPayload?.errorMessage || "Connection failed."));
          }
          if (event.type === "close") {
            settled = true;
            if (connectResult) {
              resolve(connectResult);
            } else {
              reject(new Error("Connection dialog was closed."));
            }
          }
        },
      });
      connectUi.open();
    });
  }

  return { requestSession, openConnectUi };
}

function IntegrationToggleRow({
  workspaceId,
  provider,
  providerLabel,
  providerConfigKey,
  integration,
  onMutate,
  logo: LogoComponent,
  description,
}: {
  workspaceId: string;
  provider: string;
  providerLabel: string;
  providerConfigKey: string;
  integration: IntegrationRecord;
  onMutate: () => void;
  logo: React.ComponentType<{ className?: string }>;
  description: ReactNode;
}) {
  const connected = Boolean(integration?.connectionId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { requestSession, openConnectUi } = useNangoConnect(workspaceId);

  async function handleToggle() {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      if (connected) {
        const res = await fetch(
          toAppPath(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/${provider}`),
          { method: "DELETE", credentials: "include" },
        );
        if (!res.ok) throw new Error(`Failed to disconnect ${providerLabel}.`);
      } else {
        let sessionToken: string | null = null;
        if (provider === "github") {
          const branch = await resolveGithubInstallationBranch({
            workspaceId,
            providerConfigKey,
            openConnectUi,
          });
          if (branch.kind === "inherit") {
            const outcome = await joinGithubInstallation({
              workspaceId,
              installationId: branch.match.installationId,
              oauthConnectionId: branch.oauthConnectionId,
            });
            if (outcome.kind === "connected") {
              const destination =
                outcome.landingWorkspace.name ?? outcome.landingWorkspace.slug ?? "the organization workspace";
              setNotice(`Already connected via ${branch.match.accountLogin ?? "GitHub"}; landing in ${destination}.`);
              onMutate();
              return;
            }
            if (outcome.kind === "pending") {
              setNotice(`Join request sent for ${branch.match.accountLogin ?? "this GitHub organization"}.`);
              return;
            }
            if (outcome.kind === "ambiguous") {
              setNotice(`Already connected via ${branch.match.accountLogin ?? "GitHub"}; choose a destination workspace to continue.`);
              onMutate();
              return;
            }
            if (outcome.kind === "no_workspace") {
              setNotice(outcome.message);
              return;
            }
            throw new Error(outcome.message);
          }
          if (branch.kind === "disabled") {
            sessionToken = readSessionToken(branch.session);
          } else {
            const installSession = await requestGithubConnectSession({
              workspaceId,
              providerConfigKey,
            });
            sessionToken = readSessionToken(installSession);
          }
        }
        sessionToken ??= await requestSession([providerConfigKey]);
        const result = await openConnectUi(sessionToken);
        const res = await fetch(
          toAppPath(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/${provider}`),
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              connectionId: result.connectionId,
              providerConfigKey: result.providerConfigKey ?? providerConfigKey,
            }),
          },
        );
        if (!res.ok) throw new Error(`Failed to save ${providerLabel} connection.`);
      }
      onMutate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Failed to update ${providerLabel}.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <LogoComponent className="size-4" />
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {providerLabel}
            </h3>
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <IntegrationToggle checked={connected} onChange={handleToggle} disabled={pending} />
      </div>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
    </div>
  );
}

type DashboardPageFrameProps = {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function DashboardPageFrame({
  eyebrow,
  title,
  description,
  actions,
  children,
}: DashboardPageFrameProps) {
  return (
    <div className="mx-auto w-full min-w-0 max-w-[1700px] overflow-x-clip p-3 md:p-5">
      <div className="min-w-0 overflow-hidden rounded-[2rem] border border-[var(--dashboard-border)] bg-[var(--dashboard-canvas)] p-4 shadow-[0_32px_80px_-56px_var(--dashboard-shadow)] md:p-6 lg:p-7">
        <header className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-primary">
              {eyebrow}
            </p>
            <div className="flex flex-col gap-2">
              <h1 className="text-[1.9rem] font-semibold tracking-tight text-foreground md:text-[2.35rem]">
                {title}
              </h1>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
            </div>
          </div>
          {actions ? <div className="min-w-0 w-full xl:w-auto">{actions}</div> : null}
        </header>

        <div className="mt-6 flex min-w-0 flex-col gap-5">{children}</div>
      </div>
    </div>
  );
}

function WorkspaceSummaryCard({ authSession }: { authSession: { authenticated: true } & AuthContext }) {
  return (
    <Card className="rounded-[1.5rem] border-[var(--dashboard-border)] bg-card shadow-[0_18px_40px_-32px_var(--dashboard-shadow)]">
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between gap-4 py-2">
          <p className="whitespace-nowrap text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Active workspace
          </p>
          <Badge variant="default">Live</Badge>
        </div>
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-semibold text-foreground">{authSession.currentWorkspace.name}</p>
          <p className="text-sm text-muted-foreground">{authSession.currentOrganization.name}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function MetricCard({
  label,
  value,
  note,
  icon: Icon,
  valueClassName,
}: {
  label: string;
  value: string;
  note: string;
  icon: LucideIcon;
  valueClassName?: string;
}) {
  return (
    <Card className="min-w-0 rounded-[1.75rem] border-[var(--dashboard-border)] bg-card shadow-[0_18px_44px_-34px_var(--dashboard-shadow)]">
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-4">
        <div className="flex min-w-0 flex-col gap-2">
          <CardDescription className="truncate text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {label}
          </CardDescription>
          <CardTitle className={cn("truncate text-[1.85rem] leading-none", valueClassName)}>{value}</CardTitle>
        </div>
        <div className="flex size-10 items-center justify-center rounded-2xl bg-[var(--note-bg)] text-primary">
          <Icon />
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-6 text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  );
}

export function DashboardPanel({
  title,
  description,
  actions,
  children,
  className,
  contentClassName,
}: {
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Card
      className={cn(
        "min-w-0 rounded-[2rem] border-[var(--dashboard-border)] bg-[var(--dashboard-panel)] shadow-[0_28px_70px_-46px_var(--dashboard-shadow)]",
        className,
      )}
    >
      <CardHeader className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex flex-col gap-1">
          <CardTitle>{title}</CardTitle>
          <div className="text-sm text-[var(--text-secondary)]">{description}</div>
        </div>
        {actions ? <div className="min-w-0 w-full xl:w-auto">{actions}</div> : null}
      </CardHeader>
      <CardContent className={cn("flex min-w-0 flex-col gap-5", contentClassName)}>{children}</CardContent>
    </Card>
  );
}

function SurfaceTile({
  label,
  value,
  note,
  valueClassName,
}: {
  label: string;
  value: string;
  note: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-[1.5rem] border border-[var(--border-default)] bg-[var(--surface-soft)] p-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-3 text-base font-semibold text-foreground", valueClassName)}>{value}</p>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{note}</p>
    </div>
  );
}

function InsetSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-[1.5rem] border border-[var(--border-default)] bg-[var(--surface-soft)] p-5",
        className,
      )}
    >
      <div className="min-w-0 flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description ? <p className="text-sm leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      <div className="mt-4 flex min-w-0 flex-col gap-3">{children}</div>
    </div>
  );
}

function DashboardLoadingState({ title, description }: { title: string; description: string }) {
  return (
    <DashboardPageFrame
      eyebrow="Cloud dashboard"
      title={title}
      description={description}
    >
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Card key={index} className="rounded-[1.75rem] border-[var(--dashboard-border)] bg-card shadow-none">
            <CardHeader>
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-16" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-4 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6">
        <Card className="rounded-[2rem] border-[var(--dashboard-border)] bg-[var(--dashboard-panel)] shadow-none">
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-64" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-14 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    </DashboardPageFrame>
  );
}

function DashboardSignInState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <a
            href={buildGoogleAuthHref("/dashboard")}
            className={buttonVariants({ className: "w-full sm:w-auto" })}
          >
            Sign in with Google
          </a>
        </CardContent>
      </Card>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="h-3.5 w-3.5">
      <path
        d="M5.5 5.5V3.75C5.5 3.06 6.06 2.5 6.75 2.5h5.5c.69 0 1.25.56 1.25 1.25v5.5c0 .69-.56 1.25-1.25 1.25H10.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="2.5"
        y="5.5"
        width="8"
        height="8"
        rx="1.25"
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="h-3.5 w-3.5">
      <path
        d="M3.5 8.5 6.5 11.5 12.5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function getScheduleBadgeVariant(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "active") {
    return "success" as const;
  }
  if (normalized === "paused") {
    return "warning" as const;
  }
  if (normalized === "completed") {
    return "default" as const;
  }
  return "default" as const;
}

function formatScheduleCadence(schedule: WorkflowSchedule) {
  if (schedule.scheduleType === "cron") {
    return schedule.cronExpression ?? "cron";
  }
  return schedule.scheduledAt ? formatTimestamp(schedule.scheduledAt) : "once";
}

function InviteMemberDialog({
  open,
  onClose,
  invites,
  onInviteSent,
  onCancelInvite,
}: {
  open: boolean;
  onClose: () => void;
  invites: ReturnType<typeof useDashboard>["pendingInvites"];
  onInviteSent: () => void;
  onCancelInvite: (id: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  if (!open) {
    return null;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch(toAppPath("/api/v1/invites"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, role }),
      });

      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(data?.error ?? "Failed to send invite");
        return;
      }

      setSuccess(`Invitation sent to ${email}`);
      setEmail("");
      onInviteSent();
    } catch {
      setError("Failed to send invite");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close invite dialog"
        className="absolute inset-0 bg-[var(--overlay)] backdrop-blur-sm"
        onClick={onClose}
      />
      <Card className="relative z-10 max-h-[85vh] w-full max-w-lg overflow-hidden">
        <CardHeader className="border-b border-[var(--border-default)] bg-[var(--surface-strong)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Invite members</CardTitle>
              <CardDescription>
                Invite people to your organization by email.
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </CardHeader>
        <CardContent className="max-h-[calc(85vh-96px)] space-y-6 overflow-y-auto p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="colleague@example.com"
                required
                className="flex-1 rounded-full border border-[var(--border-default)] bg-[var(--surface-soft)] px-4 py-2.5 text-sm text-[var(--foreground)] placeholder:text-[var(--text-muted)] outline-none transition-colors focus:border-[var(--border-strong)]"
              />
              <select
                value={role}
                onChange={(event) => setRole(event.target.value)}
                className="rounded-full border border-[var(--border-default)] bg-[var(--surface-soft)] px-4 py-2.5 text-sm text-[var(--foreground)] outline-none transition-colors focus:border-[var(--border-strong)]"
              >
                <option value="member">Member</option>
                <option value="owner">Owner</option>
              </select>
            </div>
            <Button type="submit" disabled={sending} className="w-full">
              {sending ? "Sending..." : "Send invitation"}
            </Button>
            {error ? <p className="text-sm text-[var(--status-danger)]">{error}</p> : null}
            {success ? <p className="text-sm text-[var(--status-success)]">{success}</p> : null}
          </form>

          {invites.length > 0 ? (
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-[var(--foreground)]">Pending invitations</h3>
              {invites.map((invite) => (
                <div
                  key={invite.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] p-3"
                >
                  <div>
                    <p className="text-sm text-[var(--foreground)]">{invite.email}</p>
                    <p className="text-xs text-[var(--text-muted)]">
                      {invite.role} • expires {formatTimestamp(invite.expiresAt)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[var(--text-secondary)] hover:text-[var(--status-danger)]"
                    onClick={() => onCancelInvite(invite.id)}
                  >
                    Cancel
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function ConnectAgentDialog({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: ConnectCommand[];
}) {
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close connect agent dialog"
        className="absolute inset-0 bg-[var(--overlay)] backdrop-blur-sm"
        onClick={() => {
          setCopiedCommand(null);
          onClose();
        }}
      />
      <Card className="relative z-10 max-h-[85vh] w-full max-w-3xl overflow-hidden">
        <CardHeader className="border-b border-[var(--border-default)] bg-[var(--surface-strong)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Connect agent</CardTitle>
              <CardDescription>
                Run `npx agent-relay cloud login` first if you want to establish the cloud session
                explicitly. The provider commands below will also trigger that login flow
                automatically if needed, then drop you into the provider auth session.
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCopiedCommand(null);
                onClose();
              }}
            >
              Close
            </Button>
          </div>
        </CardHeader>
        <CardContent className="max-h-[calc(85vh-96px)] space-y-4 overflow-y-auto p-6">
          {commands.map((command) => (
            <div
              key={command.provider}
              className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-card)] p-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-[var(--foreground)]">{command.label}</p>
                    <Badge variant="default">{command.cli}</Badge>
                  </div>
                  <p className="text-sm text-[var(--text-secondary)]">{command.note}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    await navigator.clipboard.writeText(command.command);
                    setCopiedCommand(command.command);
                  }}
                >
                  {copiedCommand === command.command ? "Copied" : "Copy command"}
                </Button>
              </div>
              <div className="mt-4 rounded-xl border border-[var(--code-border)] bg-[var(--code-bg)] p-4">
                <code className="block overflow-x-auto font-mono text-sm text-[var(--code-keyword)]">
                  {command.command}
                </code>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function getTightestUsageWindow(usage: AccountUsageSnapshot): AccountUsageWindow | null {
  return usage.windows
    .filter((window) => Number.isFinite(window.remainingPercent))
    .sort((left, right) => left.remainingPercent - right.remainingPercent)[0] ?? null;
}

function formatUsagePercent(value: number) {
  return `${Math.round(value)}%`;
}

function AccountUsageMeter({ usage }: { usage: AccountUsageSnapshot }) {
  if (usage.status === "unsupported") {
    return null;
  }

  const window = usage.status === "available" ? getTightestUsageWindow(usage) : null;
  if (!window) {
    return (
      <div className="mt-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium text-foreground">Account usage</span>
          <Badge variant={usage.status === "error" ? "danger" : "default"}>
            {usage.status === "error" || usage.status === "unavailable" ? "Unavailable" : "No quota"}
          </Badge>
        </div>
        {usage.error ? (
          <p className="mt-2 break-words text-xs text-muted-foreground">{trimText(usage.error, 160)}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Account usage
          </p>
          <p className="mt-1 truncate text-sm font-medium text-foreground">
            {formatUsagePercent(window.remainingPercent)} left
          </p>
        </div>
        <div className="min-w-0 text-right">
          <p className="truncate text-sm text-foreground">{window.label}</p>
          <p className="truncate text-xs text-muted-foreground">
            {window.resetAt ? `Resets ${formatTimestamp(window.resetAt)}` : "Reset not reported"}
          </p>
        </div>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-card)]">
        <div
          className="h-full rounded-full bg-[var(--foreground)]"
          style={{ width: `${Math.max(0, Math.min(100, window.usedPercent))}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{formatUsagePercent(window.usedPercent)} used</span>
        {usage.plan ? <span className="truncate">{usage.plan}</span> : null}
      </div>
    </div>
  );
}

export function WorkflowsPageView() {
  const {
    activeSchedules,
    agents,
    authSession,
    authenticated,
    failedRuns,
    healthyAgents,
    latestRun,
    loadingData,
    organizationSchedules,
    sessionLoading,
    totalSchedules,
    totalRuns,
    organizationRuns,
    activeRuns,
  } = useDashboard();
  const [copiedRunId, setCopiedRunId] = useState<string | null>(null);

  if (sessionLoading || (authenticated && loadingData)) {
    return (
      <DashboardLoadingState
        title="Workflows"
        description="Loading workflow history and organization health."
      />
    );
  }

  if (!authenticated || !authSession) {
    return (
      <DashboardSignInState
        title="Sign in to open workflows"
        description="Google auth lands directly in the cloud dashboard so you can review workflow runs without another navigation step."
      />
    );
  }

  const handleCopyRunId = async (runId: string) => {
    await navigator.clipboard.writeText(runId);
    setCopiedRunId(runId);
    window.setTimeout(() => {
      setCopiedRunId((current) => (current === runId ? null : current));
    }, 1500);
  };

  return (
    <>
      <DashboardPageFrame
        eyebrow="Cloud dashboard"
        title="Workflows"
        description="Review the latest workflow executions, inspect run health, and move from overview to logs without leaving the main dashboard canvas."
        actions={<WorkspaceSummaryCard authSession={authSession} />}
      >
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Workflow runs"
            value={String(totalRuns)}
            note="All executions recorded in the current organization."
            icon={Workflow}
          />
          <MetricCard
            label="Active runs"
            value={String(activeRuns)}
            note={activeRuns > 0 ? "Polling every 10 seconds for live updates." : "No runs are executing right now."}
            icon={Activity}
          />
          <MetricCard
            label="Cloud agents"
            value={String(agents.length)}
            note={agents.length > 0 ? `${healthyAgents} agents are currently healthy.` : "No agents are connected yet."}
            icon={Users2}
          />
          <MetricCard
            label="Schedules"
            value={String(totalSchedules)}
            note={activeSchedules > 0 ? `${activeSchedules} schedules are active.` : "No schedules are active."}
            icon={CalendarClock}
          />
        </section>

        <DashboardPanel
          title="Scheduled workflows"
          description={`Repeatable workflow launches for ${authSession.currentOrganization.name}.`}
          actions={<Badge variant={activeSchedules > 0 ? "info" : "default"}>{activeSchedules} active</Badge>}
          contentClassName="gap-4"
        >
          {organizationSchedules.length === 0 ? (
            <div className="flex min-h-[10rem] items-center justify-center rounded-[1.5rem] border border-dashed border-[var(--border-strong)] bg-[var(--surface-soft)] px-6 text-center text-sm text-muted-foreground">
              No workflow schedules have been created for this organization yet.
            </div>
          ) : (
            <div className="overflow-hidden rounded-[1.5rem] border border-[var(--border-default)] bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Schedule</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Cadence</TableHead>
                    <TableHead>Last run</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {organizationSchedules.map((schedule) => (
                    <TableRow key={schedule.id}>
                      <TableCell className="min-w-[18rem]">
                        <div className="flex flex-col gap-1">
                          <div className="font-medium text-foreground">{schedule.name}</div>
                          {schedule.description ? (
                            <div className="text-sm text-muted-foreground">
                              {trimText(schedule.description, 120)}
                            </div>
                          ) : (
                            <div className="font-mono text-xs text-muted-foreground">
                              {trimText(schedule.id, 18)}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={getScheduleBadgeVariant(schedule.status)}>{schedule.status}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <div className="font-mono text-sm text-foreground">
                            {formatScheduleCadence(schedule)}
                          </div>
                          <div className="text-xs text-muted-foreground">{schedule.timezone}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {schedule.lastTriggeredRunId ? (
                          <Link
                            href={`/dashboard/workflow/${encodeURIComponent(schedule.lastTriggeredRunId)}/runner`}
                            className="text-sm font-medium text-primary hover:underline"
                          >
                            {formatRelative(schedule.lastTriggeredAt)}
                          </Link>
                        ) : schedule.lastTriggeredAt ? (
                          <div className="flex flex-col gap-1">
                            <span
                              className={
                                schedule.lastTriggerStatus === "failed"
                                  ? "text-sm font-medium text-destructive"
                                  : "text-sm font-medium text-foreground"
                              }
                              title={schedule.lastTriggerError ?? undefined}
                            >
                              {schedule.lastTriggerStatus === "failed" ? "Launch failed" : "No run created"}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {formatRelative(schedule.lastTriggeredAt)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-sm text-muted-foreground">Not fired yet</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <div>{formatTimestamp(schedule.createdAt)}</div>
                          <div className="text-xs text-muted-foreground">
                            {formatRelative(schedule.createdAt)}
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DashboardPanel>

        <DashboardPanel
          title="Workflow history"
          description={`Every workflow run for ${authSession.currentOrganization.name}, ordered from newest to oldest.`}
          actions={
            <Badge variant={failedRuns > 0 ? "danger" : "default"}>
              {failedRuns > 0 ? `${failedRuns} failed runs` : "No failures"}
            </Badge>
          }
          className="min-h-[40rem]"
          contentClassName="gap-6"
        >
          <div className="grid gap-4 xl:grid-cols-3">
            <SurfaceTile
              label="Latest run"
              value={latestRun ? getWorkflowName(latestRun) : "No runs yet"}
              note={
                latestRun ? `Updated ${formatRelative(latestRun.updatedAt)}.` : "The first workflow execution will appear here."
              }
            />
            <SurfaceTile
              label="Latest sandbox"
              value={latestRun?.sandboxId ? trimText(latestRun.sandboxId, 18) : "Not available"}
              valueClassName="font-mono text-sm"
              note={
                latestRun?.sandboxId ? `Created ${formatTimestamp(latestRun.createdAt)}.` : "A sandbox appears after the first successful launch."
              }
            />
            <SurfaceTile
              label="Workforce"
              value={`${healthyAgents} healthy agents`}
              note={
                agents.length > 0 ? `${agents.length} agents are connected to this workspace.` : "Connect agents from Workforce to start running jobs."
              }
            />
          </div>

          {organizationRuns.length === 0 ? (
            <div className="flex min-h-[18rem] items-center justify-center rounded-[1.5rem] border border-dashed border-[var(--border-strong)] bg-[var(--surface-soft)] px-6 text-center text-sm text-muted-foreground">
              No workflow runs have been recorded for this organization yet.
            </div>
          ) : (
            <div className="overflow-hidden rounded-[1.5rem] border border-[var(--border-default)] bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workflow</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Run ID</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="w-[120px] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {organizationRuns.map((run) => (
                    <TableRow key={run.runId}>
                      <TableCell className="min-w-[18rem]">
                        <div className="flex flex-col gap-1">
                          <div className="font-medium text-foreground">{getWorkflowName(run)}</div>
                          {getWorkflowDetail(run) ? (
                            <div className="text-sm text-muted-foreground">{getWorkflowDetail(run)}</div>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={getRunBadgeVariant(run.status)}>{run.status}</Badge>
                      </TableCell>
                      <TableCell className="uppercase text-muted-foreground">{run.fileType}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-soft)] px-3 py-2">
                          <div className="min-w-0">
                            <div className="font-mono text-xs text-foreground">
                              {trimText(run.runId, 16)}
                            </div>
                            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                              Run identifier
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="rounded-full"
                            onClick={() => {
                              void handleCopyRunId(run.runId);
                            }}
                            aria-label={`Copy run ID ${run.runId}`}
                            title={copiedRunId === run.runId ? "Copied" : "Copy run ID"}
                          >
                            {copiedRunId === run.runId ? <CheckIcon /> : <CopyIcon />}
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <div>{formatTimestamp(run.updatedAt)}</div>
                          <div className="text-xs text-muted-foreground">
                            {formatRelative(run.updatedAt)}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          href={`/dashboard/workflow/${encodeURIComponent(run.runId)}/runner`}
                          className={buttonVariants({ variant: "outline", size: "sm" })}
                        >
                          View logs
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DashboardPanel>
      </DashboardPageFrame>
    </>
  );
}

type RunStep = {
  stepName: string;
  agent: string;
  preset: string;
  cli: string;
  sandboxId: string;
};

type WorkflowRunPageViewProps = {
  runId: string;
  initialSandboxId?: string | null;
};

function extractWorkflowAgents(workflowConfig: string) {
  try {
    const parsed: unknown = JSON.parse(workflowConfig);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const agents = (parsed as Record<string, unknown>).agents;
      if (Array.isArray(agents)) {
        return agents
          .map((agent) => (agent && typeof agent === "object" ? (agent as Record<string, unknown>).name : null))
          .filter((name): name is string => typeof name === "string" && Boolean(name));
      }
    }
  } catch {
    // not JSON
  }

  const yamlAgents = [...workflowConfig.matchAll(/^\s*-\s+name:\s*["']?([^\n"']+)/gm)].map(
    (match) => match[1]?.trim() ?? "",
  );
  if (yamlAgents.length > 0) {
    return yamlAgents.filter(Boolean);
  }

  const tsAgents = [...workflowConfig.matchAll(/\.agent\(\s*["'`]([^"'`]+)["'`]/g)].map(
    (match) => match[1]?.trim() ?? "",
  );
  return tsAgents.filter(Boolean);
}

export function WorkflowRunPageView({ runId, initialSandboxId = null }: WorkflowRunPageViewProps) {
  const { authSession, authenticated, loadingData, organizationRuns, sessionLoading } = useDashboard();
  const [run, setRun] = useState(() => organizationRuns.find((item) => item.runId === runId) ?? null);
  const [runLoading, setRunLoading] = useState(() => !organizationRuns.some((item) => item.runId === runId));
  const [runError, setRunError] = useState<string | null>(null);
  // Track whether the current `run` came from the detail endpoint. The list
  // payload (organizationRuns) lacks Ricky supervisor context, so we always
  // fetch detail and refuse to clobber a detail-fetched run with the list one.
  const [runDetailLoaded, setRunDetailLoaded] = useState(false);
  const [steps, setSteps] = useState<RunStep[]>([]);
  const [stepsLoading, setStepsLoading] = useState(true);
  const [stepsError, setStepsError] = useState<string | null>(null);

  useEffect(() => {
    if (runDetailLoaded) {
      return;
    }
    const existingRun = organizationRuns.find((item) => item.runId === runId) ?? null;
    if (!existingRun) {
      return;
    }

    setRun(existingRun);
    setRunError(null);
  }, [organizationRuns, runId, runDetailLoaded]);

  useEffect(() => {
    if (!authenticated || !authSession) {
      return;
    }

    let active = true;
    setRunLoading(true);
    setRunError(null);

    fetch(toAppPath(`/api/v1/workflows/runs/${runId}`), {
      cache: "no-store",
      credentials: "include",
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | (WorkflowRun & { error?: string })
          | { error?: string }
          | null;

        if (!response.ok) {
          throw new Error(payload?.error ?? "Failed to load workflow run");
        }

        if (!active) {
          return;
        }

        setRun((payload as WorkflowRun) ?? null);
        setRunDetailLoaded(true);
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        setRunError(error instanceof Error ? error.message : "Failed to load workflow run");
      })
      .finally(() => {
        if (active) {
          setRunLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [authSession, authenticated, runId]);

  useEffect(() => {
    if (!authenticated || !authSession) {
      setSteps([]);
      setStepsLoading(false);
      setStepsError(null);
      return;
    }

    let active = true;
    setStepsLoading(true);
    setStepsError(null);

    fetch(toAppPath(`/api/v1/workflows/runs/${runId}/steps`), {
      cache: "no-store",
      credentials: "include",
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as { steps?: RunStep[]; error?: string } | null;
        if (!response.ok) {
          throw new Error(payload?.error ?? "Failed to fetch steps");
        }

        if (!active) {
          return;
        }

        const nextSteps = Array.isArray(payload?.steps)
          ? payload.steps.filter((step): step is RunStep => Boolean(step?.sandboxId))
          : [];
        setSteps(nextSteps);
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        setSteps([]);
        setStepsError(error instanceof Error ? error.message : "Failed to fetch steps");
      })
      .finally(() => {
        if (active) {
          setStepsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [authSession, authenticated, runId]);

  const resolvedRun = run ?? organizationRuns.find((item) => item.runId === runId) ?? null;
  const workflowAgents = useMemo(
    () => (resolvedRun ? extractWorkflowAgents(resolvedRun.workflow) : []),
    [resolvedRun],
  );
  const resolvedSteps = useMemo(
    () =>
      steps.map((step, index) => ({
        ...step,
        displayAgent:
          step.agent.trim() || workflowAgents[index] || step.stepName.trim() || `Agent ${index + 1}`,
      })),
    [steps, workflowAgents],
  );
  const selectedSandboxId =
    initialSandboxId && resolvedSteps.some((step) => step.sandboxId === initialSandboxId)
      ? initialSandboxId
      : null;
  const isRunnerRoute = selectedSandboxId === null;
  const selectedStep = selectedSandboxId
    ? resolvedSteps.find((step) => step.sandboxId === selectedSandboxId) ?? null
    : null;

  const runnerLogs = useLogStream(runId);
  const agentLogs = useLogStream(
    runId,
    selectedStep?.sandboxId,
    2_000,
    Boolean(selectedStep?.sandboxId),
  );

  if (sessionLoading || (authenticated && loadingData) || (authenticated && runLoading)) {
    return (
      <DashboardLoadingState
        title="Workflow run"
        description="Loading workflow run details and logs."
      />
    );
  }

  if (!authenticated || !authSession) {
    return (
      <DashboardSignInState
        title="Sign in to view workflow runs"
        description="Workflow run routes live inside the cloud dashboard so shared links land directly on the run you want to inspect."
      />
    );
  }

  if (!resolvedRun) {
    return (
      <DashboardPageFrame
        eyebrow="Cloud dashboard"
        title="Workflow run not found"
        description={runError ?? "This workflow run is unavailable or you no longer have access to it."}
        actions={<WorkspaceSummaryCard authSession={authSession} />}
      >
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className={buttonVariants({ variant: "outline" })}>
            Back to workflows
          </Link>
        </div>
      </DashboardPageFrame>
    );
  }

  return (
    <DashboardPageFrame
      eyebrow="Cloud dashboard"
      title={getWorkflowName(resolvedRun)}
      description="Inspect the runner log and jump directly into agent sandboxes with shareable app routes."
      actions={<WorkspaceSummaryCard authSession={authSession} />}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/dashboard" className={buttonVariants({ variant: "outline" })}>
          Back to workflows
        </Link>
        <Badge variant={getRunBadgeVariant(resolvedRun.status)}>{resolvedRun.status}</Badge>
        <Badge variant="default" className="font-mono">{trimText(resolvedRun.runId, 20)}</Badge>
        {resolvedRun.rickyRun ? (
          <Badge
            variant="info"
            className="flex items-center gap-1.5"
            title="Supervised by Ricky cloud auto-fix"
          >
            <RickyLogo className="h-4 w-4" />
            Ricky · {resolvedRun.rickyRun.status}
          </Badge>
        ) : null}
      </div>

      {resolvedRun.rickyRun ? (
        <SupervisorPanel supervisor={resolvedRun.rickyRun} />
      ) : null}

      <section className="grid gap-4 md:grid-cols-3">
        <SurfaceTile
          label="Run ID"
          value={trimText(resolvedRun.runId, 24)}
          note="Direct app route for this workflow run."
          valueClassName="font-mono text-sm"
        />
        <SurfaceTile
          label="Updated"
          value={formatTimestamp(resolvedRun.updatedAt)}
          note={formatRelative(resolvedRun.updatedAt)}
        />
        <SurfaceTile
          label="Sandbox"
          value={resolvedRun.sandboxId ? trimText(resolvedRun.sandboxId, 18) : "Not available"}
          note={resolvedRun.sandboxId ? "Primary sandbox recorded for the run." : "No sandbox is recorded for this run yet."}
          valueClassName="font-mono text-sm"
        />
      </section>

      <DashboardPanel
        title="Workflow logs"
        description="Each section now has its own route, so refreshing or sharing keeps the same workflow context."
        contentClassName="gap-6"
      >
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/dashboard/workflow/${encodeURIComponent(runId)}/runner`}
            className={buttonVariants({ variant: isRunnerRoute ? "default" : "outline", size: "sm" })}
          >
            Runner log
          </Link>
          {resolvedSteps.map((step) => (
            <Link
              key={step.sandboxId}
              href={`/dashboard/workflow/${encodeURIComponent(runId)}/agent/${encodeURIComponent(step.sandboxId)}`}
              className={buttonVariants({
                variant: selectedSandboxId === step.sandboxId ? "default" : "outline",
                size: "sm",
              })}
            >
              {step.displayAgent}
            </Link>
          ))}
        </div>

        <InsetSection
          title="Runner log"
          description="Orchestrator output for this workflow run."
        >
          {runnerLogs.error ? (
            <div className="rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] px-4 py-3 text-sm text-[var(--status-danger)]">
              {runnerLogs.error}
            </div>
          ) : null}
          <RunLogPanel content={runnerLogs.content} isLoading={runnerLogs.isLoading} isDone={runnerLogs.isDone} />
        </InsetSection>

        <InsetSection
          title="Agent logs"
          description="Each discovered sandbox has its own nested route under this workflow run."
        >
          {stepsError ? (
            <div className="rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] px-4 py-3 text-sm text-[var(--status-danger)]">
              {stepsError}
            </div>
          ) : null}

          {selectedStep ? (
            <>
              <div className="rounded-xl border border-[var(--border-default)] bg-card px-4 py-3 text-sm text-[var(--text-secondary)]">
                {selectedStep.stepName} · {selectedStep.cli} · {selectedStep.preset}
              </div>
              {agentLogs.error ? (
                <div className="rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] px-4 py-3 text-sm text-[var(--status-danger)]">
                  {agentLogs.error}
                </div>
              ) : null}
              <RunLogPanel content={agentLogs.content} isLoading={agentLogs.isLoading} isDone={agentLogs.isDone} />
            </>
          ) : stepsLoading ? (
            <div className="rounded-xl border border-[var(--border-default)] bg-card px-4 py-6 text-sm text-[var(--text-muted)]">
              Loading agent routes...
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-[var(--border-soft)] bg-card px-4 py-6 text-sm text-[var(--text-muted)]">
              No agent logs are available for this workflow run.
            </div>
          )}
        </InsetSection>
      </DashboardPanel>
    </DashboardPageFrame>
  );
}

function RunLogPanel({
  content,
  isLoading,
  isDone,
}: {
  content: string;
  isLoading: boolean;
  isDone: boolean;
}) {
  return <LogDisplay content={content} isLoading={isLoading} isDone={isDone} />;
}

function SupervisorPanel({ supervisor }: { supervisor: WorkflowRunRickySupervisor }) {
  const diagnosisSummary =
    typeof supervisor.latestDiagnosis?.summary === "string"
      ? (supervisor.latestDiagnosis.summary as string)
      : null;
  const diagnosisClassification =
    typeof supervisor.latestDiagnosis?.classification === "string"
      ? (supervisor.latestDiagnosis.classification as string)
      : null;

  return (
    <DashboardPanel
      title={
        <span className="flex items-center gap-2">
          <RickyLogo className="h-5 w-5" />
          Ricky cloud auto-fix
        </span>
      }
      description="This run is supervised by Ricky. Attempts, diagnoses, and any open human gates are listed below."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="default" className="font-mono">{trimText(supervisor.id, 20)}</Badge>
          <Badge variant="info">{supervisor.status}</Badge>
          <Badge variant="default">
            attempt {supervisor.currentAttempt} / {supervisor.maxAttempts}
          </Badge>
        </div>
      }
    >
      {diagnosisSummary ? (
        <InsetSection title="Latest diagnosis" description={diagnosisClassification ?? undefined}>
          <p className="text-sm leading-6 text-foreground">{diagnosisSummary}</p>
        </InsetSection>
      ) : null}

      <InsetSection title="Attempts" description={`${supervisor.attempts.length} on record`}>
        {supervisor.attempts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No attempts recorded yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Repair mode</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Workflow run</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {supervisor.attempts.map((attempt) => (
                <TableRow key={`${attempt.attempt}-${attempt.workflowRunId}`}>
                  <TableCell>{attempt.attempt}</TableCell>
                  <TableCell>{attempt.role}</TableCell>
                  <TableCell>{attempt.repairMode}</TableCell>
                  <TableCell>
                    <Badge variant={getRunBadgeVariant(attempt.status)}>{attempt.status}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <Link
                      href={`/dashboard/workflow/${encodeURIComponent(attempt.workflowRunId)}/runner`}
                      className="underline underline-offset-2"
                    >
                      {trimText(attempt.workflowRunId, 18)}
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </InsetSection>

      {supervisor.gates.length > 0 ? (
        <InsetSection
          title="Open gates"
          description="Human review needed before Ricky can continue. Resolve via the Ricky API."
        >
          <ul className="flex flex-col gap-3">
            {supervisor.gates.map((gate) => (
              <li
                key={gate.id}
                className="rounded-xl border border-[var(--status-warning)] bg-[var(--status-warning-soft)] px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="warning">{gate.gateType}</Badge>
                  <Badge variant="default">{gate.status}</Badge>
                  <span className="font-mono text-xs text-muted-foreground">{trimText(gate.id, 16)}</span>
                </div>
                <p className="mt-2 font-medium text-foreground">{gate.reason}</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{gate.prompt}</p>
              </li>
            ))}
          </ul>
        </InsetSection>
      ) : null}
    </DashboardPanel>
  );
}

function getFireBadgeVariant(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "succeeded" || normalized === "success") return "success" as const;
  if (normalized === "running" || normalized === "starting") return "info" as const;
  if (normalized === "failed" || normalized === "error") return "danger" as const;
  return "default" as const;
}

function formatDuration(durationMs: number | null | undefined) {
  if (!durationMs || durationMs < 0) return "0 ms";
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function cleanupStatusLabel(cleanupStatus: Record<string, unknown>) {
  if (cleanupStatus.mountConfigured === false) return "No mount";
  if (cleanupStatus.scriptCompleted !== true) return "Unknown";
  if (cleanupStatus.flushExitCode === 0 && (cleanupStatus.killExitCode === 0 || cleanupStatus.killExitCode === null)) {
    return "Clean";
  }
  return "Check output";
}

async function fetchDashboardJson<T>(url: string, fallbackMessage: string): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "include",
  });
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | { error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? fallbackMessage);
  }
  if (!payload) {
    throw new Error(fallbackMessage);
  }
  return payload as T;
}

function FireOutputDialog({
  deployment,
  onClose,
}: {
  deployment: DeploymentFireDetail | null;
  onClose: () => void;
}) {
  if (!deployment) return null;
  const compressedSummary = deployment.compressedAt
    ? deployment.summary ?? (deployment.stdout || "Run output compressed after retention window.")
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close fire output dialog"
        className="absolute inset-0 bg-[var(--overlay)] backdrop-blur-sm"
        onClick={onClose}
      />
      <Card className="relative z-10 max-h-[86vh] w-full max-w-5xl overflow-hidden">
        <CardHeader className="border-b border-[var(--border-default)] bg-[var(--surface-strong)]">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Terminal className="size-5" />
                Fire output
              </CardTitle>
              <CardDescription className="mt-1 flex flex-col gap-1 font-mono text-xs">
                <span>Run {deployment.id}</span>
                <span>Deployment {deployment.deploymentId}</span>
                <span>{formatTimestamp(deployment.startedAt)}</span>
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </CardHeader>
        <CardContent className="max-h-[calc(86vh-96px)] overflow-y-auto p-6">
          <div className="grid gap-3 md:grid-cols-4">
            <SurfaceTile label="Status" value={deployment.status} note={`Exit ${deployment.exitCode ?? "unknown"}`} />
            <SurfaceTile label="Duration" value={formatDuration(deployment.durationMs)} note={formatTimestamp(deployment.startedAt)} />
            <SurfaceTile label="Sandbox" value={deployment.sandboxName ?? deployment.sandboxId ?? "Unknown"} note={deployment.eventSource} />
            <SurfaceTile label="Cleanup" value={cleanupStatusLabel(deployment.cleanupStatus)} note={deployment.mountLogTail ? "Mount log captured" : "No mount log"} />
          </div>
          {deployment.error ? (
            <div className="mt-5 rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] p-4 text-sm text-[var(--status-danger)]">
              {deployment.error}
            </div>
          ) : null}
          {compressedSummary ? (
            <div className="mt-5 rounded-xl border border-[var(--border-default)] bg-[var(--surface-muted)] p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                <span>Compressed summary</span>
                <span>{formatTimestamp(deployment.compressedAt)}</span>
              </div>
              <p className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground">
                {compressedSummary}
              </p>
            </div>
          ) : null}
          <div className="mt-5 grid gap-4">
            {[
              { label: "stdout", value: deployment.stdout, truncated: deployment.stdoutTruncated, hint: null },
              { label: "stderr", value: deployment.stderr, truncated: deployment.stderrTruncated, hint: null },
              { label: "mount log", value: deployment.mountLogTail, truncated: false, hint: "Last 64 KiB / 200 lines" },
            ].map(({ label, value, truncated, hint }) => (
              <div key={label} className="rounded-xl border border-[var(--code-border)] bg-[var(--code-bg)]">
                <div className="flex items-center justify-between gap-3 border-b border-[var(--code-border)] px-4 py-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  <span>{label}</span>
                  {truncated || hint ? <span>{truncated ? "Truncated" : hint}</span> : null}
                </div>
                <pre className="max-h-[22rem] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-foreground">
                  {String(value || "No output captured.")}
                </pre>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ProactiveFiresSection({ agents }: { agents: DeployedAgent[] }) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(agents[0]?.agentId ?? null);
  const [fires, setFires] = useState<DeploymentFire[]>([]);
  const [loading, setLoading] = useState(false);
  const [firesError, setFiresError] = useState<string | null>(null);
  const [selectedOutput, setSelectedOutput] = useState<DeploymentFireDetail | null>(null);
  const [outputError, setOutputError] = useState<string | null>(null);
  const [loadingOutputId, setLoadingOutputId] = useState<string | null>(null);

  useEffect(() => {
    if (!agents.some((agent) => agent.agentId === selectedAgentId)) {
      setSelectedAgentId(agents[0]?.agentId ?? null);
    }
  }, [agents, selectedAgentId]);

  useEffect(() => {
    if (!selectedAgentId) {
      setFires([]);
      setFiresError(null);
      return;
    }
    let active = true;
    setLoading(true);
    setFiresError(null);
    fetchDashboardJson<{ runs?: DeploymentFire[] }>(
      toAppPath(`/api/v1/agents/${encodeURIComponent(selectedAgentId)}/runs`),
      "Failed to load fires.",
    )
      .then((payload) => {
        if (active) setFires(Array.isArray(payload.runs) ? payload.runs : []);
      })
      .catch((error: unknown) => {
        if (active) {
          setFires([]);
          setFiresError(error instanceof Error ? error.message : "Failed to load fires.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedAgentId]);

  const selectedAgent = agents.find((agent) => agent.agentId === selectedAgentId) ?? null;
  const openOutput = async (fire: DeploymentFire) => {
    setOutputError(null);
    setLoadingOutputId(fire.id);
    try {
      const payload = await fetchDashboardJson<{ run?: DeploymentFireDetail }>(
        toAppPath(`/api/v1/agents/${encodeURIComponent(fire.agentId)}/runs/${encodeURIComponent(fire.id)}`),
        "Failed to load fire output.",
      );
      if (payload.run) {
        setSelectedOutput(payload.run);
        return;
      }
      setOutputError("Fire output was not found.");
    } catch (error) {
      setOutputError(error instanceof Error ? error.message : "Failed to load fire output.");
    } finally {
      setLoadingOutputId(null);
    }
  };

  return (
    <>
      <InsetSection title="Fires" description="Recent proactive runtime dispatches for deployed personas.">
        {agents.length === 0 ? (
          <div className="flex min-h-[12rem] items-center justify-center rounded-[1.25rem] border border-dashed border-[var(--border-strong)] bg-card px-6 text-center text-sm text-muted-foreground">
            No deployed personas are active in this workspace yet.
          </div>
        ) : (
          <>
            <div role="tablist" aria-label="Deployed persona fires" className="flex gap-2 overflow-x-auto pb-1">
              {agents.map((agent) => (
                <button
                  key={agent.agentId}
                  type="button"
                  role="tab"
                  aria-selected={selectedAgentId === agent.agentId}
                  onClick={() => setSelectedAgentId(agent.agentId)}
                  className={cn(
                    "shrink-0 rounded-full border px-3 py-1.5 text-sm transition-colors",
                    selectedAgentId === agent.agentId
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-[var(--border-default)] bg-card text-foreground hover:border-[var(--border-strong)]",
                  )}
                >
                  {agent.deployedName}
                </button>
              ))}
            </div>
            {firesError ? (
              <div className="rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] p-3 text-sm text-[var(--status-danger)]">
                {firesError}
              </div>
            ) : null}
            {outputError ? (
              <div className="rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] p-3 text-sm text-[var(--status-danger)]">
                {outputError}
              </div>
            ) : null}
            <div className="overflow-x-auto rounded-[1.25rem] border border-[var(--border-default)] bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fire</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Runtime</TableHead>
                    <TableHead>Cleanup</TableHead>
                    <TableHead className="text-right">Output</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-24 text-center text-sm text-muted-foreground">
                        Loading fires.
                      </TableCell>
                    </TableRow>
                  ) : fires.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-24 text-center text-sm text-muted-foreground">
                        {selectedAgent ? `${selectedAgent.deployedName} has no recorded fires.` : "No fires recorded."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    fires.map((fire) => (
                      <TableRow key={fire.id}>
                        <TableCell className="min-w-[13rem]">
                          <div className="flex flex-col gap-1">
                            <span className="font-medium text-foreground">{formatRelative(fire.startedAt)}</span>
                            <span className="font-mono text-xs text-muted-foreground">
                              {trimText(fire.eventSource, 42)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            <Badge variant={getFireBadgeVariant(fire.status)}>{fire.status}</Badge>
                            <span className="text-xs text-muted-foreground">Exit {fire.exitCode ?? "unknown"}</span>
                            {fire.status.toLowerCase() === "failed" ? (
                              <span className="max-w-[18rem] break-words text-left text-xs text-[var(--status-danger)]">
                                {fire.error ? trimText(fire.error, 120) : "No error detail captured."}
                              </span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1 text-sm">
                            <span>{formatDuration(fire.durationMs)}</span>
                            <span className="font-mono text-xs text-muted-foreground">
                              {fire.sandboxName ?? fire.sandboxId ?? "No sandbox"}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {cleanupStatusLabel(fire.cleanupStatus)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={loadingOutputId === fire.id}
                            onClick={() => void openOutput(fire)}
                          >
                            <Eye className="mr-2 size-4" />
                            {loadingOutputId === fire.id ? "Loading" : "View output"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </InsetSection>
      <FireOutputDialog deployment={selectedOutput} onClose={() => setSelectedOutput(null)} />
    </>
  );
}

function getDeploymentAgentBadgeVariant(status: string) {
  const normalized = status.toLowerCase();

  if (["ready", "active", "running", "connected", "authenticated"].includes(normalized)) {
    return "success" as const;
  }

  if (["deploying", "starting", "pending", "queued", "authorizing"].includes(normalized)) {
    return "info" as const;
  }

  if (["paused", "stopped", "inactive"].includes(normalized)) {
    return "warning" as const;
  }

  if (["failed", "error", "revoked", "expired", "destroyed"].includes(normalized)) {
    return "danger" as const;
  }

  return "default" as const;
}

function getDeploymentLastActivity(agent: DeployedAgent) {
  return agent.lastCompletedAt ?? agent.lastFiredAt ?? agent.lastUsedAt ?? agent.createdAt;
}

function AgentInputKeyChips({ inputValues }: { inputValues: DeployedAgent["inputValues"] }) {
  const entries = getAgentInputEntries(inputValues);
  if (entries.length === 0) return null;

  const visible = entries.slice(0, 3);
  const remaining = entries.length - visible.length;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {visible.map(([key]) => (
        <span
          key={key}
          className="max-w-[9rem] truncate rounded-full border border-[var(--border-default)] bg-[var(--surface-soft)] px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
        >
          {key}
        </span>
      ))}
      {remaining > 0 ? (
        <span className="rounded-full border border-[var(--border-default)] bg-[var(--surface-soft)] px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          +{remaining}
        </span>
      ) : null}
    </div>
  );
}

function DeployedAgentsSection({ agents }: { agents: DeployedAgent[] }) {
  return (
    <DashboardPanel
      title="Agents"
      description="Deployed proactive personas and their latest runtime activity."
      actions={
        <Button asChild>
          <a href="https://github.com/AgentWorkforce/agents" target="_blank" rel="noreferrer">
            Discover Agents
            <ExternalLink aria-hidden="true" />
          </a>
        </Button>
      }
    >
      {agents.length === 0 ? (
        <div className="flex min-h-[14rem] flex-col items-center justify-center gap-4 rounded-[1.5rem] border border-dashed border-[var(--border-strong)] bg-[var(--surface-soft)] px-6 text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <Flame aria-hidden="true" />
          </div>
          <div className="max-w-md">
            <p className="font-medium text-foreground">Launch your first deployed agent</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Deploy a persona to start receiving proactive fires in this workspace.
            </p>
          </div>
          <Button asChild variant="outline">
            <a href="https://github.com/AgentWorkforce/agents" target="_blank" rel="noreferrer">
              Discover Agents
              <ExternalLink aria-hidden="true" />
            </a>
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {agents.map((agent) => {
            const lastRunFailed = agent.lastRunStatus?.toLowerCase() === "failed" || Boolean(agent.lastError);
            const personaDescription = agent.personaDescription?.trim() || "Deployed proactive persona";
            return (
              <Link
                key={agent.agentId}
                href={`/dashboard/workforce/agents/${agent.agentId}`}
                className="group flex min-w-0 max-w-full flex-col gap-3 rounded-[1.25rem] border border-[var(--border-default)] bg-card px-4 py-3 transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-soft)]"
              >
                <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <AgentCardThumbnail deployedName={agent.deployedName} imageUrl={agent.imageUrl} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate font-medium text-foreground">{agent.deployedName}</p>
                        <Badge variant={getDeploymentAgentBadgeVariant(agent.status)}>{agent.status}</Badge>
                      </div>
                      <p className="mt-1 truncate text-sm text-muted-foreground" title={personaDescription}>
                        {personaDescription}
                      </p>
                      <AgentInputKeyChips inputValues={agent.inputValues} />
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground xl:justify-end">
                    <span>
                      <span className="font-medium text-foreground">{formatRelative(getDeploymentLastActivity(agent))}</span>
                      <span className="ml-1">last activity</span>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      <span className="font-medium text-foreground">{agent.runCount}</span>
                      <span className="ml-1">{agent.runCount === 1 ? "run" : "runs"}</span>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      <span className="font-medium text-foreground">{agent.scheduleIds.length}</span>
                      <span className="ml-1">{agent.scheduleIds.length === 1 ? "schedule" : "schedules"}</span>
                    </span>
                  </div>
                </div>
                {lastRunFailed ? (
                  <div className="flex min-w-0 items-center gap-2 rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] px-3 py-2 text-[var(--status-danger)]">
                    <Badge variant="danger">FAILED</Badge>
                    <span className="min-w-0 truncate font-mono text-xs">
                      {agent.lastError ? trimText(agent.lastError, 180) : "No error detail captured."}
                    </span>
                  </div>
                ) : null}
              </Link>
            );
          })}
        </div>
      )}
    </DashboardPanel>
  );
}

type FleetDashboardNode = {
  id: string;
  name: string;
  capabilities: Array<string | { name?: string; kind?: string; metadata?: Record<string, unknown> }>;
  tags?: string[];
  version?: string;
  status: "online" | "offline" | string;
  live?: boolean;
  handlers_live?: boolean;
  load?: number;
  active_agents?: number;
  max_agents?: number;
  last_heartbeat_at?: string | null;
  created_at?: string;
};

type FleetNodesResponse = {
  relayWorkspaceId: string | null;
  nodes?: FleetDashboardNode[];
  error?: string;
};

type FleetEnrollmentResponse = {
  enrollCommand?: string;
  expiresAt?: string;
  relayWorkspaceId?: string;
  error?: string;
};

function fleetCapabilityLabel(capability: FleetDashboardNode["capabilities"][number]) {
  if (typeof capability === "string") return capability;
  return capability.name ?? "capability";
}

function formatFleetLoad(load: number | undefined) {
  if (typeof load !== "number" || !Number.isFinite(load)) return "0%";
  const percentage = load <= 1 ? load * 100 : load;
  return `${Math.max(0, Math.min(100, Math.round(percentage)))}%`;
}

function formatFleetAgents(node: FleetDashboardNode) {
  const active = Number(node.active_agents ?? 0);
  const max = Number(node.max_agents ?? 0);
  return `${active} / ${max > 0 ? max : "unlimited"}`;
}

function splitFleetList(value: string) {
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

// Known fleet capabilities, derived from the agent-relay CLI registry so the
// Enroll-node picker stays in sync with the spawnable harness set. One
// `spawn:<cli>` per Cloud-supported harness plus the special `workflow:run`.
const FLEET_CAPABILITY_OPTIONS: readonly string[] = [
  ...FLEET_SPAWNABLE_CLIS.map((cli) => `spawn:${cli}`),
  "workflow:run",
];
const DEFAULT_FLEET_CAPABILITIES: readonly string[] = ["spawn:claude", "spawn:codex"];

function FleetNodeStatusBadge({ node }: { node: FleetDashboardNode }) {
  const live = node.live === true || node.status === "online";
  return (
    <Badge variant={live ? "success" : "default"}>
      {live ? "online" : "offline"}
    </Badge>
  );
}

export function FleetPageView() {
  const { authSession, authenticated, sessionLoading } = useDashboard();
  const [nodes, setNodes] = useState<FleetDashboardNode[]>([]);
  const [relayWorkspaceId, setRelayWorkspaceId] = useState<string | null>(null);
  const [loadingNodes, setLoadingNodes] = useState(true);
  const [refreshingNodes, setRefreshingNodes] = useState(false);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [nodeName, setNodeName] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([...DEFAULT_FLEET_CAPABILITIES]);
  const [maxAgents, setMaxAgents] = useState("4");
  const [tags, setTags] = useState("");
  const [minting, setMinting] = useState(false);
  const [enrollmentError, setEnrollmentError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<FleetEnrollmentResponse | null>(null);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const workspaceId = authSession?.currentWorkspace.id ?? null;

  const liveNodes = nodes.filter((node) => node.live === true || node.status === "online").length;
  const liveHandlers = nodes.filter((node) => node.handlers_live === true).length;
  const activeAgents = nodes.reduce((sum, node) => sum + Number(node.active_agents ?? 0), 0);
  const averageLoad = nodes.length > 0
    ? nodes.reduce((sum, node) => sum + Number(node.load ?? 0), 0) / nodes.length
    : 0;

  async function loadNodes({ background = false } = {}) {
    if (!workspaceId) {
      setNodes([]);
      setRelayWorkspaceId(null);
      setLoadingNodes(false);
      return;
    }

    if (background) {
      setRefreshingNodes(true);
    } else {
      setLoadingNodes(true);
    }
    setRosterError(null);

    try {
      const response = await fetch(
        toAppPath(`/api/v1/fleet/nodes?workspaceId=${encodeURIComponent(workspaceId)}`),
        { credentials: "include", cache: "no-store" },
      );
      const payload = (await response.json().catch(() => null)) as FleetNodesResponse | null;
      if (!response.ok) {
        setRosterError(payload?.error ?? "Failed to load nodes.");
        return;
      }
      setNodes(Array.isArray(payload?.nodes) ? payload.nodes : []);
      setRelayWorkspaceId(payload?.relayWorkspaceId ?? null);
    } catch {
      setRosterError("Failed to load nodes.");
    } finally {
      setLoadingNodes(false);
      setRefreshingNodes(false);
    }
  }

  useEffect(() => {
    void loadNodes();
  }, [workspaceId]);

  async function handleMintEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId) return;

    setMinting(true);
    setEnrollmentError(null);
    setEnrollment(null);
    setCopiedCommand(false);
    setCopiedCommand(false);

    try {
      const parsedMaxAgents = maxAgents.trim() ? Number(maxAgents) : 0;
      const response = await fetch(toAppPath("/api/v1/fleet/enrollment-tokens"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          name: nodeName.trim() || undefined,
          capabilities: withDispatchCapabilities(capabilities),
          maxAgents: Number.isInteger(parsedMaxAgents) && parsedMaxAgents >= 0 ? parsedMaxAgents : 0,
          tags: splitFleetList(tags),
        }),
      });
      const payload = (await response.json().catch(() => null)) as FleetEnrollmentResponse | null;
      if (!response.ok || !payload?.enrollCommand) {
        setEnrollmentError(payload?.error ?? "Failed to create enrollment token.");
        return;
      }
      setEnrollment(payload);
      await loadNodes({ background: true });
    } catch {
      setEnrollmentError("Failed to create enrollment token.");
    } finally {
      setMinting(false);
    }
  }

  if (sessionLoading) {
    return (
      <DashboardLoadingState
        title="Fleet"
        description="Loading node roster and enrollment state."
      />
    );
  }

  if (!authenticated || !authSession) {
    return (
      <DashboardSignInState
        title="Sign in to manage fleet"
        description="Fleet controls are scoped to the active workspace."
      />
    );
  }

  return (
    <DashboardPageFrame
      eyebrow="Cloud dashboard"
      title="Fleet"
      description="Inspect registered nodes, socket liveness, handler availability, and active agent capacity for this workspace."
      actions={
        <Button
          variant="outline"
          onClick={() => {
            void loadNodes({ background: true });
          }}
          disabled={refreshingNodes}
          className="w-full sm:w-auto"
        >
          <RefreshCcw className={cn("mr-2 size-4", refreshingNodes ? "animate-spin" : "")} />
          Refresh
        </Button>
      }
    >
      <section className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Nodes"
          value={String(nodes.length)}
          note={relayWorkspaceId ? `Relay workspace ${relayWorkspaceId}.` : "Relay workspace is not provisioned yet."}
          icon={Server}
        />
        <MetricCard
          label="Live sockets"
          value={String(liveNodes)}
          note={liveNodes > 0 ? "Nodes with current heartbeats." : "No node sockets are live right now."}
          icon={Network}
        />
        <MetricCard
          label="Handlers"
          value={String(liveHandlers)}
          note={liveHandlers > 0 ? "Action handlers reporting live." : "No live action handlers reported."}
          icon={Command}
        />
        <MetricCard
          label="Load"
          value={formatFleetLoad(averageLoad)}
          note={`${activeAgents} active agent${activeAgents === 1 ? "" : "s"} across the roster.`}
          icon={Activity}
        />
      </section>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.65fr)]">
        <DashboardPanel
          title="Node roster"
          description={`Registered nodes for ${authSession.currentWorkspace.name}.`}
          contentClassName="gap-4"
        >
          {rosterError ? (
            <div className="rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] p-3 text-sm text-[var(--status-danger)]">
              {rosterError}
            </div>
          ) : null}

          {loadingNodes ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-14 w-full" />
              ))}
            </div>
          ) : nodes.length === 0 ? (
            <div className="flex min-h-[18rem] items-center justify-center rounded-[1.25rem] border border-dashed border-[var(--border-strong)] bg-card px-6 text-center text-sm text-muted-foreground">
              No fleet nodes are registered in this workspace.
            </div>
          ) : (
            <div className="min-w-0 overflow-x-auto rounded-[1.25rem] border border-[var(--border-default)] bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Capabilities</TableHead>
                    <TableHead>Liveness</TableHead>
                    <TableHead>Handlers</TableHead>
                    <TableHead>Load</TableHead>
                    <TableHead>Agents/max</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {nodes.map((node) => {
                    const capabilityLabels = node.capabilities.map(fleetCapabilityLabel).filter(Boolean);
                    return (
                      <TableRow key={node.id}>
                        <TableCell className="min-w-48">
                          <div className="flex min-w-0 flex-col gap-1">
                            <span className="truncate font-medium text-foreground">{node.name}</span>
                            <span className="truncate text-xs text-muted-foreground">
                              {node.version || node.id}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="min-w-60">
                          <div className="flex max-w-md flex-wrap gap-1.5">
                            {capabilityLabels.length === 0 ? (
                              <span className="text-sm text-muted-foreground">None</span>
                            ) : (
                              <>
                                {capabilityLabels.slice(0, 4).map((label) => (
                                  <Badge key={label} variant="default">
                                    {label}
                                  </Badge>
                                ))}
                                {capabilityLabels.length > 4 ? (
                                  <Badge variant="default">+{capabilityLabels.length - 4}</Badge>
                                ) : null}
                              </>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="min-w-44">
                          <div className="flex flex-col gap-1">
                            <FleetNodeStatusBadge node={node} />
                            <span className="text-xs text-muted-foreground">
                              {node.last_heartbeat_at ? formatRelative(node.last_heartbeat_at) : "No heartbeat"}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={node.handlers_live ? "success" : "default"}>
                            {node.handlers_live ? "live" : "idle"}
                          </Badge>
                        </TableCell>
                        <TableCell>{formatFleetLoad(node.load)}</TableCell>
                        <TableCell>{formatFleetAgents(node)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </DashboardPanel>

        <DashboardPanel
          title="Enroll node"
          description="Mint a one-time command for a sandbox or host."
          contentClassName="gap-4"
        >
          <form onSubmit={handleMintEnrollment} className="grid gap-4">
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Node name
              <input
                value={nodeName}
                onChange={(event) => setNodeName(event.target.value)}
                placeholder="daytona-node-1"
                className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-soft)] px-3 py-2.5 text-sm font-normal text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-[var(--border-strong)]"
              />
            </label>
            <fieldset className="grid gap-1.5">
              <legend className="text-sm font-medium text-foreground">Capabilities</legend>
              <p className="text-xs text-muted-foreground">
                Select the harnesses this node may spawn, plus optional workflow execution.
              </p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {FLEET_CAPABILITY_OPTIONS.map((capability) => {
                  const selected = capabilities.includes(capability);
                  return (
                    <button
                      key={capability}
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        setCapabilities((current) =>
                          current.includes(capability)
                            ? current.filter((entry) => entry !== capability)
                            : [...current, capability],
                        )
                      }
                      className={cn(
                        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-[0.18em] transition-colors",
                        selected
                          ? "border-transparent bg-[var(--status-info-soft)] text-[var(--status-info)]"
                          : "border-[var(--border-default)] bg-[var(--surface-soft)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]",
                      )}
                    >
                      {capability}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium text-foreground">
                Max agents
                <input
                  type="number"
                  min={0}
                  value={maxAgents}
                  onChange={(event) => setMaxAgents(event.target.value)}
                  className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-soft)] px-3 py-2.5 text-sm font-normal text-foreground outline-none transition-colors focus:border-[var(--border-strong)]"
                />
              </label>
              <label className="grid gap-1.5 text-sm font-medium text-foreground">
                Tags
                <input
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                  placeholder="daytona, sandbox"
                  className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-soft)] px-3 py-2.5 text-sm font-normal text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-[var(--border-strong)]"
                />
              </label>
            </div>
            <Button type="submit" disabled={minting} className="w-full">
              {minting ? "Minting..." : "Create enrollment command"}
            </Button>
          </form>

          {enrollmentError ? (
            <div className="rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] p-3 text-sm text-[var(--status-danger)]">
              {enrollmentError}
            </div>
          ) : null}

          {enrollment?.enrollCommand ? (
            <div className="rounded-[1.25rem] border border-[var(--code-border)] bg-[var(--code-bg)] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">Enrollment command</p>
                  <p className="text-xs text-muted-foreground">
                    Expires {formatTimestamp(enrollment.expiresAt ?? null)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    await navigator.clipboard.writeText(enrollment.enrollCommand ?? "");
                    setCopiedCommand(true);
                    window.setTimeout(() => setCopiedCommand(false), 2000);
                  }}
                >
                  {copiedCommand ? <CheckIcon /> : <CopyIcon />}
                  <span className="ml-2">{copiedCommand ? "Copied" : "Copy"}</span>
                </Button>
              </div>
              <code className="mt-4 block max-h-36 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-5 text-[var(--code-keyword)]">
                {enrollment.enrollCommand}
              </code>
            </div>
          ) : null}
        </DashboardPanel>
      </div>
    </DashboardPageFrame>
  );
}

export function WorkforcePageView() {
  const {
    activateCloudAgent,
    agents,
    authSession,
    authenticated,
    cancelInvite,
    connectCommands,
    deleteCloudAgent,
    deploymentAgents,
    healthyAgents,
    loadingData,
    pendingInvites,
    refreshInvites,
    sessionLoading,
  } = useDashboard();
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);

  if (sessionLoading || (authenticated && loadingData)) {
    return (
      <DashboardLoadingState
        title="Workforce"
        description="Loading cloud agents, invites, and connection state."
      />
    );
  }

  if (!authenticated || !authSession) {
    return (
      <DashboardSignInState
        title="Sign in to manage workforce"
        description="Workforce controls let you connect agent harnesses and invite teammates into the active organization."
      />
    );
  }

  return (
    <>
      <DashboardPageFrame
        eyebrow="Cloud dashboard"
        title="Workforce"
        description="Manage cloud agents, invite teammates into the organization, and keep credential health visible in one operational view."
        actions={
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button onClick={() => setConnectDialogOpen(true)}>Connect agent</Button>
            <Button variant="outline" onClick={() => setInviteDialogOpen(true)}>
              Invite member
            </Button>
          </div>
        }
      >
        <section className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Cloud agents"
            value={String(agents.length)}
            note="Stored for the active workspace."
            icon={Command}
          />
          <MetricCard
            label="Healthy agents"
            value={String(healthyAgents)}
            note={healthyAgents > 0 ? "Ready to accept new workflow runs." : "Reconnect a provider to restore coverage."}
            icon={ShieldCheck}
          />
          <MetricCard
            label="Pending invites"
            value={String(pendingInvites.length)}
            note={
              pendingInvites.length > 0
                ? "Outstanding organization invitations."
                : "No invitations are waiting on a response."
            }
            icon={Users2}
          />
          <MetricCard
            label="Deployed personas"
            value={String(deploymentAgents.length)}
            note={deploymentAgents.length > 0 ? "Proactive fires are visible below." : "No personas are deployed yet."}
            icon={Flame}
          />
        </section>

        <DeployedAgentsSection agents={deploymentAgents} />

        <DashboardPanel
          title="Connected workforce"
          description={`Manage the agents and invites attached to ${authSession.currentWorkspace.name}.`}
          className="min-h-[40rem]"
          contentClassName="gap-5"
        >
          <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,0.95fr)]">
            <InsetSection
              title="Cloud agents"
              description="Stored agents, their current health, and their recent activity."
            >
              {agents.length === 0 ? (
                <div className="flex min-h-[16rem] items-center justify-center rounded-[1.25rem] border border-dashed border-[var(--border-strong)] bg-card px-6 text-center text-sm text-muted-foreground">
                  No cloud agents are connected in this workspace yet.
                </div>
              ) : (
                agents.map((agent) => {
                  const providerSiblings = agents.filter(
                    (candidate) => candidate.modelProvider === agent.modelProvider,
                  );
                  const showActiveControl = providerSiblings.length > 1;
                  return (
                    <div
                      key={agent.id}
                      className={cn(
                        "rounded-[1.25rem] border border-[var(--border-default)] bg-card p-4",
                        agent.lastError ? "border-[var(--status-danger)]" : "",
                        showActiveControl && agent.isActive ? "border-[var(--border-strong)]" : "",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex flex-col gap-1">
                          <p className="font-medium text-foreground">{agent.displayName}</p>
                          <p className="text-sm text-muted-foreground">
                            {agent.harness}
                            {agent.defaultModel ? ` • ${agent.defaultModel}` : ""}
                          </p>
                          {agent.accountEmail ? (
                            <p className="truncate text-sm text-muted-foreground" title={agent.accountEmail}>
                              {agent.accountEmail}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          <Badge variant={getAgentBadgeVariant(agent.status)}>{agent.status}</Badge>
                          {showActiveControl ? (
                            <label
                              className={cn(
                                "flex cursor-pointer items-center gap-1.5 text-xs",
                                agent.isActive ? "text-foreground" : "text-muted-foreground",
                              )}
                            >
                              <input
                                type="radio"
                                name={`active-credential-${agent.modelProvider}`}
                                checked={agent.isActive}
                                onChange={() => {
                                  void activateCloudAgent(agent.id);
                                }}
                                className="h-3.5 w-3.5 accent-[var(--border-strong)]"
                              />
                              {agent.isActive ? "Active" : "Set active"}
                            </label>
                          ) : null}
                        </div>
                      </div>

                      <div className="mt-4 grid gap-4 text-sm md:grid-cols-2">
                        <div className="min-w-0">
                          <p className="truncate text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                            Authenticated
                          </p>
                          <p className="mt-1 truncate text-foreground">
                            {formatTimestamp(agent.lastAuthenticatedAt)}
                          </p>
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                            Last used
                          </p>
                          <p className="mt-1 truncate text-foreground">
                            {formatTimestamp(agent.lastUsedAt)}
                          </p>
                        </div>
                      </div>

                      {agent.usage ? <AccountUsageMeter usage={agent.usage} /> : null}

                      {agent.lastError ? (
                        <div className="mt-4 rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] p-3 text-sm text-[var(--status-danger)]">
                          {agent.lastError}
                        </div>
                      ) : null}

                      <div className="mt-3 flex justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-[var(--status-danger)] hover:text-[var(--status-danger)]"
                          onClick={() => {
                            const confirmed = window.confirm(
                              `Disconnect ${agent.displayName}? Future ctx.llm runs and harness personas using this credential will stop authenticating on their next run. Already-running boxes may keep mounted copies until they exit.`,
                            );
                            if (confirmed) {
                              void deleteCloudAgent(agent.id);
                            }
                          }}
                        >
                          Disconnect
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </InsetSection>

            <div className="flex flex-col gap-5">
              <ProactiveFiresSection agents={deploymentAgents} />

              <InsetSection
                title="Pending invitations"
                description="Membership invites that are still waiting on a response."
              >
                {pendingInvites.length === 0 ? (
                  <div className="flex min-h-[12rem] items-center justify-center rounded-[1.25rem] border border-dashed border-[var(--border-strong)] bg-card px-6 text-center text-sm text-muted-foreground">
                    No pending invitations right now.
                  </div>
                ) : (
                  pendingInvites.map((invite) => (
                    <div
                      key={invite.id}
                      className="rounded-[1.25rem] border border-[var(--border-default)] bg-card p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex flex-col gap-1">
                          <p className="font-medium text-foreground">{invite.email}</p>
                          <p className="text-sm text-muted-foreground">
                            {invite.role} • invited by {invite.invitedByName || "Unknown"}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            void cancelInvite(invite.id);
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                      <p className="mt-3 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                        Expires {formatTimestamp(invite.expiresAt)}
                      </p>
                    </div>
                  ))
                )}
              </InsetSection>

              <InsetSection
                title="Connection quickstart"
                description="Reuse stored provider credentials for the harnesses you run most often."
              >
                {connectCommands.slice(0, 3).map((command) => (
                  <div
                    key={command.provider}
                    className="rounded-[1.25rem] border border-[var(--border-default)] bg-card p-4"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex flex-col gap-1">
                        <p className="font-medium text-foreground">{command.label}</p>
                        <p className="text-sm text-muted-foreground">{command.note}</p>
                      </div>
                      <Badge variant="default">{command.cli}</Badge>
                    </div>
                  </div>
                ))}

                <Button variant="outline" className="w-full" onClick={() => setConnectDialogOpen(true)}>
                  Show connect commands
                </Button>
              </InsetSection>
            </div>
          </div>
        </DashboardPanel>
      </DashboardPageFrame>

      <ConnectAgentDialog
        open={connectDialogOpen}
        onClose={() => setConnectDialogOpen(false)}
        commands={connectCommands}
      />
      <InviteMemberDialog
        open={inviteDialogOpen}
        onClose={() => setInviteDialogOpen(false)}
        invites={pendingInvites}
        onInviteSent={() => {
          void refreshInvites();
        }}
        onCancelInvite={(inviteId) => {
          void cancelInvite(inviteId);
        }}
      />
    </>
  );
}

export function SettingsPageView() {
  const { authPending, authSession, authenticated, loadingData, logout, sessionLoading, switchWorkspace } =
    useDashboard();

  if (sessionLoading || (authenticated && loadingData)) {
    return (
      <DashboardLoadingState
        title="Settings"
        description="Loading workspace access and account settings."
      />
    );
  }

  if (!authenticated || !authSession) {
    return (
      <DashboardSignInState
        title="Sign in to edit settings"
        description="Settings cover workspace switching, appearance, and your current cloud session."
      />
    );
  }

  const initials = getUserInitials(authSession.user.name, authSession.user.email);
  const displayName = authSession.user.name || authSession.user.email || "Google user";

  return (
    <DashboardPageFrame
      eyebrow="Cloud dashboard"
      title="Settings"
      description="Manage workspace selection, review the current account session, and keep the account controls that support the sidebar dashboard in one place."
    >
      <section className="grid gap-4 md:grid-cols-3">
        <MetricCard
          label="Organization"
          value={authSession.currentOrganization.name}
          valueClassName="text-xl leading-tight md:text-2xl"
          note={`Role: ${authSession.currentOrganization.role}.`}
          icon={Building2}
        />
        <MetricCard
          label="Workspace"
          value={authSession.currentWorkspace.name}
          valueClassName="text-xl leading-tight md:text-2xl"
          note={authSession.currentWorkspace.slug}
          icon={Workflow}
        />
        <MetricCard
          label="Account session"
          value={displayName}
          valueClassName="text-xl leading-tight md:text-2xl"
          note={authSession.user.email || "Google-backed dashboard access."}
          icon={Monitor}
        />
      </section>

      <DashboardPanel
        title="Workspace and session"
        description="Switch between accessible workspaces and review the account attached to this cloud dashboard."
        className="min-h-[40rem]"
        contentClassName="gap-5"
      >
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <InsetSection
            title="Workspace selection"
            description="Move between accessible workspaces without leaving the dashboard."
          >
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-[1.25rem] border border-[var(--border-default)] bg-card p-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Organization
                </p>
                <p className="mt-2 text-lg font-semibold text-foreground">
                  {authSession.currentOrganization.name}
                </p>
                <div className="mt-3">
                  <Badge variant="default">{authSession.currentOrganization.role}</Badge>
                </div>
              </div>

              <div className="rounded-[1.25rem] border border-[var(--border-default)] bg-card p-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Workspace
                </p>
                <p className="mt-2 text-lg font-semibold text-foreground">
                  {authSession.currentWorkspace.name}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {authSession.currentWorkspace.slug}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-foreground">Switch workspace</p>
              <Select
                value={authSession.currentWorkspace.id}
                disabled={authPending}
                onValueChange={switchWorkspace}
              >
                <SelectTrigger className="w-full rounded-xl bg-card">
                  <SelectValue placeholder="Choose workspace" />
                </SelectTrigger>
                <SelectContent>
                  {authSession.organizations.map((organization) => {
                    const organizationWorkspaces = authSession.workspaces.filter(
                      (workspace) => workspace.organization_id === organization.id,
                    );
                    if (!organizationWorkspaces.length) {
                      return null;
                    }

                    return (
                      <SelectGroup key={organization.id}>
                        <SelectLabel>{organization.name}</SelectLabel>
                        {organizationWorkspaces.map((workspace) => (
                          <SelectItem key={workspace.id} value={workspace.id}>
                            {workspace.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    );
                  })}
                </SelectContent>
              </Select>
              <p className="text-sm leading-6 text-muted-foreground">
                Workspace switching lives here so the sidebar can stay focused on page navigation.
              </p>
            </div>
          </InsetSection>

          <InsetSection
            title="Account"
            description="The Google-backed identity currently attached to this dashboard session."
          >
            <div className="flex items-center gap-4 rounded-[1.25rem] border border-[var(--border-default)] bg-card p-4">
              <Avatar size="lg">
                <AvatarImage src={authSession.user.avatarUrl ?? undefined} alt="" />
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-foreground">{displayName}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {authSession.user.email || "Signed in"}
                </p>
              </div>
            </div>

            <div className="grid gap-3">
              <div className="rounded-[1.25rem] border border-[var(--border-default)] bg-card p-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Session scope
                </p>
                <p className="mt-2 text-sm font-medium text-foreground">
                  {authSession.currentOrganization.name} / {authSession.currentWorkspace.name}
                </p>
              </div>

              <div className="rounded-[1.25rem] border border-[var(--border-default)] bg-card p-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Access overview
                </p>
                <p className="mt-2 text-sm font-medium text-foreground">Google sign-in</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  This account can access {authSession.workspaces.length} workspaces across{" "}
                  {authSession.organizations.length} organizations.
                </p>
              </div>
            </div>

            <Button variant="outline" className="w-full" disabled={authPending} onClick={logout}>
              {authPending ? "Working..." : "Logout"}
            </Button>
          </InsetSection>
        </div>
      </DashboardPanel>

      <GithubJoinRequestsCard
        workspaceId={authSession.currentWorkspace.id}
        canManage={["owner", "admin"].includes(authSession.currentOrganization.role)}
      />
    </DashboardPageFrame>
  );
}

type SlackAppConfig = {
  provider: "slack" | "slack-my-senior-dev" | "slack-nightcto";
  label: string;
  configKey: string;
  icon?: ReactNode;
  description?: ReactNode;
};

const SLACK_APPS: SlackAppConfig[] = [
  {
    provider: "slack",
    label: "Sage",
    // Nango provider-config-key. NOT the workspace_integrations.provider id
    // (`slack` after the rename) — those happen to share a prefix but are
    // unrelated. The integration POST handler uses this as the
    // `providerConfigKey` fallback when the Nango connect event omits it,
    // and Nango itself looks up the OAuth + sync config under this key.
    // Setting it to the (renamed) provider id `"slack"` would point Nango
    // at a config that doesn't exist and the connect flow would 404.
    configKey: "slack-relay",
    icon: <SageLogo className="size-4" />,
    description: (
      <>
        Sage is your AI research and planning teammate. Mention{" "}
        <span className="font-medium text-foreground">@Sage</span> in any Slack channel to research
        topics, ask clarifying questions, and get structured plans. Sage remembers prior
        conversations, searches your GitHub repos, and keeps your team aligned on development
        work.
      </>
    ),
  },
  // { provider: "slack-my-senior-dev", label: "Senior Dev", configKey: "slack-my-senior-dev" },
  // { provider: "slack-nightcto", label: "NightCTO", configKey: "slack-nightcto" },
];

type IntegrationRecord = {
  connectionId: string | null;
  providerConfigKey: string | null;
  installationId?: string | null;
} | null;

// Operator request (2026-06-04): hide the Sage product framing on the
// integrations page and show a clean relay-connection view instead. The Sage
// panel (Slack channel access, SageNotifyChannelPicker, Sage copy around the
// provider toggles) is kept intact behind this flag so it can be restored by
// flipping it back to true.
const SHOW_SAGE_INTEGRATIONS: boolean = false;

// Subset of IntegrationListEntry (lib/integrations/integration-list.ts)
// returned by GET /api/v1/workspaces/:workspaceId/integrations that the
// relay view consumes.
type RelayIntegrationEntry = {
  provider: string;
  providerConfigKey: string | null;
  status?: string;
  connectionId?: string | null;
  lastEventAt?: string;
};

// Relayfile integrations follow the `<integration>-relay` config-key
// convention (see lib/integrations/providers.ts). Product apps such as
// `slack-ricky` / `slack-my-senior-dev` intentionally do not match.
const RELAY_INTEGRATION_CATALOG: WorkspaceIntegrationProviderDefinition[] =
  listWorkspaceIntegrationCatalogEntries().filter(
    (definition) => !definition.deprecated && definition.defaultConfigKey.endsWith("-relay"),
  );

// IntegrationToggleRow expects a stable logo component; cache the ProviderLogo
// wrappers per provider so rows don't remount the logo on every render.
const relayLogoCache = new Map<string, React.ComponentType<{ className?: string }>>();

function relayProviderLogo(provider: string, label: string) {
  let Logo = relayLogoCache.get(provider);
  if (!Logo) {
    Logo = function RelayProviderLogoIcon({ className }: { className?: string }) {
      return <ProviderLogo provider={provider} label={label} size={16} className={className} />;
    };
    relayLogoCache.set(provider, Logo);
  }
  return Logo;
}

export function IntegrationsPageView() {
  const { authSession, authenticated, loadingData, sessionLoading } = useDashboard();
  const [slackIntegrations, setSlackIntegrations] = useState<Record<string, IntegrationRecord>>({});
  const [githubIntegration, setGithubIntegration] = useState<IntegrationRecord>(null);
  const [gitlabIntegration, setGitlabIntegration] = useState<IntegrationRecord>(null);
  const [redditIntegration, setRedditIntegration] = useState<IntegrationRecord>(null);
  const [xIntegration, setXIntegration] = useState<IntegrationRecord>(null);
  const [linearIntegration, setLinearIntegration] = useState<IntegrationRecord>(null);
  const [notionIntegration, setNotionIntegration] = useState<IntegrationRecord>(null);
  const [loadingIntegration, setLoadingIntegration] = useState(
    () => SHOW_SAGE_INTEGRATIONS && !!authSession,
  );
  const [relayEntries, setRelayEntries] = useState<RelayIntegrationEntry[] | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [loadingRelay, setLoadingRelay] = useState(() => !!authSession);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!authSession) {
      setRelayEntries(null);
      setRelayError(null);
      setLoadingRelay(false);
      return;
    }

    let active = true;
    setLoadingRelay(true);

    const workspaceId = encodeURIComponent(authSession.currentWorkspace.id);
    fetch(toAppPath(`/api/v1/workspaces/${workspaceId}/integrations`), { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load workspace integrations.");
        return (await res.json()) as RelayIntegrationEntry[];
      })
      .then((entries) => {
        if (!active) return;
        setRelayEntries(Array.isArray(entries) ? entries : []);
        setRelayError(null);
      })
      .catch((cause) => {
        if (!active) return;
        setRelayEntries(null);
        setRelayError(
          cause instanceof Error ? cause.message : "Failed to load workspace integrations.",
        );
      })
      .finally(() => {
        if (active) setLoadingRelay(false);
      });

    return () => {
      active = false;
    };
  }, [authSession, refreshKey]);

  useEffect(() => {
    if (!SHOW_SAGE_INTEGRATIONS || !authSession) {
      setSlackIntegrations({});
      setGithubIntegration(null);
      setGitlabIntegration(null);
      setRedditIntegration(null);
      setXIntegration(null);
      setLinearIntegration(null);
      setNotionIntegration(null);
      return;
    }

    let active = true;
    setLoadingIntegration(true);

    const workspaceId = encodeURIComponent(authSession.currentWorkspace.id);

    const fetchIntegration = (provider: string) =>
      fetch(toAppPath(`/api/v1/workspaces/${workspaceId}/integrations/${provider}`), { credentials: "include" })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);

    Promise.all([
      ...SLACK_APPS.map((app) => fetchIntegration(app.provider)),
      fetchIntegration("github"),
      fetchIntegration("gitlab"),
      fetchIntegration("reddit"),
      fetchIntegration("x"),
      fetchIntegration("linear"),
      fetchIntegration("notion"),
    ]).then((results) => {
      if (!active) return;
      const slackMap: Record<string, IntegrationRecord> = {};
      SLACK_APPS.forEach((app, i) => {
        slackMap[app.provider] = results[i] as IntegrationRecord;
      });
      const integrationOffset = SLACK_APPS.length;
      setSlackIntegrations(slackMap);
      setGithubIntegration(results[integrationOffset] as IntegrationRecord);
      setGitlabIntegration(results[integrationOffset + 1] as IntegrationRecord);
      setRedditIntegration(results[integrationOffset + 2] as IntegrationRecord);
      setXIntegration(results[integrationOffset + 3] as IntegrationRecord);
      setLinearIntegration(results[integrationOffset + 4] as IntegrationRecord);
      setNotionIntegration(results[integrationOffset + 5] as IntegrationRecord);
    }).finally(() => {
      if (active) setLoadingIntegration(false);
    });

    return () => {
      active = false;
    };
  }, [authSession, refreshKey]);

  if (sessionLoading || (authenticated && loadingData) || loadingIntegration || loadingRelay) {
    return (
      <DashboardLoadingState
        title="Integrations"
        description="Loading workspace integrations."
      />
    );
  }

  if (!authenticated || !authSession) {
    return (
      <DashboardSignInState
        title="Sign in to view integrations"
        description="Integrations will live inside the cloud dashboard so workspace connections stay alongside workflows and workforce management."
      />
    );
  }

  const onMutate = () => setRefreshKey((k) => k + 1);
  const relayEntryByProvider = new Map<string, RelayIntegrationEntry>();
  for (const entry of relayEntries ?? []) {
    const provider = resolveWorkspaceIntegrationProvider(entry.provider) ?? entry.provider;
    if (!relayEntryByProvider.has(provider)) {
      relayEntryByProvider.set(provider, entry);
    }
  }
  const isRelayConnected = (definition: WorkspaceIntegrationProviderDefinition) =>
    Boolean(relayEntryByProvider.get(definition.id)?.connectionId);
  const orderedRelayCatalog = [
    ...RELAY_INTEGRATION_CATALOG.filter(isRelayConnected),
    ...RELAY_INTEGRATION_CATALOG.filter((definition) => !isRelayConnected(definition)),
  ];
  const activeIntegrationLabels = RELAY_INTEGRATION_CATALOG.filter(isRelayConnected).map(
    (definition) => definition.displayName,
  );
  const hasActiveIntegrations = activeIntegrationLabels.length > 0;
  const relayFileObserverHref = toAppPath(
    `/api/v1/workspaces/${encodeURIComponent(authSession.currentWorkspace.id)}/relayfile/observer`,
  );

  return (
    <DashboardPageFrame
      eyebrow="Cloud dashboard"
      title="Integrations"
      description="Connect your agents to Slack, GitHub, Notion, Linear, and more. Each connection is stored per workspace."
      actions={<WorkspaceSummaryCard authSession={authSession} />}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-5">
          {hasActiveIntegrations ? (
            <DashboardPanel
              title={
                <div className="flex items-center gap-2">
                  <Files className="size-5 text-primary" />
                  <span>RelayFile data</span>
                </div>
              }
              description="Browse the files and metadata synced from this workspace's connected integrations."
              className="rounded-[2rem] border-[var(--dashboard-border)] bg-[var(--dashboard-panel)]"
              contentClassName="gap-4"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 flex-col gap-3">
                  <p className="text-sm leading-6 text-muted-foreground">
                    {activeIntegrationLabels.length} active integration
                    {activeIntegrationLabels.length === 1 ? "" : "s"} can be inspected through
                    RelayFile.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {activeIntegrationLabels.map((label) => (
                      <Badge key={label} className="normal-case tracking-normal">
                        {label}
                      </Badge>
                    ))}
                  </div>
                </div>
                <Button asChild className="w-full lg:w-auto">
                  <a href={relayFileObserverHref}>
                    <Files className="size-4" />
                    Open RelayFile observer
                    <ExternalLink className="size-4" />
                  </a>
                </Button>
              </div>
            </DashboardPanel>
          ) : null}

          <DashboardPanel
            title={
              <div className="flex items-center gap-2">
                <Plug className="size-5 text-primary" />
                <span>Connected integrations</span>
              </div>
            }
            description="Workspace connections that sync data into RelayFile. Toggle a provider to connect or disconnect it."
            className="rounded-[2rem] border-[var(--dashboard-border)] bg-[var(--dashboard-panel)]"
            contentClassName="gap-2"
          >
            {relayError ? (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm text-muted-foreground">
                  Could not load workspace integrations: {relayError}
                </p>
                <Button variant="outline" onClick={onMutate}>
                  Try again
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {!hasActiveIntegrations ? (
                  <p className="text-sm text-muted-foreground">
                    No integrations connected yet. Toggle a provider below to connect it to this
                    workspace.
                  </p>
                ) : null}
                {orderedRelayCatalog.map((definition, index) => {
                  const entry = relayEntryByProvider.get(definition.id) ?? null;
                  const integration: IntegrationRecord = entry
                    ? {
                        connectionId: entry.connectionId ?? null,
                        providerConfigKey: entry.providerConfigKey ?? null,
                      }
                    : null;
                  const connected = Boolean(entry?.connectionId);
                  return (
                    <section
                      key={definition.id}
                      className={cn(
                        "flex flex-col gap-3",
                        index < orderedRelayCatalog.length - 1
                          ? "border-b border-[var(--dashboard-border)] pb-3"
                          : null,
                      )}
                    >
                      <IntegrationToggleRow
                        workspaceId={authSession.currentWorkspace.id}
                        provider={definition.id}
                        providerLabel={definition.displayName}
                        providerConfigKey={
                          integration?.providerConfigKey ?? definition.defaultConfigKey
                        }
                        integration={integration}
                        onMutate={onMutate}
                        logo={relayProviderLogo(definition.id, definition.displayName)}
                        description={
                          connected ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
                              <span>
                                Connected
                                {entry?.lastEventAt
                                  ? ` · last event ${formatRelative(entry.lastEventAt)}`
                                  : ""}
                              </span>
                            </span>
                          ) : (
                            "Not connected"
                          )
                        }
                      />
                      {connected && definition.id === "gitlab" ? (
                        <GitLabProjectPicker workspaceId={authSession.currentWorkspace.id} />
                      ) : null}
                      {connected && definition.id === "reddit" ? (
                        <RedditSubredditPicker workspaceId={authSession.currentWorkspace.id} />
                      ) : null}
                    </section>
                  );
                })}
              </div>
            )}
          </DashboardPanel>

          {SHOW_SAGE_INTEGRATIONS ? (
          <DashboardPanel
            title={
              <div className="flex items-center gap-2">
                <SageLogo className="size-6" />
                <span>Sage</span>
              </div>
            }
            description={
              <>
                Sage is your AI research and planning teammate. Mention{" "}
                <span className="font-medium text-foreground">@Sage</span> in any channel to research
                topics, ask clarifying questions, and get structured plans. Sage remembers prior
                conversations, searches your GitHub repos, and keeps your team aligned on development
                work.
              </>
            }
            className="rounded-[2rem] border-[var(--dashboard-border)] bg-[var(--dashboard-panel)]"
            contentClassName="gap-2"
          >
            <div className="flex flex-col gap-3">
              <section className="flex flex-col gap-1">
                {SLACK_APPS.filter((app) => app.provider === "slack").map((app) => (
                  <SlackAppRow
                    key={app.provider}
                    app={app}
                    workspaceId={authSession.currentWorkspace.id}
                    integration={slackIntegrations[app.provider] ?? null}
                    onMutate={onMutate}
                  />
                ))}
                {!slackIntegrations["slack"]?.connectionId ? (
                  <p className="text-xs text-muted-foreground">
                    Connect Slack to unlock additional integrations.
                  </p>
                ) : slackIntegrations["slack"]?.connectionId ? (
                  <>
                    <SlackChannelPicker
                      workspaceId={authSession.currentWorkspace.id}
                      provider="slack"
                    />
                    <SageNotifyChannelPicker
                      workspaceId={authSession.currentWorkspace.id}
                    />
                  </>
                ) : null}
              </section>

              <section className={`flex flex-col gap-3 border-b border-[var(--dashboard-border)] pb-3 ${!slackIntegrations["slack"]?.connectionId ? "opacity-40 pointer-events-none" : ""}`}>
                <NotionIntegrationRow
                  workspaceId={authSession.currentWorkspace.id}
                  integration={notionIntegration}
                  onMutate={onMutate}
                />
              </section>

              <section className={`flex flex-col gap-3 border-b border-[var(--dashboard-border)] pb-3 ${!slackIntegrations["slack"]?.connectionId ? "opacity-40 pointer-events-none" : ""}`}>
                <LinearIntegrationRow
                  workspaceId={authSession.currentWorkspace.id}
                  integration={linearIntegration}
                  onMutate={onMutate}
                />
              </section>

              <section className="flex flex-col gap-3">
                <GitHubIntegrationRow
                  workspaceId={authSession.currentWorkspace.id}
                  integration={githubIntegration}
                  onMutate={onMutate}
                />
              </section>

              <section className={`flex flex-col gap-3 ${!slackIntegrations["slack"]?.connectionId ? "opacity-40 pointer-events-none" : ""}`}>
                <GitLabIntegrationRow
                  workspaceId={authSession.currentWorkspace.id}
                  integration={gitlabIntegration}
                  onMutate={onMutate}
                />
                {gitlabIntegration?.connectionId ? (
                  <GitLabProjectPicker workspaceId={authSession.currentWorkspace.id} />
                ) : null}
              </section>

              <section className={`flex flex-col gap-3 ${!slackIntegrations["slack"]?.connectionId ? "opacity-40 pointer-events-none" : ""}`}>
                <XIntegrationRow
                  workspaceId={authSession.currentWorkspace.id}
                  integration={xIntegration}
                  onMutate={onMutate}
                />
              </section>

              <section className={`flex flex-col gap-3 ${!slackIntegrations["slack"]?.connectionId ? "opacity-40 pointer-events-none" : ""}`}>
                <RedditIntegrationRow
                  workspaceId={authSession.currentWorkspace.id}
                  integration={redditIntegration}
                  onMutate={onMutate}
                />
                {redditIntegration?.connectionId ? (
                  <RedditSubredditPicker workspaceId={authSession.currentWorkspace.id} />
                ) : null}
              </section>
            </div>
          </DashboardPanel>
          ) : null}
        </div>
      </div>
    </DashboardPageFrame>
  );
}

function SlackAppRow({
  app,
  workspaceId,
  integration,
  onMutate,
}: {
  app: SlackAppConfig;
  workspaceId: string;
  integration: IntegrationRecord;
  onMutate: () => void;
}) {
  return (
    <IntegrationToggleRow
      workspaceId={workspaceId}
      provider={app.provider}
      providerLabel="Slack"
      providerConfigKey={integration?.providerConfigKey ?? app.configKey}
      integration={integration}
      onMutate={onMutate}
      logo={SlackLogo}
      description="Connect Sage's Slack app to your workspace to be able to talk to Sage."
    />
  );
}

function GitHubIntegrationRow({
  workspaceId,
  integration,
  onMutate,
}: {
  workspaceId: string;
  integration: IntegrationRecord;
  onMutate: () => void;
}) {
  return (
    <IntegrationToggleRow
      workspaceId={workspaceId}
      provider="github"
      providerLabel="GitHub"
      providerConfigKey={integration?.providerConfigKey ?? "github-relay"}
      integration={integration}
      onMutate={onMutate}
      logo={GitHubLogo}
      description="Connect your GitHub organization so Sage can search repositories and reference pull requests."
    />
  );
}

function GitLabIntegrationRow({
  workspaceId,
  integration,
  onMutate,
}: {
  workspaceId: string;
  integration: IntegrationRecord;
  onMutate: () => void;
}) {
  return (
    <IntegrationToggleRow
      workspaceId={workspaceId}
      provider="gitlab"
      providerLabel="GitLab"
      providerConfigKey={integration?.providerConfigKey ?? "gitlab-relay"}
      integration={integration}
      onMutate={onMutate}
      logo={GitLabLogo}
      description="Connect GitLab to sync merge requests from selected projects."
    />
  );
}

function XIntegrationRow({
  workspaceId,
  integration,
  onMutate,
}: {
  workspaceId: string;
  integration: IntegrationRecord;
  onMutate: () => void;
}) {
  return (
    <IntegrationToggleRow
      workspaceId={workspaceId}
      provider="x"
      providerLabel="X"
      providerConfigKey={integration?.providerConfigKey ?? "x-relay"}
      integration={integration}
      onMutate={onMutate}
      logo={XLogo}
      description="Connect X to sync capped social-search results into RelayFile."
    />
  );
}

function RedditIntegrationRow({
  workspaceId,
  integration,
  onMutate,
}: {
  workspaceId: string;
  integration: IntegrationRecord;
  onMutate: () => void;
}) {
  return (
    <IntegrationToggleRow
      workspaceId={workspaceId}
      provider="reddit"
      providerLabel="Reddit"
      providerConfigKey={integration?.providerConfigKey ?? "reddit-composio-relay"}
      integration={integration}
      onMutate={onMutate}
      logo={Bot}
      description="Connect Reddit via Composio and choose tracked subreddits for post sync."
    />
  );
}

function LinearIntegrationRow({
  workspaceId,
  integration,
  onMutate,
}: {
  workspaceId: string;
  integration: IntegrationRecord;
  onMutate: () => void;
}) {
  return (
    <IntegrationToggleRow
      workspaceId={workspaceId}
      provider="linear"
      providerLabel="Linear"
      providerConfigKey={integration?.providerConfigKey ?? "linear-relay"}
      integration={integration}
      onMutate={onMutate}
      logo={LinearLogo}
      description="Connect Linear to sync issues and track project progress."
    />
  );
}

function NotionIntegrationRow({
  workspaceId,
  integration,
  onMutate,
}: {
  workspaceId: string;
  integration: IntegrationRecord;
  onMutate: () => void;
}) {
  return (
    <IntegrationToggleRow
      workspaceId={workspaceId}
      provider="notion"
      providerLabel="Notion"
      providerConfigKey={integration?.providerConfigKey ?? "notion-relay"}
      integration={integration}
      onMutate={onMutate}
      logo={NotionLogo}
      description="Connect Notion to access and sync your workspace pages."
    />
  );
}
