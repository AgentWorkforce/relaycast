# Trajectory Compaction: Sep 5, 2026 - Sep 8, 2026

## Summary

- Sessions: 1
- Decisions: 16
- Events: 19
- Agents: default
- Files: 145
- Commits: 33

## Testing

- Fix SSRF loopback/IP-literal bypass in docker/entrypoint-core.mjs via a WHATWG-spec IPv4 parser -> Fix SSRF loopback/IP-literal bypass in docker/entrypoint-core.mjs via a WHATWG-spec IPv4 parser (traj_tklpxq0u1yhz)
- Replace publish-npm.yml's post-publish rebase with tag-then-merge -> Replace publish-npm.yml's post-publish rebase with tag-then-merge (traj_tklpxq0u1yhz)
- Enforce relaycast#379's 32-character structural minimum for anonymous idempotency keys independently of the X-Workspace-Bootstrap-Secret proof -> Enforce relaycast#379's 32-character structural minimum for anonymous idempotency keys independently of the X-Workspace-Bootstrap-Secret proof (traj_tklpxq0u1yhz). The floor is structural only; callers must generate unpredictable values with a CSPRNG.
- Fix before()-hook cleanup gap found by independent review: teardown containers/image/volumes on setup failure, not just on normal completion -> Fix before()-hook cleanup gap found by independent review: teardown containers/image/volumes on setup failure, not just on normal completion (traj_tklpxq0u1yhz)
- Await background delivery settlement before TTL acknowledgement regression reads the mailbox -> Await background delivery settlement before TTL acknowledgement regression reads the mailbox (traj_tklpxq0u1yhz)

## Api

- Bind anonymous bootstrap idempotency replay to X-Workspace-Bootstrap-Secret proof, checked in constant time before any DB lookup -> Bind anonymous bootstrap idempotency replay to X-Workspace-Bootstrap-Secret proof, checked in constant time before any DB lookup (traj_tklpxq0u1yhz)
- Add scheduled real-container integration CI (test/container-image-integration.test.mjs + .github/workflows/container-integration.yml) -> Add scheduled real-container integration CI (test/container-image-integration.test.mjs + .github/workflows/container-integration.yml) (traj_tklpxq0u1yhz)
- Use run-unique Docker image tags and Docker-assigned loopback ports in real-image integration -> Use run-unique Docker image tags and Docker-assigned loopback ports in real-image integration (traj_tklpxq0u1yhz)
- Use Docker-managed named volumes in the real-image CI proof -> Use Docker-managed named volumes in the real-image CI proof (traj_tklpxq0u1yhz)

## Tooling

- Preserve and refresh the existing lockfile before npm ci -> Preserve and refresh the existing lockfile before npm ci (traj_tklpxq0u1yhz)
- Add verify-publish job and skip-if-already-published npm publish step for resumable lockstep releases -> Add verify-publish job and skip-if-already-published npm publish step for resumable lockstep releases (traj_tklpxq0u1yhz)
- Bound npm reruns to build tarball integrity and annotated tag provenance -> Bound npm reruns to build tarball integrity and annotated tag provenance (traj_tklpxq0u1yhz)

## Other

- Extended the existing release-workflow trajectory for the 8.6.0 hardening follow-up -> Extended the existing release-workflow trajectory for the 8.6.0 hardening follow-up (traj_tklpxq0u1yhz)
- Extend release-contract.mjs version parity to Dockerfile ARG, docker/package.json+lock, and RUNBOOK.md anchors -> Extend release-contract.mjs version parity to Dockerfile ARG, docker/package.json+lock, and RUNBOOK.md anchors (traj_tklpxq0u1yhz)
- Pinned new container-integration actions to immutable reviewed SHAs -> Pinned new container-integration actions to immutable reviewed SHAs (traj_tklpxq0u1yhz)

## Database

- Rebase fix/workspace-create-idempotency-0908 onto origin/main (4581ef38, v8.5.4 + #388) before implementing repair-review fixes -> Rebase fix/workspace-create-idempotency-0908 onto origin/main (4581ef38, v8.5.4 + #388) before implementing repair-review fixes (traj_tklpxq0u1yhz)

## Key Learnings

- None

## Key Findings

- None
