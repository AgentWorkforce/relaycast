# Trajectory: Switch staging hostname to staging-api.relaycast.dev and align CI/bootstrap

> **Status:** ✅ Completed
> **Confidence:** 94%
> **Started:** February 18, 2026 at 02:20 PM
> **Completed:** February 18, 2026 at 02:21 PM

---

## Summary

Updated wrangler/deploy workflow/action examples to staging-api domain and aligned bootstrap DNS assumptions

**Approach:** Standard approach

---

## Key Decisions

### Moved staging route to staging-api.relaycast.dev
- **Chose:** Moved staging route to staging-api.relaycast.dev
- **Reasoning:** Unifies hostname strategy with prNN-api previews under *.relaycast.dev wildcard and avoids *.api cert edge cases

### Simplified bootstrap DNS to only ensure *.relaycast.dev wildcard
- **Chose:** Simplified bootstrap DNS to only ensure *.relaycast.dev wildcard
- **Reasoning:** Both staging-api and prNN-api hostnames are covered by root wildcard

---

## Chapters

### 1. Work
*Agent: default*

- Moved staging route to staging-api.relaycast.dev: Moved staging route to staging-api.relaycast.dev
- Simplified bootstrap DNS to only ensure *.relaycast.dev wildcard: Simplified bootstrap DNS to only ensure *.relaycast.dev wildcard
