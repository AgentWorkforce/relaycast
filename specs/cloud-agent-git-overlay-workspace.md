# Cloud-agent git-overlay workspace source

## Goal

`git-overlay` combines the fast startup path of direct Git workspaces with the
bidirectional Relayfile mount used by normal cloud-agent workspaces:

1. Clone the requested Git remote into the sandbox workspace path.
2. Start `relayfile-mount` with `/workspace` in scope and `localDir:
   "/workspace"`.
3. Let the existing Relayfile conflict policy decide how local and sandbox
   writes reconcile.

The cloud agent sees `/workspace` as a Git working tree, so normal commands such
as `git status`, `git commit`, and `git push` keep working after attach.

## Strategy

This implementation uses the simple overlay strategy: clone first, then mount
Relayfile at the workspace path. The mount daemon starts after the clone so its
initial reconciliation has a populated Git checkout to merge with the Relayfile
workspace.

The trade-off is that steady-state reads go through the Relayfile FUSE mount,
matching normal `relayfile` mode rather than a lower-level overlayfs design.
That keeps the runtime model and conflict handling identical to the existing
live-sync path and avoids another sandbox-specific filesystem layer. A future
subtree or overlayfs mode can optimize hot reads if profiling shows this path is
too slow for large repositories.

## Mode differences

| Source kind | Clone first | Sandbox mount paths | Mount localDir | Live workspace sync |
| --- | --- | --- | --- | --- |
| `relayfile` | No | `/workspace` plus integrations | `/workspace` | Yes |
| `git` | Yes | `/integrations/**` only | `/` | No workspace sync |
| `git-overlay` | Yes | `/workspace` plus integrations | `/workspace` | Yes |

Direct `git` remains restricted to integration mount paths so it cannot
accidentally hide the cloned working tree. `git-overlay` is the mode that
intentionally mounts Relayfile on top of `/workspace`.
