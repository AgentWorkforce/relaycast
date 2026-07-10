"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import { Button, buttonVariants } from "@/app/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import { EnrollmentSuccess } from "./EnrollmentSuccess";

type NewWorkerFormProps = {
  workspaceId: string;
  workersHref: string;
  minCliVersion: string;
};

type EnrollmentResponse = {
  token?: string;
  expiresAt?: string;
  registerCommand?: string;
  startCommand?: string;
  createdAt?: string;
};

type EnrollmentResult = {
  workerName: string;
  issuedAt: string;
  token: string;
  expiresAt: string;
  registerCommand: string;
  startCommand: string;
};

function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

function isEnrollmentResponse(value: EnrollmentResponse): value is Required<
  Pick<EnrollmentResponse, "token" | "expiresAt" | "registerCommand" | "startCommand">
> &
  EnrollmentResponse {
  return (
    typeof value.token === "string" &&
    typeof value.expiresAt === "string" &&
    typeof value.registerCommand === "string" &&
    typeof value.startCommand === "string"
  );
}

export function NewWorkerForm({ workspaceId, workersHref, minCliVersion }: NewWorkerFormProps) {
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EnrollmentResult | null>(null);
  const parsedTags = useMemo(() => parseTags(tags), [tags]);

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const workerName = name.trim();
    if (!workerName) {
      setError("Worker name is required.");
      return;
    }

    setSubmitting(true);
    setError(null);
    const requestStartedAt = new Date().toISOString();

    try {
      const response = await fetch("/api/v1/workers/enrollment-tokens", {
        method: "POST",
        cache: "no-store",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId,
          name: workerName,
          ...(parsedTags.length > 0 ? { tags: parsedTags } : {}),
        }),
      });

      if (!response.ok) {
        setError("Could not create an enrollment token. Check your workspace permissions and try again.");
        return;
      }

      const payload = (await response.json()) as EnrollmentResponse;
      if (!isEnrollmentResponse(payload)) {
        setError("Enrollment response was incomplete.");
        return;
      }

      setResult({
        workerName,
        issuedAt: payload.createdAt ?? requestStartedAt,
        token: payload.token,
        expiresAt: payload.expiresAt,
        registerCommand: payload.registerCommand,
        startCommand: payload.startCommand,
      });
    } catch {
      setError("Could not create an enrollment token. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <EnrollmentSuccess
        workspaceId={workspaceId}
        workerName={result.workerName}
        token={result.token}
        expiresAt={result.expiresAt}
        registerCommand={result.registerCommand}
        startCommand={result.startCommand}
        issuedAt={result.issuedAt}
        workersHref={workersHref}
        minCliVersion={minCliVersion}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add Worker</CardTitle>
        <CardDescription>
          Create a short-lived enrollment token, then run the generated commands on the host.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submitForm} className="space-y-5">
          <div className="space-y-2">
            <label htmlFor="worker-name" className="text-sm font-medium text-[var(--foreground)]">
              Worker name
            </label>
            <input
              id="worker-name"
              name="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="macmini-01"
              className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-strong)] px-3 py-2 text-sm text-[var(--foreground)] shadow-sm outline-none transition-colors placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="worker-tags" className="text-sm font-medium text-[var(--foreground)]">
              Tags
            </label>
            <input
              id="worker-tags"
              name="tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="macos, arm64, xcode"
              className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-strong)] px-3 py-2 text-sm text-[var(--foreground)] shadow-sm outline-none transition-colors placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]"
            />
            <p className="text-xs text-[var(--text-muted)]">
              Optional metadata. Worker names must be unique in this workspace.
            </p>
          </div>

          {error ? (
            <div className="rounded-lg border border-[var(--status-danger)]/30 bg-[var(--status-danger-soft)] p-3 text-sm text-[var(--status-danger)]">
              {error}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating token..." : "Create enrollment token"}
            </Button>
            <Link href={workersHref} className={buttonVariants({ variant: "outline" })}>
              Cancel
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
