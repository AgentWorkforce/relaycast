"use client";

import { useCallback, useEffect, useState } from "react";
import { Hash, Loader2 } from "lucide-react";

import { toAppPath } from "@/lib/app-path";

import { Button } from "../../components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

/**
 * Notify-channel picker under Integrations → Slack. Lets the workspace
 * admin pick the single channel sage's proactive follow-ups loop posts
 * to. Persists via cloud's `/api/v1/workspaces/.../slack-sage/notify-channel`
 * route which proxies to sage with the shared `sageCloudApiToken`.
 *
 * Without an explicit pick, sage's `pickChannel` fallback chain
 * (`#general` → first joined) handles delivery — this picker is the
 * "set it explicitly so sage stops guessing" surface the user asked for.
 */

type Props = {
  workspaceId: string;
};

type BotChannel = {
  id: string;
  name: string;
};

type NotifyChannelPref = {
  channel: string;
  confirmed: boolean;
  unconfirmedPosts: number;
};

type NotifyChannelResponse = {
  pref: NotifyChannelPref | null;
  prefStoreAvailable: boolean;
};

type BotChannelsResponse = {
  channels: BotChannel[];
};

type ApiError = {
  error?: { message?: string };
};

const NO_CHANNEL_VALUE = "__none__";

function notifyChannelPath(workspaceId: string): string {
  return toAppPath(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/slack-sage/notify-channel`,
  );
}

function botChannelsPath(workspaceId: string): string {
  return toAppPath(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/slack-sage/bot-channels`,
  );
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function SageNotifyChannelPicker({ workspaceId }: Props) {
  const [channels, setChannels] = useState<BotChannel[]>([]);
  const [pref, setPref] = useState<NotifyChannelPref | null>(null);
  const [prefStoreAvailable, setPrefStoreAvailable] = useState(true);
  const [selected, setSelected] = useState<string>(NO_CHANNEL_VALUE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [channelsRes, prefRes] = await Promise.all([
        fetch(botChannelsPath(workspaceId), {
          credentials: "include",
          cache: "no-store",
        }),
        fetch(notifyChannelPath(workspaceId), {
          credentials: "include",
          cache: "no-store",
        }),
      ]);

      const channelsBody = await readJson<BotChannelsResponse & ApiError>(channelsRes);
      const prefBody = await readJson<NotifyChannelResponse & ApiError>(prefRes);

      if (!channelsRes.ok) {
        throw new Error(
          channelsBody?.error?.message ?? "Failed to load bot-member channels",
        );
      }
      if (!prefRes.ok) {
        throw new Error(
          prefBody?.error?.message ?? "Failed to load the current notify channel",
        );
      }

      const sortedChannels = [...(channelsBody?.channels ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      setChannels(sortedChannels);
      setPref(prefBody?.pref ?? null);
      // PREFS KV may be unbound on this deployment (sage-side feature
      // flag / fresh stage). Surface that to the UI so the picker
      // disables actions instead of silently no-oping the admin's save.
      setPrefStoreAvailable(prefBody?.prefStoreAvailable !== false);
      setSelected(prefBody?.pref?.channel ?? NO_CHANNEL_VALUE);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load notify channel");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    if (selected === NO_CHANNEL_VALUE || saving) return;
    setSaving(true);
    setError(null);
    setStatusMessage(null);
    try {
      const response = await fetch(notifyChannelPath(workspaceId), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: selected }),
      });
      const body = await readJson<NotifyChannelResponse & ApiError>(response);
      if (!response.ok) {
        throw new Error(body?.error?.message ?? "Failed to save notify channel");
      }
      setPref(body?.pref ?? null);
      setStatusMessage("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setStatusMessage(null);
    try {
      const response = await fetch(notifyChannelPath(workspaceId), {
        method: "DELETE",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await readJson<NotifyChannelResponse & ApiError>(response);
      if (!response.ok) {
        throw new Error(body?.error?.message ?? "Failed to clear notify channel");
      }
      setPref(null);
      setSelected(NO_CHANNEL_VALUE);
      setStatusMessage("Cleared. Sage will pick #general (or first joined) until you set a channel.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear");
    } finally {
      setSaving(false);
    }
  };

  const dirty = selected !== NO_CHANNEL_VALUE && selected !== (pref?.channel ?? "");

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--dashboard-border)] bg-[var(--dashboard-panel)] p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">Proactive notify channel</span>
        {pref?.confirmed ? (
          <span className="text-xs text-muted-foreground">confirmed</span>
        ) : pref ? (
          <span className="text-xs text-muted-foreground">unconfirmed</span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Where sage posts proactive follow-ups when there&apos;s no original thread to reply in. Defaults to <code>#general</code> (or the first channel sage has joined) when unset.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Loading channels…
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={selected}
            onValueChange={setSelected}
            disabled={saving || !prefStoreAvailable}
          >
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Pick a channel" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_CHANNEL_VALUE} disabled>
                Pick a channel
              </SelectItem>
              {channels.map((channel) => (
                <SelectItem key={channel.id} value={channel.id}>
                  <span className="flex items-center gap-1">
                    <Hash className="size-3" />
                    {channel.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            onClick={save}
            disabled={!dirty || saving || selected === NO_CHANNEL_VALUE || !prefStoreAvailable}
          >
            {saving ? <Loader2 className="size-3 animate-spin" /> : "Save"}
          </Button>
          {pref ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={clear}
              disabled={saving || !prefStoreAvailable}
            >
              Clear
            </Button>
          ) : null}
        </div>
      )}

      {!prefStoreAvailable && !loading ? (
        <p className="text-xs text-amber-600">
          Sage&apos;s preferences storage isn&apos;t configured on this deployment, so picks can&apos;t be saved. Sage will keep using its automatic fallback (<code>#general</code> → first joined channel) until the operator wires <code>PREFS</code>.
        </p>
      ) : null}

      {channels.length === 0 && !loading && !error ? (
        <p className="text-xs text-muted-foreground">
          Sage isn&apos;t a member of any channels yet. Invite <code>@sage</code> to a channel first.
        </p>
      ) : null}

      {error ? <p className="text-xs text-red-600">{error}</p> : null}
      {statusMessage ? (
        <p className="text-xs text-emerald-600">{statusMessage}</p>
      ) : null}
    </div>
  );
}
