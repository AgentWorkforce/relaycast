"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Loader2, RefreshCcw } from "lucide-react";
import { toAppPath } from "@/lib/app-path";
import { cn } from "@/lib/utils";
import { Button } from "../../components/ui/button";

type GitLabProject = {
  id: string;
  name?: string;
  path?: string;
  url: string;
  avatarUrl?: string;
};

type MetadataResponse = {
  metadata?: {
    projectIds?: string[];
    projects?: Array<{
      id: string | number;
      path_with_namespace?: string;
      name?: string;
      web_url?: string;
    }>;
  };
  error?: string;
};

type AccessibleResourcesResponse = {
  resources?: GitLabProject[];
  error?: string;
};

type GitLabProjectPickerProps = {
  workspaceId: string;
};

async function readJson<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

function metadataPath(workspaceId: string) {
  return toAppPath(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/gitlab/metadata`,
  );
}

function resourcesPath(workspaceId: string) {
  return toAppPath(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/gitlab/accessible-resources`,
  );
}

async function fetchMetadata(workspaceId: string, signal?: AbortSignal) {
  const response = await fetch(metadataPath(workspaceId), {
    cache: "no-store",
    credentials: "include",
    signal,
  });
  const payload = await readJson<MetadataResponse>(response);
  if (!response.ok) {
    throw new Error(payload?.error ?? "Failed to load selected GitLab projects.");
  }
  return payload?.metadata ?? {};
}

async function fetchProjects(workspaceId: string, signal?: AbortSignal) {
  const response = await fetch(resourcesPath(workspaceId), {
    cache: "no-store",
    credentials: "include",
    signal,
  });
  const payload = await readJson<AccessibleResourcesResponse>(response);
  if (!response.ok) {
    throw new Error(payload?.error ?? "Failed to load GitLab projects.");
  }
  return payload?.resources ?? [];
}

async function saveProjects(workspaceId: string, projects: GitLabProject[]) {
  const response = await fetch(metadataPath(workspaceId), {
    method: "PUT",
    cache: "no-store",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      metadata: {
        projectIds: projects.map((project) => project.id),
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          path_with_namespace: project.path,
          web_url: project.url,
        })),
      },
    }),
  });
  const payload = await readJson<{ error?: string }>(response);
  if (!response.ok) {
    throw new Error(payload?.error ?? "Failed to save GitLab project selection.");
  }
}

export function GitLabProjectPicker({ workspaceId }: GitLabProjectPickerProps) {
  const [expanded, setExpanded] = useState(false);
  const [projects, setProjects] = useState<GitLabProject[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) {
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    async function load() {
      const [metadata, availableProjects] = await Promise.all([
        fetchMetadata(workspaceId, controller.signal),
        fetchProjects(workspaceId, controller.signal),
      ]);
      if (controller.signal.aborted) {
        return;
      }
      const savedIds = new Set((metadata.projectIds ?? []).map(String));
      setProjects(availableProjects);
      setSelected(savedIds);
      setSaved(savedIds);
      setLoading(false);
    }

    void load().catch((cause) => {
      if (controller.signal.aborted) {
        return;
      }
      setError(cause instanceof Error ? cause.message : "Failed to load GitLab projects.");
      setLoading(false);
    });

    return () => controller.abort();
  }, [expanded, workspaceId]);

  const selectedProjects = useMemo(
    () => projects.filter((project) => selected.has(project.id)),
    [projects, selected],
  );
  const dirty = !sameSelections(selected, saved);

  function toggleProject(projectId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await saveProjects(workspaceId, selectedProjects);
      setSaved(new Set(selected));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save GitLab projects.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--dashboard-border)] bg-[var(--surface-soft)] p-3">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left"
        onClick={() => setExpanded((value) => !value)}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Projects</p>
          <p className="truncate text-xs text-muted-foreground">
            {saved.size > 0 ? `${saved.size} selected for merge request monitoring` : "Choose projects to monitor"}
          </p>
        </div>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", expanded ? "rotate-180" : "")} />
      </button>

      {expanded ? (
        <div className="mt-3 flex flex-col gap-3">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading projects
            </div>
          ) : projects.length > 0 ? (
            <div className="max-h-64 overflow-y-auto rounded-md border border-[var(--dashboard-border)] bg-card">
              {projects.map((project) => {
                const checked = selected.has(project.id);
                return (
                  <button
                    key={project.id}
                    type="button"
                    className="flex w-full items-center gap-3 border-b border-[var(--dashboard-border)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--surface-soft)]"
                    onClick={() => toggleProject(project.id)}
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
                        {project.name ?? project.path ?? project.id}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {project.path ?? project.url}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No accessible GitLab projects were returned.</p>
          )}

          {error ? <p className="text-xs text-red-600">{error}</p> : null}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setExpanded(false)}
            >
              Close
            </Button>
            <Button type="button" size="sm" disabled={!dirty || saving} onClick={handleSave}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <RefreshCcw className="size-4" />}
              Save
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
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
