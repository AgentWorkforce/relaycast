import Link from "next/link";
import { Badge } from "@/app/components/ui/badge";
import { buttonVariants } from "@/app/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";

type WorkspaceSurfaceHeaderProps = {
  workspaceId: string;
  workspaceName: string;
  organizationName: string;
  title: string;
  description: string;
  actions?: Array<{
    href: string;
    label: string;
    variant?: "default" | "outline" | "secondary" | "ghost" | "link" | "destructive";
  }>;
};

export function WorkspaceSurfaceHeader({
  workspaceId,
  workspaceName,
  organizationName,
  title,
  description,
  actions,
}: WorkspaceSurfaceHeaderProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href={`/workspaces/${encodeURIComponent(workspaceId)}/agents`}
              className={buttonVariants({ variant: "outline" })}
            >
              Agents
            </Link>
            <Link
              href={`/workspaces/${encodeURIComponent(workspaceId)}/dlq`}
              className={buttonVariants({ variant: "outline" })}
            >
              DLQ
            </Link>
            <Link
              href={`/workspaces/${encodeURIComponent(workspaceId)}/logs`}
              className={buttonVariants({ variant: "outline" })}
            >
              Logs
            </Link>
            {actions?.map((action) => (
              <Link
                key={action.href}
                href={action.href}
                className={buttonVariants({ variant: action.variant })}
              >
                {action.label}
              </Link>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3 text-sm text-[var(--text-secondary)]">
        <Badge variant="info">{workspaceName}</Badge>
        <span>{organizationName}</span>
      </CardContent>
    </Card>
  );
}
