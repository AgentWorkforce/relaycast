"use client";

import { useDeferredValue, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Hash, Loader2, Lock, Search } from "lucide-react";
import { toAppPath } from "@/lib/app-path";
import { cn } from "@/lib/utils";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

const SLACK_PROVIDERS = ["slack", "slack-my-senior-dev", "slack-nightcto"] as const;

type SlackProvider = (typeof SLACK_PROVIDERS)[number];

type SlackChannel = {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  numMembers?: number;
  topic?: string;
  purpose?: string;
};

type ConfiguredSlackChannel = {
  id: string;
  slackChannelId: string;
  slackChannelName?: string | null;
  isPrivate?: boolean;
  isEnabled?: boolean;
};

type AvailableChannelsResponse = {
  channels?: SlackChannel[];
  nextCursor?: string | null;
  error?: string;
};

type ConfiguredChannelsResponse = {
  channels?: ConfiguredSlackChannel[];
  error?: string;
};

type SaveChannelsResponse = {
  channels?: ConfiguredSlackChannel[];
  errors?: Array<{ channelId: string; error: string }>;
  error?: string;
};

type SlackChannelPickerProps = {
  workspaceId: string;
  provider: SlackProvider;
  defaultOpen?: boolean;
};

async function readJson<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

function buildChannelsPath(workspaceId: string, provider: SlackProvider) {
  return toAppPath(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(provider)}/channels`,
  );
}

async function fetchConfiguredChannels(
  workspaceId: string,
  provider: SlackProvider,
  signal?: AbortSignal,
) {
  const response = await fetch(buildChannelsPath(workspaceId, provider), {
    cache: "no-store",
    credentials: "include",
    signal,
  });
  const payload = await readJson<ConfiguredChannelsResponse>(response);
  if (!response.ok) {
    throw new Error(payload?.error ?? "Failed to load joined channels.");
  }

  return payload?.channels ?? [];
}

async function fetchAvailableChannels(
  workspaceId: string,
  provider: SlackProvider,
  cursor?: string,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams();
  if (cursor) {
    params.set("cursor", cursor);
  }

  const response = await fetch(
    `${buildChannelsPath(workspaceId, provider)}/available${params.size > 0 ? `?${params.toString()}` : ""}`,
    {
      cache: "no-store",
      credentials: "include",
      signal,
    },
  );
  const payload = await readJson<AvailableChannelsResponse>(response);
  if (!response.ok) {
    throw new Error(payload?.error ?? "Failed to load available channels.");
  }

  return {
    channels: payload?.channels ?? [],
    nextCursor: payload?.nextCursor ?? null,
  };
}

async function saveConfiguredChannels(
  workspaceId: string,
  provider: SlackProvider,
  channelIds: string[],
) {
  const response = await fetch(buildChannelsPath(workspaceId, provider), {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelIds }),
  });
  const payload = await readJson<SaveChannelsResponse>(response);
  if (!response.ok) {
    throw new Error(payload?.error ?? "Failed to save channels.");
  }

  return {
    channels: payload?.channels ?? null,
    errors: payload?.errors ?? [],
  };
}

function mergeChannels(existing: SlackChannel[], incoming: SlackChannel[]) {
  const merged = new Map(existing.map((channel) => [channel.id, channel]));
  for (const channel of incoming) {
    merged.set(channel.id, channel);
  }

  return Array.from(merged.values());
}

function sameSelections(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}

export function SlackChannelPicker({
  workspaceId,
  provider,
  defaultOpen = false,
}: SlackChannelPickerProps) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const [availableChannels, setAvailableChannels] = useState<SlackChannel[]>([]);
  const [configuredChannels, setConfiguredChannels] = useState<ConfiguredSlackChannel[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [initialLoading, setInitialLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<Array<{ channelId: string; error: string }>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) {
      return;
    }

    const controller = new AbortController();

    setInitialLoading(true);
    setAvailableChannels([]);
    setConfiguredChannels([]);
    setSelected(new Set());
    setError(null);
    setSaveErrors([]);
    setNextCursor(null);

    async function loadInitialState() {
      const [configuredResult, availableResult] = await Promise.allSettled([
        fetchConfiguredChannels(workspaceId, provider, controller.signal),
        fetchAvailableChannels(workspaceId, provider, undefined, controller.signal),
      ]);

      if (controller.signal.aborted) {
        return;
      }

      let nextError: string | null = null;

      if (configuredResult.status === "fulfilled") {
        setConfiguredChannels(configuredResult.value);
        setSelected(new Set(configuredResult.value.map((channel) => channel.slackChannelId)));
      } else {
        nextError =
          configuredResult.reason instanceof Error
            ? configuredResult.reason.message
            : "Failed to load joined channels.";
      }

      if (availableResult.status === "fulfilled") {
        setAvailableChannels(availableResult.value.channels);
        setNextCursor(availableResult.value.nextCursor);
      } else if (!nextError) {
        nextError =
          availableResult.reason instanceof Error
            ? availableResult.reason.message
            : "Failed to load available channels.";
      }

      setError(nextError);
      setInitialLoading(false);
    }

    void loadInitialState().catch((cause) => {
      if (controller.signal.aborted) {
        return;
      }

      setError(cause instanceof Error ? cause.message : "Failed to load channels.");
      setInitialLoading(false);
    });

    return () => controller.abort();
  }, [expanded, workspaceId, provider]);

  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const filteredChannels = availableChannels.filter((channel) =>
    normalizedQuery.length === 0 ? true : channel.name.toLowerCase().includes(normalizedQuery),
  );
  const configuredSelection = new Set(
    configuredChannels
      .filter((channel) => channel.isEnabled ?? true)
      .map((channel) => channel.slackChannelId),
  );
  const hasUnsavedChanges = !sameSelections(selected, configuredSelection);

  function toggleChannel(channelId: string) {
    setSaveErrors([]);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(channelId)) {
        next.delete(channelId);
      } else {
        next.add(channelId);
      }
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaveErrors([]);

    try {
      const requestedChannelIds = Array.from(selected).sort();
      const result = await saveConfiguredChannels(workspaceId, provider, requestedChannelIds);
      setSaveErrors(result.errors);
      if (result.channels) {
        setConfiguredChannels(result.channels);
      }

      try {
        const refreshedChannels = await fetchConfiguredChannels(workspaceId, provider);
        setConfiguredChannels(refreshedChannels);
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Channels were saved, but the refresh failed.",
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save channels.");
    } finally {
      setSaving(false);
    }
  }

  async function handleLoadMore() {
    if (!nextCursor) {
      return;
    }

    setLoadingMore(true);
    setError(null);

    try {
      const result = await fetchAvailableChannels(workspaceId, provider, nextCursor);
      setAvailableChannels((current) => mergeChannels(current, result.channels));
      setNextCursor(result.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load more channels.");
    } finally {
      setLoadingMore(false);
    }
  }

  function getChannelLabel(channelId: string) {
    return (
      configuredChannels.find((channel) => channel.slackChannelId === channelId)?.slackChannelName ||
      availableChannels.find((channel) => channel.id === channelId)?.name ||
      channelId
    );
  }

  return (
    <div className="rounded-[1.5rem] border border-[var(--border-default)] bg-[var(--surface-soft)] p-4">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            className="flex min-w-0 flex-1 items-start gap-3 rounded-xl text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-[var(--border-default)] bg-card text-muted-foreground">
              {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-semibold text-foreground">Channel access</span>
              <span className="text-sm leading-6 text-muted-foreground">
                Select the Slack channels this app should join and keep available for agent replies.
              </span>
            </span>
          </button>
          {expanded ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="normal-case tracking-normal">{selected.size} selected</Badge>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleSave()}
                disabled={initialLoading || saving || !hasUnsavedChanges}
                className="min-w-[6rem]"
              >
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          ) : (
            <Badge className="normal-case tracking-normal">
              {configuredChannels.length > 0
                ? `${configuredChannels.length} configured`
                : "Collapsed"}
            </Badge>
          )}
        </div>

        {expanded ? (
          <>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Joined
                </span>
                <span className="text-xs text-muted-foreground">
                  {configuredChannels.length} configured
                </span>
              </div>
              {configuredChannels.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {configuredChannels.map((channel) => (
                    <Badge
                      key={channel.id}
                      className="gap-1.5 rounded-full normal-case tracking-normal"
                    >
                      {channel.isPrivate ? <Lock className="size-3" /> : <Hash className="size-3" />}
                      {channel.slackChannelName || channel.slackChannelId}
                    </Badge>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-card px-4 py-3 text-sm text-muted-foreground">
                  No channels joined yet.
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3 rounded-[1.25rem] border border-[var(--border-default)] bg-card p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search channels"
                className="border-[var(--border-default)] bg-[var(--surface-soft)] pl-9 shadow-none focus-visible:border-[var(--border-strong)] focus-visible:ring-primary/20"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {availableChannels.length} loaded
              {nextCursor ? " with more available" : ""}
            </p>
          </div>

          {error ? (
            <div className="rounded-xl border border-[var(--status-danger)] bg-[var(--status-danger-soft)] px-4 py-3 text-sm text-[var(--status-danger)]">
              {error}
            </div>
          ) : null}

          {saveErrors.length > 0 ? (
            <div className="rounded-xl border border-[var(--status-warning)] bg-[var(--status-warning-soft)] px-4 py-3 text-sm text-[var(--status-warning)]">
              <p className="font-medium">Some channels could not be saved.</p>
              <div className="mt-2 flex flex-col gap-1">
                {saveErrors.map((saveError) => (
                  <p key={`${saveError.channelId}:${saveError.error}`}>
                    <span className="font-semibold">{getChannelLabel(saveError.channelId)}</span>:{" "}
                    {saveError.error}
                  </p>
                ))}
              </div>
            </div>
          ) : null}

          {initialLoading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <div
                  key={index}
                  className="h-20 rounded-[1.25rem] border border-[var(--border-default)] bg-[var(--surface-soft)]"
                />
              ))}
            </div>
          ) : filteredChannels.length > 0 ? (
            <div className="max-h-80 overflow-y-auto pr-1">
              <div className="flex flex-col gap-2">
                {filteredChannels.map((channel) => {
                  const checked = selected.has(channel.id);
                  const summary =
                    channel.topic?.trim() ||
                    channel.purpose?.trim() ||
                    (channel.isMember
                      ? "This app is already a member of the channel."
                      : "Select to add this channel to the app configuration.");

                  return (
                    <label
                      key={channel.id}
                      htmlFor={`${provider}-${channel.id}`}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-[1.25rem] border p-3 transition-colors",
                        checked
                          ? "border-[var(--border-strong)] bg-[var(--surface-soft)]"
                          : "border-[var(--border-default)] bg-card hover:bg-[var(--surface-soft)]",
                      )}
                    >
                      <input
                        id={`${provider}-${channel.id}`}
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleChannel(channel.id)}
                        className="mt-1 size-4 rounded border-[var(--border-strong)] accent-primary"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                            {channel.isPrivate ? (
                              <Lock className="size-3.5" />
                            ) : (
                              <Hash className="size-3.5" />
                            )}
                            <span className="truncate">{channel.name}</span>
                          </span>
                          {channel.isMember ? (
                            <Badge className="normal-case tracking-normal">Member</Badge>
                          ) : null}
                          {typeof channel.numMembers === "number" ? (
                            <span className="text-xs text-muted-foreground">
                              {channel.numMembers.toLocaleString()} members
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">{summary}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-soft)] px-4 py-8 text-center text-sm text-muted-foreground">
              {normalizedQuery
                ? `No channels matching "${deferredQuery.trim()}" in the loaded results.`
                : "No channels available right now."}
            </div>
          )}

          {nextCursor ? (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleLoadMore()}
                disabled={loadingMore}
                className="border-[var(--border-default)] bg-[var(--surface-soft)] hover:bg-[var(--surface-soft)]"
              >
                {loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}
                {loadingMore ? "Loading..." : "Load more"}
              </Button>
            </div>
          ) : null}
            </div>
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-card px-4 py-3 text-sm text-muted-foreground">
            Expand channel access to choose which Slack channels Sage can join and keep available
            for replies.
          </div>
        )}
      </div>
    </div>
  );
}
