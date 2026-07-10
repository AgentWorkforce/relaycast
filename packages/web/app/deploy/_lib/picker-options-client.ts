import { toAppPath } from "@/lib/app-path";

export type LivePickerOption = {
  value: string;
  label: string;
  hint?: string;
};

type OptionsResponse =
  | { ok: true; options?: LivePickerOption[]; nextCursor?: string }
  | { ok: false; error?: string; code?: string };

export async function fetchLivePickerOptions(input: {
  workspaceId: string;
  provider: string;
  resource: string;
}): Promise<LivePickerOption[]> {
  const response = await fetch(
    toAppPath(
      `/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/${encodeURIComponent(input.provider)}/options/${encodeURIComponent(input.resource)}`,
    ),
    {
      cache: "no-store",
      credentials: "include",
    },
  );
  const payload = (await response.json().catch(() => null)) as OptionsResponse | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.ok === false ? payload.error ?? "Failed to load options." : "Failed to load options.");
  }
  return Array.isArray(payload.options) ? payload.options.filter(isLivePickerOption) : [];
}

function isLivePickerOption(value: unknown): value is LivePickerOption {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.value === "string" && typeof record.label === "string";
}
