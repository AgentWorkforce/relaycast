# Trajectory: Align Relayfile inbound GitHub PR identity matching

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** September 19, 2026 at 08:46 PM
> **Completed:** September 19, 2026 at 08:54 PM

---

## Summary

Added exact GitHub PR inbound matching with HMAC-bound authorization. 1153 engine tests, typecheck, build, and actual cloud Queue-to-signed-inbound-to-agent-inbox proof pass. Deploy receiver before cloud and reprovision with repository read authorization; no production changes.

**Approach:** Standard approach

---

## Key Decisions

### Seal semantic GitHub PR authorization into callback URL and signing secret
- **Chose:** Seal semantic GitHub PR authorization into callback URL and signing secret
- **Reasoning:** Legacy receiver URLs must remain literal; a workspace-key-authorized new target uses a distinct HMAC derivation, so old secrets cannot enable semantic matching by query tampering.

---

## Chapters

### 1. Work
*Agent: default*

- Seal semantic GitHub PR authorization into callback URL and signing secret: Seal semantic GitHub PR authorization into callback URL and signing secret
