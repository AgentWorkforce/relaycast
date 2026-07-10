#!/usr/bin/env node
/*
 * Live setup-token probe — pre-publish gate ① of the ctx.llm rollout
 * (docs/runbooks/ctx-llm-rollout-193.md).
 *
 * Proves the Anthropic Messages API accepts the EXACT header shape
 * workforce#193's runtime LlmContext sends for a `claude setup-token`
 * (Authorization: Bearer + anthropic-beta: oauth-2025-04-20). Unit tests
 * pin the header shape; this proves Anthropic's acceptance with a real
 * token.
 *
 * Usage:
 *   CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)" node scripts/probe-setup-token.mjs
 *
 * Exit 0 = gate PASSED. Non-zero = do not publish; the response body is
 * printed (truncated) for triage.
 */

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
if (!token) {
  console.error("probe-setup-token: set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token output)");
  process.exit(2);
}

const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    // Cheapest possible real completion; the runtime's actual model is
    // persona-driven — this only proves auth acceptance.
    model: "claude-haiku-4-5",
    max_tokens: 8,
    messages: [{ role: "user", content: "ping" }],
  }),
  signal: AbortSignal.timeout(30_000),
});

const body = await response.text().catch(() => "");
console.log(`${response.status} ${body.slice(0, 300)}`);
process.exit(response.ok ? 0 : 1);
