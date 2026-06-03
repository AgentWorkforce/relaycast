# Trajectory: Fix PR #159 author spoofing review

> **Status:** ✅ Completed
> **Task:** PR-159-review
> **Confidence:** 95%
> **Started:** June 2, 2026 at 10:35 PM
> **Completed:** June 2, 2026 at 10:37 PM

---

## Summary

Fixed PR #159 review issue: normal caller metadata can no longer spoof REST agent_name; webhook authors use trusted internal metadata and user metadata strips reserved keys.

**Approach:** Standard approach

---

## Key Decisions

### Restricted webhook display authors to trusted internal metadata
- **Chose:** Restricted webhook display authors to trusted internal metadata
- **Reasoning:** Normal message metadata is caller-controlled, so REST identity rendering must not read public metadata.author. Webhook authors now use sanitized internal __relaycast_* metadata, and normal posts/replies strip that namespace before storage.

---

## Chapters

### 1. Work
*Agent: default*

- Restricted webhook display authors to trusted internal metadata: Restricted webhook display authors to trusted internal metadata
