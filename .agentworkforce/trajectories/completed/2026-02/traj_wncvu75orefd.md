# Trajectory: Switch preview host pattern to pr<PR>-api.relaycast.dev and align bootstrap DNS

> **Status:** ✅ Completed
> **Confidence:** 89%
> **Started:** February 18, 2026 at 01:22 PM
> **Completed:** February 18, 2026 at 01:24 PM

---

## Summary

Updated preview deploy workflow and bootstrap scripts for prNN-api host routing; validated scripts parse and confirmed current DNS gap for *.relaycast.dev

**Approach:** Standard approach

---

## Key Decisions

### Switched preview host pattern to pr<PR>-api.relaycast.dev
- **Chose:** Switched preview host pattern to pr<PR>-api.relaycast.dev
- **Reasoning:** Avoid TLS/cert mismatch seen on pr-<PR>.api host and use single-label wildcard DNS under relaycast.dev

### Updated bootstrap DNS provisioning to manage *.relaycast.dev wildcard
- **Chose:** Updated bootstrap DNS provisioning to manage *.relaycast.dev wildcard
- **Reasoning:** Preview hosts now require wildcard at zone root for on-the-fly PR subdomains

---

## Chapters

### 1. Work
*Agent: default*

- Switched preview host pattern to pr<PR>-api.relaycast.dev: Switched preview host pattern to pr<PR>-api.relaycast.dev
- Updated bootstrap DNS provisioning to manage *.relaycast.dev wildcard: Updated bootstrap DNS provisioning to manage *.relaycast.dev wildcard
