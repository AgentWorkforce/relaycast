import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Badge } from "@/app/components/ui/badge";
import { getAuthContext } from "@/lib/auth/auth-api";
import { getAuthSessionSecret } from "@/lib/auth/secrets";
import { readSessionFromRequest } from "@/lib/auth/session";
import { fetchRelayhistoryReflex } from "@/lib/relayhistory-reflex";
import { PageSurface } from "../_components/page-surface";

type LoadState = {
  items: Record<string, unknown>[];
  error: string | null;
};

const PATTERN_KEYS = ["patterns", "items", "data", "results"];
const OUTCOME_KEYS = ["outcomes", "items", "data", "results"];

async function requireAuthContext() {
  const cookieStore = await cookies();
  const session = readSessionFromRequest(
    { cookies: cookieStore as never },
    getAuthSessionSecret(),
  );

  if (!session) {
    redirect("/");
  }

  return getAuthContext(session.userId, session.currentWorkspaceId);
}

async function fetchReflexItems(
  path: string,
  userId: string,
  orgId: string,
  workspaceId: string,
  keys: string[],
): Promise<LoadState> {
  try {
    const response = await fetchRelayhistoryReflex(path, {
      userId,
      orgId,
      workspaceId,
      mode: "read",
    });

    if (!response.ok) {
      return { items: [], error: `Request failed with ${response.status}.` };
    }

    return { items: extractItems(await response.json(), keys), error: null };
  } catch (error) {
    return {
      items: [],
      error: error instanceof Error ? error.message : "Request failed.",
    };
  }
}

function extractItems(value: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }

  if (!isRecord(value)) {
    return [];
  }

  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord);
    }
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(item: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function firstNumber(item: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function formatTitle(item: Record<string, unknown>, fallback: string): string {
  return firstString(item, ["title", "name", "label", "pattern", "kind", "id"]) ?? fallback;
}

function formatDescription(item: Record<string, unknown>): string | null {
  return firstString(item, [
    "summary",
    "description",
    "detail",
    "message",
    "recommendation",
    "outcome",
  ]);
}

function formatTimestamp(item: Record<string, unknown>): string | null {
  const value = firstString(item, [
    "occurredAt",
    "observedAt",
    "createdAt",
    "updatedAt",
    "timestamp",
    "time",
  ]);
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function itemMeta(item: Record<string, unknown>): string[] {
  const meta = [
    firstString(item, ["scope"]),
    firstString(item, ["kind", "type", "status"]),
    firstNumber(item, ["confidence", "score", "weight"])?.toLocaleString("en", {
      maximumFractionDigits: 2,
    }) ?? null,
    formatTimestamp(item),
  ];

  return meta.filter((value): value is string => Boolean(value));
}

function ReflexRow({
  item,
  fallback,
}: {
  item: Record<string, unknown>;
  fallback: string;
}) {
  const meta = itemMeta(item);
  const description = formatDescription(item);

  return (
    <li className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {formatTitle(item, fallback)}
          </p>
          {description ? (
            <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {meta[0] ? <Badge variant="info">{meta[0]}</Badge> : null}
      </div>
      {meta.length > 1 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {meta.slice(1).join(" / ")}
        </p>
      ) : null}
    </li>
  );
}

function ReflexSection({
  title,
  description,
  state,
  empty,
  fallback,
}: {
  title: string;
  description: string;
  state: LoadState;
  empty: string;
  fallback: string;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {state.error ? (
        <div className="rounded-xl border border-[var(--status-warning)]/40 bg-[var(--status-warning-soft)] p-4 text-sm text-[var(--status-warning)]">
          {state.error}
        </div>
      ) : state.items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border-default)] p-6 text-sm text-muted-foreground">
          {empty}
        </div>
      ) : (
        <ul className="space-y-3">
          {state.items.map((item, index) => (
            <ReflexRow
              key={firstString(item, ["id", "key"]) ?? index}
              item={item}
              fallback={fallback}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function ReflexPage() {
  const context = await requireAuthContext();
  const userId = context.user.id;
  const workspaceId = context.currentWorkspace.id;
  const orgId = context.currentWorkspace.organization_id;

  const [patterns, outcomes] = await Promise.all([
    fetchReflexItems(
      "/v1/reflex/patterns?scope=individual",
      userId,
      orgId,
      workspaceId,
      PATTERN_KEYS,
    ),
    fetchReflexItems(
      "/v1/reflex/outcomes?limit=20",
      userId,
      orgId,
      workspaceId,
      OUTCOME_KEYS,
    ),
  ]);

  return (
    <PageSurface>
      <div className="space-y-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--primary)]">
              Reflex
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-foreground">
              Reflex
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Individual learning signals and recent outcomes for {context.currentWorkspace.name}.
            </p>
          </div>
          <Badge variant="default">{context.currentWorkspace.name}</Badge>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <ReflexSection
            title="Individual patterns"
            description="Patterns detected for the current workspace scope."
            state={patterns}
            empty="No individual patterns have been recorded yet."
            fallback="Pattern"
          />
          <ReflexSection
            title="Recent outcomes"
            description="The latest Reflex outcomes available for this workspace."
            state={outcomes}
            empty="No recent outcomes have been recorded yet."
            fallback="Outcome"
          />
        </div>
      </div>
    </PageSurface>
  );
}
