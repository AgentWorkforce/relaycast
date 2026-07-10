"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, RefreshCcw, Save, Search } from "lucide-react";
import { toAppPath } from "@/lib/app-path";
import { cn } from "@/lib/utils";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../components/ui/sheet";

type SubredditResource = {
  id: string;
  name?: string;
  path?: string;
  url: string;
  avatarUrl?: string;
};

type MetadataResponse = {
  metadata?: {
    subreddits?: string[];
  };
  error?: string;
};

type AccessibleResourcesResponse = {
  resources?: SubredditResource[];
  error?: string;
};

type RedditSubredditPickerProps = {
  workspaceId: string;
};

async function readJson<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

function metadataPath(workspaceId: string) {
  return toAppPath(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/reddit/metadata`,
  );
}

function resourcesPath(workspaceId: string, query: string) {
  const base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/reddit/accessible-resources`;
  return toAppPath(query.trim().length > 0 ? `${base}?q=${encodeURIComponent(query.trim())}` : base);
}

async function fetchMetadata(workspaceId: string, signal?: AbortSignal) {
  const response = await fetch(metadataPath(workspaceId), {
    cache: "no-store",
    credentials: "include",
    signal,
  });
  const payload = await readJson<MetadataResponse>(response);
  if (!response.ok) {
    throw new Error(payload?.error ?? "Failed to load selected Reddit subreddits.");
  }
  return payload?.metadata ?? {};
}

async function fetchSubreddits(workspaceId: string, query: string, signal?: AbortSignal) {
  const response = await fetch(resourcesPath(workspaceId, query), {
    cache: "no-store",
    credentials: "include",
    signal,
  });
  const payload = await readJson<AccessibleResourcesResponse>(response);
  if (!response.ok) {
    throw new Error(payload?.error ?? "Failed to load Reddit subreddits.");
  }
  return payload?.resources ?? [];
}

async function saveSubreddits(workspaceId: string, subreddits: string[]) {
  const response = await fetch(metadataPath(workspaceId), {
    method: "PUT",
    cache: "no-store",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      metadata: {
        subreddits,
      },
    }),
  });
  const payload = await readJson<{ error?: string }>(response);
  if (!response.ok) {
    throw new Error(payload?.error ?? "Failed to save Reddit subreddit selection.");
  }
}

export function RedditSubredditPicker({ workspaceId }: RedditSubredditPickerProps) {
  const [open, setOpen] = useState(false);
  const [subreddits, setSubreddits] = useState<SubredditResource[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    async function load() {
      const [metadata, available] = await Promise.all([
        fetchMetadata(workspaceId, controller.signal),
        fetchSubreddits(workspaceId, "", controller.signal),
      ]);
      if (controller.signal.aborted) {
        return;
      }

      const savedIds = new Set((metadata.subreddits ?? []).map((name) => normalizeSubreddit(name)));
      setSubreddits(available);
      setSelected(savedIds);
      setSaved(savedIds);
      setLoading(false);
    }

    void load().catch((cause) => {
      if (controller.signal.aborted) {
        return;
      }
      setError(cause instanceof Error ? cause.message : "Failed to load Reddit subreddits.");
      setLoading(false);
    });

    return () => controller.abort();
  }, [open, workspaceId]);

  const selectedSubredditNames = useMemo(
    () => Array.from(selected).sort((left, right) => left.localeCompare(right)),
    [selected],
  );

  const dirty = !sameSelections(selected, saved);

  function toggleSubreddit(subredditId: string) {
    const normalized = normalizeSubreddit(subredditId);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(normalized)) {
        next.delete(normalized);
      } else {
        next.add(normalized);
      }
      return next;
    });
  }

  async function handleRefresh() {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    try {
      const next = await fetchSubreddits(workspaceId, query, controller.signal);
      setSubreddits(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to refresh subreddit list.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await saveSubreddits(workspaceId, selectedSubredditNames);
      setSaved(new Set(selected));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save subreddit selection.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--dashboard-border)] bg-[var(--surface-soft)] p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Tracked subreddits</p>
          <p className="truncate text-xs text-muted-foreground">
            {saved.size > 0 ? `${saved.size} selected for post sync` : "Select subreddit feeds to sync"}
          </p>
        </div>

        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button type="button" variant="outline" size="sm">Manage</Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-full sm:max-w-xl">
            <SheetHeader>
              <SheetTitle>Tracked subreddits</SheetTitle>
              <SheetDescription>
                Choose which subreddits feed the Reddit sync.
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-1 flex-col gap-3 px-4 pb-4">
              <div className="flex items-center gap-2">
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search subreddits (optional)"
                />
                <Button type="button" size="sm" variant="outline" onClick={handleRefresh} disabled={loading}>
                  {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                </Button>
              </div>

              {loading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Loading subreddits
                </div>
              ) : subreddits.length > 0 ? (
                <div className="max-h-[52vh] overflow-y-auto rounded-md border border-[var(--dashboard-border)] bg-card">
                  {subreddits.map((subreddit) => {
                    const id = normalizeSubreddit(subreddit.id);
                    const checked = selected.has(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        className="flex w-full items-center gap-3 border-b border-[var(--dashboard-border)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--surface-soft)]"
                        onClick={() => toggleSubreddit(id)}
                      >
                        <span
                          className={cn(
                            "flex size-5 shrink-0 items-center justify-center rounded border",
                            checked
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-[var(--border-default)] bg-transparent",
                          )}
                        >
                          {checked ? <Check className="size-3.5" /> : null}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {subreddit.name ?? subreddit.path ?? `r/${id}`}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {subreddit.path ?? `r/${id}`}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No subreddits were returned.</p>
              )}

              {error ? <p className="text-xs text-red-600">{error}</p> : null}

              <div className="mt-auto flex items-center justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={handleRefresh} disabled={loading}>
                  {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCcw className="size-4" />}
                  Refresh
                </Button>
                <Button type="button" size="sm" disabled={!dirty || saving} onClick={handleSave}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  Save
                </Button>
              </div>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}

function normalizeSubreddit(value: string): string {
  return value.trim().replace(/^r\//i, "").toLowerCase();
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
