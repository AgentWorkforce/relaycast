"use client";

import { useState } from "react";
import { KeyRound, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { useNangoConnect } from "../_lib/use-nango-connect";

/**
 * Prompt shown when `/api/persona/resolve` is blocked by a 403 `no-access`:
 * the persona lives in a private GitHub repo this workspace can't read yet. The
 * remedy is to take the operator through our GitHub OAuth flow so we can read
 * the repo's contents, then re-resolve.
 *
 * We connect the `github-oauth-relay` user-identity integration. Its connection
 * is persisted server-side by the Nango auth webhook (see
 * `nango-webhook-router` / `github-oauth-identity.ts`), so the client only has
 * to open the Connect UI and then re-resolve. We re-resolve on an *explicit*
 * connect only — never a passive already-connected check — to avoid a
 * resolve → connect → resolve loop.
 *
 * Mirror of the server-side `GITHUB_OAUTH_IDENTITY_CONFIG_KEY`; kept as a local
 * literal because that module pulls in server-only deps (db, nango) and can't
 * be imported into a client component.
 */
const GITHUB_OAUTH_RELAY_CONFIG_KEY = "github-oauth-relay";

type GithubAccessPromptProps = {
  workspaceId: string | null;
  /** Re-run the persona resolve after access is (hopefully) granted. */
  onReload: () => void;
  /** True while the parent is re-resolving, to disable actions. */
  reloading: boolean;
};

export function GithubAccessPrompt({ workspaceId, onReload, reloading }: GithubAccessPromptProps) {
  const { requestSession, openConnectUi } = useNangoConnect(workspaceId ?? "");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connectGithub() {
    if (!workspaceId) {
      setError("Choose a workspace before connecting GitHub.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const token = await requestSession([GITHUB_OAUTH_RELAY_CONFIG_KEY]);
      await openConnectUi(token);
      onReload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "GitHub authorization failed.");
    } finally {
      setConnecting(false);
    }
  }

  const busy = connecting || reloading;

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy || !workspaceId} onClick={() => void connectGithub()}>
          {connecting ? <Loader2 aria-hidden="true" className="animate-spin" /> : <KeyRound aria-hidden="true" />}
          {connecting ? "Authorizing" : "Connect GitHub"}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onReload}>
          <RefreshCw aria-hidden="true" />
          Retry
        </Button>
      </div>

      {!workspaceId ? (
        <p className="text-[var(--status-danger)]/90">
          Choose a workspace in the wizard below first, then connect GitHub here.
        </p>
      ) : null}

      {error ? <p className="text-[var(--status-danger)]">{error}</p> : null}
    </div>
  );
}
