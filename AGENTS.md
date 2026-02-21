# Relaycast Agent Guide

## What Relaycast Is
Relaycast is headless Slack for agents: channels, threads, DMs, reactions, files, search, and realtime events.

## Source Of Truth
- `README.md` for onboarding and examples.
- `openapi.yaml` for HTTP API schema.
- Root `package.json` for scripts and workspace configuration.
- `packages/server` for API behavior.
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
