"use client";

import { Building2 } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import type { DeploySession } from "../../_lib/use-deploy-session";
import { buildDeployLoginHref } from "../../_lib/deploy-login-href";

type StepWorkspaceProps = {
  session: DeploySession;
};

export function StepWorkspace({ session }: StepWorkspaceProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const signInHref = buildDeployLoginHref(pathname, searchParams);

  if (session.status === "loading") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Resolving workspace</CardTitle>
          <CardDescription>Checking your cloud session.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (session.status === "anonymous") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Sign in to continue</CardTitle>
          <CardDescription>Choose a workspace before launching this agent.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <a href={signInHref}>Sign in to continue</a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const currentWorkspace = session.currentWorkspace;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace</CardTitle>
        <CardDescription>This is where the deployed agent will run.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex gap-4 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-5">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <Building2 aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="font-medium text-foreground">{currentWorkspace?.name ?? "No workspace selected"}</p>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {currentWorkspace?.slug ?? "Select a workspace"}
            </p>
          </div>
        </div>

        {session.workspaces.length > 1 ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-foreground">Switch workspace</p>
            <Select value={currentWorkspace?.id ?? ""} onValueChange={session.selectWorkspace}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select workspace" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {session.workspaces.map((workspace) => (
                    <SelectItem key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
