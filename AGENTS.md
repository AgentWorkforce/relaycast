# Relaycast Agent Guide

## What Relaycast Is
Relaycast is headless Slack for agents: channels, threads, DMs, reactions, files, search, and realtime events.

## Source Of Truth
- `README.md` for onboarding and examples.
- `openapi.yaml` for HTTP API schema.
- Root `package.json` for scripts and workspace configuration.
- `packages/engine` for API behavior — the canonical, portable server that powers the hosted gateway
  (`cast.agentrelay.com`) and self-hosting.
- `packages/sdk-typescript` for TypeScript SDK surface.


## Engineering Rules
- Keep docs concise and avoid duplicated guidance.
- Prefer zod schemas for validation instead of ad-hoc manual checks.
- Do not add mixed-case compatibility fallbacks.

## Naming And API Shape
- HTTP JSON wire fields are snake_case (for example `agent_name`, `created_at`).
- JS/TS method and function names are camelCase.
- Success response envelope: `{ ok: true, data: ... }`.
- Error response envelope: `{ ok: false, error: { code, message } }`.

## Core Commands
- `npm install`
- `npm run dev`
- `npx turbo build`
- `npx turbo test`
- `npx turbo lint`
- `npm run e2e -- <base-url>`

## Docs Hygiene
- Update `README.md` and `openapi.yaml` together when API behavior changes.
- Keep quickstart examples realtime-first (WebSocket subscriptions and message handlers) instead of polling-first flows.

## Changelog
- Curate the unreleased section in `CHANGELOG.md` for cross-package or user-facing release notes.
- An empty post-release changelog starts at `[Unreleased]`. The first pending user-visible change must set the heading to `[Unreleased - Patch]`, `[Unreleased - Minor]`, or `[Unreleased - Major]` according to its SemVer impact.
- The pending release level is monotonic: `Patch < Minor < Major`. Raise the heading when a higher-impact change arrives; never lower it for a later lower-impact change, and leave it unchanged for another change at the same level.
- When a release is cut, the publish workflow runs `scripts/cut-changelog.mjs`, which moves the pending entries under the released version and restores an empty `[Unreleased]` heading with no release level. Do not hand-cut a release; curate `[Unreleased]` and let the release commit do it. (The Rust SDK changelog is excluded — it ships on its own crates.io version line.)
- Add package-level API and migration detail to the relevant `packages/*/CHANGELOG.md` when one exists.
- Apply the same release-level heading rules to any package changelog that receives a pending entry.
- Keep entries concise and impact-first: one short bullet per user-visible change.
- Omit PR links, internal review notes, test-only work, and implementation backstory unless they explain shipped impact.




<!-- prpm:snippet:start @agent-workforce/trail-snippet@1.1.2 -->
# Trail

Record your work as a trajectory for future agents and humans to follow.

## Usage

If `trail` is installed globally, run commands directly:
```bash
trail start "Task description"
```

If not globally installed, use npx to run from local installation:
```bash
npx trail start "Task description"
```

## When Starting Work

Start a trajectory when beginning a task:

```bash
trail start "Implement user authentication"
```

With external task reference:
```bash
trail start "Fix login bug" --task "ENG-123"
```

## Recording Decisions

Record key decisions as you work:

```bash
trail decision "Chose JWT over sessions" \
  --reasoning "Stateless scaling requirements"
```

For minor decisions, reasoning is optional:
```bash
trail decision "Used existing auth middleware"
```

**Record decisions when you:**
- Choose between alternatives
- Make architectural trade-offs
- Decide on an approach after investigation

## Recording Reflections

Periodically step back and synthesize progress:

```bash
trail reflect "Workers aligned on auth approach, API layer progressing well" \
  --confidence 0.8
```

With focal points and adjustments:
```bash
trail reflect "Frontend and backend duplicating validation logic" \
  --focal-points "duplication,ownership" \
  --adjustments "Reassigning validation to backend team" \
  --confidence 0.7
```

**Record reflections when you:**
- Have received several updates and need to synthesize the big picture
- Notice workers or tasks diverging from the plan
- Want to course-correct before continuing
- Are coordinating multiple agents and need to assess overall progress

Reflections differ from decisions: decisions record a specific choice,
reflections record a higher-level synthesis of what's happening and whether
the current approach is working.

## Completing Work

When done, complete with a retrospective:

```bash
trail complete --summary "Added JWT auth with refresh tokens" --confidence 0.85
```

After completing work, compact the finished trajectory or merged PR into a
durable summary. When the compacted summary is sufficient, discard the raw
source trajectories so `.agentworkforce/trajectories` and list output stay focused:

```bash
trail compact --discard-sources
# or after a PR merge:
trail compact --pr 42 --discard-sources
```

`--discard-sources` removes the source trajectory JSON/Markdown/trace files and
updates the index. Use it after confirming the compacted artifact is the record
you want to keep.

**Confidence levels:**
- 0.9+ : High confidence, well-tested
- 0.7-0.9 : Good confidence, standard implementation
- 0.5-0.7 : Some uncertainty, edge cases possible
- <0.5 : Significant uncertainty, needs review

## Abandoning Work

If you need to stop without completing:

```bash
trail abandon --reason "Blocked by missing API credentials"
```

## Checking Status

View current trajectory:
```bash
trail status
```

## Listing and Viewing Trajectories

List all trajectories:
```bash
trail list
```

View a specific trajectory:
```bash
trail show <trajectory-id>
```

Export a trajectory (markdown, json, timeline, html):
```bash
trail export <trajectory-id> --format markdown
```

## Compacting Trajectories

After a PR merge, compact related trajectories into a single summary and prune
raw source trajectories when the summary should replace them:

```bash
trail compact --pr 42 --discard-sources
```

Compact by branch (finds trajectories with commits not in the specified base branch):
```bash
trail compact --branch main --discard-sources
```

Compact by specific commits:
```bash
trail compact --commits abc123,def456 --discard-sources
```

Compaction consolidates decisions and creates a grouped summary. Adding
`--discard-sources` makes the compacted artifact the durable record by removing
the raw trajectories and their index entries.

## Why Trail?

Your trajectory helps others understand:
- **What** you built (commits show this)
- **Why** you built it this way (trajectory shows this)
- **What alternatives** you considered
- **What challenges** you faced

Future agents can query past trajectories to learn from your decisions.
<!-- prpm:snippet:end @agent-workforce/trail-snippet@1.1.2 -->
