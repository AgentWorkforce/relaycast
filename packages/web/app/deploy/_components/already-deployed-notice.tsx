"use client";

import Link from "next/link";
import { Info } from "lucide-react";
import {
  formatDeployedRelative,
  type DeployedAgentMatch,
} from "../_lib/deployed-status-client";

type AlreadyDeployedNoticeProps = {
  /** null = unknown/not-checked (render nothing); [] = checked, none. */
  matches: DeployedAgentMatch[] | null;
  workspaceName: string | null;
};

/**
 * Calm informational notice on the Review step when this persona is already
 * deployed in the current workspace. Never blocks the flow — deploying again
 * remains an explicit user choice.
 *
 * Dashboard links use raw paths inside <Link> (never toAppPath) — Next adds
 * the /cloud basePath itself; pre-prefixing would double it.
 */
export function AlreadyDeployedNotice({ matches, workspaceName }: AlreadyDeployedNoticeProps) {
  if (!matches || matches.length === 0) return null;

  const where = workspaceName ? ` in ${workspaceName}` : " in this workspace";
  const single = matches.length === 1 ? matches[0] : null;

  return (
    <div
      role="note"
      className="mb-5 flex items-start gap-3 rounded-2xl border border-[var(--status-info)] bg-[var(--status-info-soft)] p-4 text-sm leading-6 text-foreground"
    >
      <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-info)]" />
      <div>
        {single ? (
          <>
            <span className="font-medium">Already deployed{where}:</span>{" "}
            <span className="font-medium">{single.deployedName}</span>, deployed{" "}
            {formatDeployedRelative(single.createdAt)}.{" "}
            <Link
              href={`/dashboard/workforce/agents/${encodeURIComponent(single.agentId)}`}
              className="font-medium text-[var(--status-info)] underline underline-offset-2"
            >
              View in dashboard →
            </Link>
          </>
        ) : (
          <>
            <span className="font-medium">Already deployed{where}:</span> {matches.length} agents
            run this persona.{" "}
            <Link
              href="/dashboard/workforce/agents"
              className="font-medium text-[var(--status-info)] underline underline-offset-2"
            >
              View in dashboard →
            </Link>
          </>
        )}{" "}
        <span className="text-muted-foreground">You can still deploy another copy below.</span>
      </div>
    </div>
  );
}
