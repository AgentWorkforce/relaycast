# PLAN — wire Relay credential proxy into Cloud sandboxes

## Goal
Create and run a workflow that wires the Relay credential proxy into Cloud sandbox execution so API-based credentials (starting with OpenRouter, but designed generically) are not injected directly into sandboxes.

## Original intent
A sandbox should be able to make provider API calls without holding the real provider credentials. Cloud should mint constrained proxy access and inject proxy connection details into the sandbox instead of raw secrets.

## Scope
- Cloud-side token issuance / env wiring / sandbox integration
- Generic API-credential proxy support, not OpenRouter-only
- End-to-end validation of the trust boundary
- QA should verify credentials are not present inside the sandbox while calls still succeed through the proxy path

## Required outcomes
1. Identify where Cloud provisions sandbox env and how provider credentials are currently passed.
2. Identify how Relay credential proxy can be reached from sandboxes.
3. Wire proxy URL/token env into sandbox runtime instead of raw upstream keys.
4. Support a safe, testable end-to-end path using a fake sandbox or container if needed.
5. Produce deterministic QA evidence that:
   - sandbox can call through proxy
   - upstream call succeeds (real or mocked as appropriate)
   - raw provider secrets are not present inside sandbox env
   - usage / budget / auth behavior is connected end to end

## Preferred validation strategy
- Use a fake sandbox or Docker container if real sandbox orchestration is too heavy for the workflow run.
- The QA path must still exercise the real integration seams between:
  - Cloud-issued proxy access
  - sandbox runtime env
  - relay credential proxy
  - provider-facing adapter behavior

## Constraints
- Keep direct trust-boundary reasoning explicit.
- Prefer deterministic steps for environment capture, test execution, and evidence collection.
- Use Claude for planning/research and QA/review reasoning.
- Use Codex for implementation.
- End with review outputs that separate:
  - what is implemented
  - what is fully proven end to end
  - what remains follow-up work
