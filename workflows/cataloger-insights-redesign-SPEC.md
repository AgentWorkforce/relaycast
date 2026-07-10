# Cataloger Insights Redesign — SPEC

## Goal (the "100" we're aiming at)

A cataloger run on a real workspace produces `/insights/github/active-prs.json`
and `/insights/linear/open-issues.json` whose contents are *useful at a glance*
— not raw lists. A human reading the file should immediately know "what needs
my attention this morning" without filtering or counting.

This is the follow-up to:

- cloud#382 (relayfile token scopes — unblocked the write).
- cloud#384 (path layout fix — unblocked the read).

Both shipped a **functioning but trivial** insight: a flat array of open PRs /
issues. This spec covers the redesign that makes the output worth opening.

## Output schema

### `/insights/github/active-prs.json`

```jsonc
{
  "generatedAt": "2026-04-27T05:00:00.000Z",
  "summary": "3 PRs need attention. acme/platform#45 has been blocked on review for 5 days, acme/worker#67 is failing CI for 2 days, and the draft acme/platform#89 has not been touched in 11 days.",
  "highlights": [
    {
      "kind": "blocked-on-review",
      "headline": "1 PR waiting on review > 3 days",
      "prs": [{ "number": 45, "repo": "acme/platform", "waitingDays": 5, "reviewer": "bob" }]
    },
    {
      "kind": "ci-failing",
      "headline": "1 PR with failing CI > 1 day",
      "prs": [{ "number": 67, "repo": "acme/worker", "failingDays": 2, "checkName": "ci/build" }]
    },
    {
      "kind": "stale-draft",
      "headline": "1 stale draft (no activity > 7 days)",
      "prs": [{ "number": 89, "repo": "acme/platform", "ageDays": 11 }]
    }
  ],
  "metrics": { "openCount": 12, "draftCount": 4, "p50AgeDays": 2, "p90AgeDays": 11 },
  "all": [ /* the existing flat list, kept for programmatic consumers */ ]
}
```

### `/insights/linear/open-issues.json`

```jsonc
{
  "generatedAt": "2026-04-27T05:00:00.000Z",
  "summary": "5 issues need attention. ENG-123 is high-priority and unassigned for 4 days; CS-77 was last touched 14 days ago and mentions an enterprise customer.",
  "highlights": [
    { "kind": "unassigned-priority", "headline": "...", "issues": [...] },
    { "kind": "stale-no-activity",   "headline": "...", "issues": [...] },
    { "kind": "customer-mentioned",  "headline": "...", "issues": [...] }
  ],
  "metrics": { "openCount": 23, "p1Count": 2, "unassignedCount": 8, "p50AgeDays": 6 },
  "all": [ /* flat list */ ]
}
```

## Signal extraction (deterministic, before LLM)

These are computed from VFS metadata. **No LLM in this layer** — keep it
testable and offline.

### GitHub signals

Read alongside `/github/repos/*/pulls/*/metadata.json`:

- `/github/repos/{owner}/{repo}/reviews/{id}.json` — latest review state per PR.
- `/github/repos/{owner}/{repo}/checks/{id}.json` — latest check_run conclusion per PR head SHA.

Buckets:

- `blocked-on-review` — `requested_reviewers` non-empty AND no `review.state === "approved"` for ≥ 3 days.
- `ci-failing` — at least one `check_run.conclusion === "failure"` for ≥ 1 day.
- `stale-draft` — `draft === true` AND no update for ≥ 7 days.
- `merge-conflict` — `mergeable === false` (when present in metadata).

### Linear signals

Read alongside `/linear/issues/{id}.json`:

- `/linear/comments/{id}.json` — last comment time per issue.

Buckets:

- `unassigned-priority` — no assignee AND priority ≤ 2 (Linear: 1 = urgent, 2 = high).
- `stale-no-activity` — no comment / update for ≥ 14 days.
- `customer-mentioned` — issue body / latest comment contains a known customer keyword.

## LLM summary (`summarizeInsight`)

New helper in `packages/cataloging-agent-core/src/llm.ts`:

```ts
export async function summarizeInsight(input: {
  domain: "github" | "linear";
  signals: SignalBuckets;
  metrics: Record<string, number>;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<{ summary: string } | { summary: null; reason: string }>;
```

Behavior:

- POST to OpenRouter `/api/v1/chat/completions` with model `openai/gpt-4o-mini` (cheap, fast — we're rendering a paragraph, not reasoning).
- Hard timeout: 3000ms.
- On error / timeout / non-2xx: return `{ summary: null, reason }`. Never throw.
- Prompt structure: system message describes the role ("morning-standup briefer"); user message embeds the structured signals as JSON and asks for one short paragraph (≤ 3 sentences).

## Caching

The existing `writeInsight` flow already fingerprints the **output** content and
skips writes when nothing changed. We extend this:

- Fingerprint the **input** (signals + metrics) before calling the LLM.
- Read the existing insight file's `cataloging.signalFingerprint` property.
- If fingerprints match, **reuse** the existing `summary` field instead of calling the LLM. Saves money + makes cron idempotent.
- Store `cataloging.signalFingerprint` alongside the existing fingerprint properties when writing.

## Failure mode

`summarizeInsight` returning `{ summary: null }` produces a partially-populated
insight: `summary` field is omitted (or set to a deterministic fallback like
"3 PRs need attention. See `highlights` for details."), structured fields
remain accurate. Insight is degraded but never errored. Cron still bumps cursor.

## Schema breaking change

Anyone reading `/insights/*` today expects `{ generatedAt, prs: [] }` /
`{ generatedAt, total, byAssignee, byPriority, staleOverSevenDays }`. New
shapes:

- Top-level rename `prs` → `all`.
- Top-level rename `total/byAssignee/byPriority/staleOverSevenDays` → `metrics`.
- New `summary`, `highlights` fields.

Audit before kickoff: `grep -rn "active-prs.json\\|open-issues.json" packages/`.
If any consumers exist, the workflow adds an extra "rename-coordination" step.
First pass found none — these files are only written, not yet read by sage /
specialist / web.

## Acceptance gates

The workflow does not commit until:

1. Unit tests pass (stubbed OpenRouter).
2. `npx tsc --noEmit` clean across cataloging-agent-{core,github,linear}.
3. Local E2E test: fake relayfile + stubbed OpenRouter → asserts new schema + non-empty `summary` + non-empty `highlights`.
4. Existing test suites (cataloging-agent-{core,github,linear}) pass — regression gate.

After merge + deploy:

5. `curl -X POST https://catalog-github.production.agentrelay.cloud/cron` returns `result.status: "written"`.
6. The insight file's `summary` mentions specific PRs / repos by name (sanity check).

## Out of scope for this PR

- Insight personalization (per-user "what should *I* look at").
- Multi-workspace aggregation.
- Alternate LLM providers / model selection.
- Replacing OpenRouter with a self-hosted model.
- The 7-day-old TODO in `infra/cataloging-agent-{github,linear}.ts:74-78` to consolidate the OpenRouter key (#234) — separate cleanup.
