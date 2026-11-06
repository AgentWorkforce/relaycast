# Trajectory: Align authenticated Relayfile callbacks with segment glob matching

> **Status:** Completed
> **Confidence:** 94%
> **Started:** 2026-11-06T16:22:13.423Z
> **Completed:** 2026-11-06T16:41:15Z

## Summary

Authenticated Relayfile callbacks now match embedded Linear UUID globs and internal Jira comment globs. Legacy root wildcards remain compatible, and pattern stars remain wildcard tokens when an event path contains literal asterisks. The final local receiver/matcher suites pass 49 tests. Existing HMAC labels, GitHub identity opt-ins and ingress controls are unchanged.

## Artifacts

- Base: `1ecb158404c877c63e31ee9e55f1c2786fab60ab`.
- Final attributed product: `eda43a17a5f1e62673643d92d5aa3c73d9c3732f`.
- Commits in the exact attribution range (5): `604f2dd03bdba2a62bc41e3ebb8ac8747ab59a8b`, `b431f0fd1e6ebb24825e5267ac2e04f4c8d395e4`, `c6f30bce4e3ed2ddb1a4f92c38d0a74c77925ade`, `322c495cfc6dd8ee6ef8d93bfc1dca3f39652605`, `eda43a17a5f1e62673643d92d5aa3c73d9c3732f`.
- Files changed in that range: 11. The names in `trajectory.json` match `git diff --name-only` for the same range.
- The trace records original product and review-correction line ranges. Later evidence-only commits are outside this stable product range and change no executable code or tests.

## Current validation

All checks below apply to source/tests committed in the final attributed product.

- `npm exec --workspace=@relaycast/engine -- vitest run src/routes/__tests__/relayfileInbound.test.ts src/routes/__tests__/relayfilePathGlob.test.ts`: **49 passed**, comprising 22 real SQLite/API route tests and 27 matcher cases. Wrong UUID/provider/path, bad signatures, broader-target tampering, agent writes, replay and event-ID collisions remain covered. Existing GitHub identity cases pass.
- TypeScript 5.9.3 `tsc --noEmit -p packages/engine/tsconfig.typecheck.json`: passed. ESLint 9.39.2 on `packages/engine/src/routes/relayfileInbound.ts` and `relayfilePathGlob.ts`: passed with the repository config. CI Node 22.14.0 was used; no full-engine build was run.
- A supplemental local AST-extraction probe executed the actual four matcher functions from relayfile-cloud `ba8179660deac4cf251754859ccd3d5ac2948b4f` plus `normalizePath` from locked `@relayfile/core` 0.10.34. All **21 shared vectors agreed**. The root-prefix and literal-star edge cases are separately labeled corrections, outside this agreement set. The temporary probe is not a shipped dependency or CI check.
- `git diff --check` passed. Full-diff Veto review passed after the final product correction.

## Historical regression evidence

These counts describe earlier reproductions, not the final suite result.

| Reproduction | Before correction | After correction |
| --- | --- | --- |
| Added Linear/Jira route cases against base production | 18 passed / 2 failed, expected 201 versus skipped 200 | Initially 41 passed across route/agreement suites |
| Added root compatibility cases against the first port | 42 passed / 3 failed | 45 passed |
| Added literal-star cases against the root-corrected port | 46 passed / 3 failed | Final 49 passed |

The baseline production route overlay was restored in a finally block. Logs: `/tmp/relaycast-globs-{baseline-final,targeted,typecheck,eslint,parity}.log`, `/tmp/relaycast-globs-root-{before,after}.log` and `/tmp/relaycast-globs-star-{before,after}.log`. These are local temporary artifacts, not shipped evidence files or a separate RelayFlow/deployed proof.

## Decisions and limits

Matching normalization resolves repeated slashes and dot segments, preserving case and percent escapes. It is matching-only: target HMAC label normalization and GitHub identity authorization logic remain unchanged. The README overview and package changelog describe the resulting user behavior.

The matcher follows the pinned producer's segment-state dynamic program and star retry algorithm, with receiver fixes for the empty `/*` prefix and literal-star token handling. It uses no caller-controlled regular expression or recursive backtracking. Its bound is polynomial in path/pattern size; no strict whole-input linear-time claim is made.

No provider calls, manual webhook replays, merge, deployment, installation or runtime/configuration changes were performed. The hosted engine revision remains unverified. This work remains separate from deletion support in PR630.
