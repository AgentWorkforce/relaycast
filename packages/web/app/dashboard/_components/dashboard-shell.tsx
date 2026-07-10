"use client";

import type { LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Brain, ChevronRight, LogOut, Puzzle, Settings2 } from "lucide-react";
import { stripAppBasePath } from "@/lib/app-path";
import { LogoIcon, LogoWordmark } from "../../components/Brand";
import { Avatar, AvatarFallback, AvatarImage } from "../../components/ui/avatar";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Separator } from "../../components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "../../components/ui/sidebar";
import { getUserInitials, useDashboard } from "./dashboard-data";

type NavItem = {
  href: string;
  icon: LucideIcon;
  label: string;
};

const primaryItems: NavItem[] = [
  { href: "/dashboard", icon: Bot, label: "Agents" },
  { href: "/dashboard/integrations", icon: Puzzle, label: "Integrations" },
  { href: "/dashboard/reflex", icon: Brain, label: "Reflex" },
];

const settingsItem: NavItem = {
  href: "/dashboard/settings",
  icon: Settings2,
  label: "Settings",
};

function isActivePath(pathname: string, href: string) {
  if (href === "/dashboard") {
    return (
      pathname === "/dashboard" ||
      pathname.startsWith("/dashboard/agents") ||
      pathname.startsWith("/dashboard/workflow/")
    );
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

function getPageLabel(pathname: string) {
  if (pathname.startsWith("/dashboard/workflow/")) {
    return "Workflow run";
  }

  if (pathname.startsWith("/dashboard/agents")) {
    return "Browse agents";
  }

  if (pathname.startsWith("/dashboard/workforce")) {
    return "Workforce";
  }

  if (pathname.startsWith("/dashboard/integrations")) {
    return "Integrations";
  }

  if (pathname.startsWith("/dashboard/reflex")) {
    return "Reflex";
  }

  if (pathname.startsWith("/dashboard/fleet")) {
    return "Fleet";
  }

  if (pathname.startsWith("/dashboard/relayfile")) {
    return "Relayfile";
  }

  if (pathname.startsWith("/dashboard/settings")) {
    return "Settings";
  }

  return "Agents";
}

function SidebarWorkspaceCard() {
  const { authSession } = useDashboard();

  if (!authSession) {
    return null;
  }

  return (
    <Link href="/dashboard" className="block">
      <Card className="rounded-[1.5rem] border-border bg-card shadow-[0_16px_40px_-32px_var(--shadow-color)]">
        <CardContent className="p-3">
          <div className="flex items-center gap-3 pt-2">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
              <LogoIcon className="h-5 text-current" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-foreground">
                {authSession.currentOrganization.name}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {authSession.currentWorkspace.name}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function SidebarBrand() {
  return (
    <Link
      href="/dashboard"
      className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-[var(--nav-logo-wordmark)]"
    >
      <LogoIcon className="h-7 text-[var(--nav-logo-mark)]" />
      <LogoWordmark className="h-5 text-[var(--nav-logo-wordmark)]" />
    </Link>
  );
}

function DashboardNav({ pathname }: { pathname: string }) {
  return (
    <SidebarGroup className="gap-3">
      <SidebarGroupLabel className="px-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        Platform
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {primaryItems.map((item) => {
            const Icon = item.icon;
            const content = (
              <>
                <Icon />
                <span>{item.label}</span>
                <ChevronRight className="ml-auto opacity-45" />
              </>
            );

            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton
                  asChild
                  isActive={isActivePath(pathname, item.href)}
                  className="h-10 rounded-xl px-3"
                >
                  <Link href={item.href}>{content}</Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function SidebarSettings({ pathname }: { pathname: string }) {
  const Icon = settingsItem.icon;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          isActive={isActivePath(pathname, settingsItem.href)}
          className="h-10 rounded-xl px-3"
        >
          <Link href={settingsItem.href}>
            <Icon />
            <span>{settingsItem.label}</span>
            <ChevronRight className="ml-auto opacity-45" />
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function SidebarAccount() {
  const { authPending, authSession, logout } = useDashboard();

  if (!authSession) {
    return null;
  }

  const initials = getUserInitials(authSession.user.name, authSession.user.email);

  return (
    <Card className="rounded-[1.5rem] border-border bg-card shadow-[0_16px_40px_-32px_var(--shadow-color)]">
      <CardContent className="flex flex-col gap-4 p-3">
        <div className="flex items-center gap-3">
          <Avatar size="lg">
            <AvatarImage src={authSession.user.avatarUrl ?? undefined} alt="" />
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground">
              {authSession.user.name || authSession.user.email || "Cloud user"}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {authSession.user.email || "Signed in"}
            </p>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="w-full justify-between rounded-xl"
          disabled={authPending}
          onClick={logout}
        >
          <span>{authPending ? "Logging out..." : "Logout"}</span>
          <LogOut data-icon="inline-end" />
        </Button>
      </CardContent>
    </Card>
  );
}

function DashboardBackdrop({ children }: { children: ReactNode }) {
  return (
    <div
      className="min-h-screen bg-[var(--dashboard-shell-bg)] text-foreground"
      style={
        {
          background:
            "radial-gradient(circle at top left, color-mix(in srgb, var(--primary) 14%, transparent) 0%, transparent 34%), linear-gradient(180deg, var(--hero-gradient) 0%, var(--bg) 36%, var(--bg) 100%)",
          "--status-info": "var(--brand-primary)",
          "--status-info-soft": "var(--brand-primary-faint)",
          "--dashboard-shell-bg": "var(--background)",
          "--dashboard-canvas": "color-mix(in srgb, var(--bg-elevated) 90%, var(--background))",
          "--dashboard-panel": "var(--card-bg)",
          "--dashboard-panel-soft": "var(--surface)",
          "--dashboard-sidebar": "var(--nav-bg)",
          "--dashboard-sidebar-accent": "var(--nav-surface-hover)",
          "--dashboard-sidebar-foreground": "var(--nav-fg)",
          "--dashboard-sidebar-muted": "var(--nav-muted)",
          "--dashboard-border": "var(--nav-border)",
          "--dashboard-border-strong": "var(--nav-border-strong)",
          "--dashboard-muted": "var(--fg-muted)",
          "--dashboard-shadow": "var(--nav-shadow)",
          "--nav-logo-wordmark": "var(--nav-fg)",
          "--nav-logo-mark": "var(--primary)",
          "--sidebar": "var(--nav-bg)",
          "--sidebar-foreground": "var(--nav-fg)",
          "--sidebar-primary": "var(--primary)",
          "--sidebar-primary-foreground": "var(--primary-fg)",
          "--sidebar-accent": "var(--nav-surface-hover)",
          "--sidebar-accent-foreground": "var(--nav-fg)",
          "--sidebar-border": "var(--nav-border)",
          "--sidebar-ring": "var(--primary)",
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const rawPathname = usePathname();
  const pathname = stripAppBasePath(rawPathname) || rawPathname || "/dashboard";
  const { authenticated, authSession } = useDashboard();

  if (!authenticated || !authSession) {
    return (
      <DashboardBackdrop>
        <main className="min-h-screen">{children}</main>
      </DashboardBackdrop>
    );
  }

  return (
    <DashboardBackdrop>
      <SidebarProvider
        defaultOpen
        className="min-w-0 overflow-x-clip"
        style={
          {
            "--sidebar-width": "17rem",
          } as CSSProperties
        }
      >
        <Sidebar collapsible="offcanvas" className="border-r border-border bg-sidebar">
          <SidebarHeader className="gap-4 px-3 py-4">
            <SidebarBrand />
            <SidebarWorkspaceCard />
          </SidebarHeader>

          <SidebarContent className="px-3 pb-4 pt-2">
            <DashboardNav pathname={pathname} />
          </SidebarContent>

          <SidebarFooter className="gap-4 px-3 py-4">
            <SidebarSettings pathname={pathname} />
            <Separator />
            <SidebarAccount />
          </SidebarFooter>
        </Sidebar>

        <SidebarInset className="bg-transparent">
          <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-border bg-[color-mix(in_srgb,var(--dashboard-sidebar)_94%,transparent)] px-4 backdrop-blur md:hidden">
            <SidebarTrigger className="-ml-1" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">{getPageLabel(pathname)}</p>
              <p className="truncate text-xs text-muted-foreground">
                {authSession.currentWorkspace.name}
              </p>
            </div>
          </header>

          <div className="min-h-screen min-w-0 overflow-x-clip">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </DashboardBackdrop>
  );
}
