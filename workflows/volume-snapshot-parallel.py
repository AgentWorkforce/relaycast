#!/usr/bin/env python3
"""
volume-snapshot-parallel.py
============================

A Python trajectory that implements the VOLUME SNAPSHOT PARALLEL pattern for
multi-agent work on a shared S3-backed FUSE code volume (e.g. Daytona workspaces).

WHY THIS PATTERN EXISTS
-----------------------
Daytona code volumes are S3-backed FUSE filesystems. Concurrent writes to the
*same file* from different agent processes are unsafe:
  - No POSIX advisory locking across processes
  - No atomic rename across FUSE mounts
  - Git operations (add/commit/push) are especially prone to data corruption
    when run in parallel by two processes in the same working tree

Safe for non-overlapping files only (each agent owns a disjoint set).
Unsafe when agents need to modify overlapping files or run git operations.

THE PATTERN
-----------
1. SNAPSHOT  — take a baseline `git stash` or `git worktree add` per worker
               so each has an isolated view of the repo
2. PARALLEL  — workers implement assigned tasks independently in their worktrees
3. DIFF      — each worker produces a `git diff HEAD` (patch file)
4. MERGE     — a single merge agent applies all patches sequentially, resolving
               conflicts with AI judgment
5. VALIDATE  — TypeScript compile + tests gate on the merged result

WHEN TO USE
-----------
- Parallel workers need to modify *overlapping* files (e.g. index.ts barrel exports,
  shared types, or the same config file)
- Workers must run `git commit` or `git add` as part of their task
- You want deterministic isolation: a worker's partial writes can't corrupt another's

WHEN NOT TO USE
---------------
- Workers have clearly disjoint file sets (no overlap) — use plain DAG instead
- Only 1-2 files to change — a single agent is simpler
- The repo is huge — worktree creation is O(repo size) if not using sparse checkout

USAGE
-----
  python3 .trajectories/volume-snapshot-parallel.py \
      --task "Add OAuth scopes to auth.ts and update the barrel export in index.ts" \
      --workers 3 \
      --channel wf-snapshot-parallel

Or import and call directly:
  from volume_snapshot_parallel import run_snapshot_workflow
  run_snapshot_workflow(task="...", workers=3)

The script generates a YAML workflow config and delegates to `agent-relay run`.
"""

import argparse
import subprocess
import sys
import textwrap
import uuid
import os
import tempfile
import yaml  # PyYAML — install with: pip install pyyaml


# ---------------------------------------------------------------------------
# Workflow generation
# ---------------------------------------------------------------------------

def build_workflow(task: str, num_workers: int, channel: str, run_id: str) -> dict:
    """
    Build a relay workflow dict for the snapshot-parallel pattern.

    Structure:
      Phase 0 (deterministic): read codebase context + create per-worker git worktrees
      Phase 1 (parallel agents): each worker implements in its own worktree
      Phase 2 (deterministic): collect diffs from all worktrees + verify they are non-empty
      Phase 3 (agent): merge agent applies all diffs sequentially, resolves conflicts
      Phase 4 (deterministic): TypeScript compile + optional test gate
      Phase 5 (agent): reviewer validates final merged state
    """

    agents = [
        {
            "name": "merge-agent",
            "cli": "claude",
            "role": "Applies git diffs from parallel workers, resolves conflicts, produces clean merged state",
            "preset": "worker",
        },
        {
            "name": "reviewer",
            "cli": "claude",
            "role": "Reviews the final merged result for correctness, types, and completeness",
            "preset": "reviewer",
        },
    ]

    # Add one codex worker per requested worker slot
    for i in range(1, num_workers + 1):
        agents.append({
            "name": f"worker-{i}",
            "cli": "codex",
            "role": f"Worker {i}: implements assigned subtask in isolated git worktree",
            "preset": "worker",
        })

    # ------------------------------------------------------------------ steps

    steps = []

    # ── Phase 0a: read context ──────────────────────────────────────────────
    steps.append({
        "name": "read-context",
        "type": "deterministic",
        "command": textwrap.dedent("""\
            echo "=== Repository structure (top-level) ==="
            ls -1
            echo ""
            echo "=== packages/core/src (first 60 lines) ==="
            find packages/core/src -name '*.ts' | head -40
            echo ""
            echo "=== packages/web/app (first 40 lines) ==="
            find packages/web/app -name '*.ts' -o -name '*.tsx' | head -40
        """),
        "captureOutput": True,
    })

    # ── Phase 0b: create per-worker worktrees ───────────────────────────────
    worktree_setup_cmds = [
        "BASE=$(git rev-parse HEAD)",
        "echo \"Baseline commit: $BASE\"",
    ]
    for i in range(1, num_workers + 1):
        wt_branch = f"snapshot-worker-{i}-{run_id[:8]}"
        wt_path = f"/tmp/wt-worker-{i}-{run_id[:8]}"
        worktree_setup_cmds += [
            f"git worktree add -b {wt_branch} {wt_path} HEAD 2>&1 && echo 'Created worktree worker-{i} at {wt_path}' || echo 'FAILED worktree worker-{i}'",
        ]
    worktree_setup_cmds.append("git worktree list")

    steps.append({
        "name": "setup-worktrees",
        "type": "deterministic",
        "dependsOn": ["read-context"],
        "command": "\n".join(worktree_setup_cmds),
        "captureOutput": True,
        "failOnError": True,
    })

    # ── Phase 0c: decompose task ─────────────────────────────────────────────
    # A deterministic prompt-injection step that asks a non-interactive claude
    # to split the overall task into N subtasks (one per worker).
    # We use output_contains verification so the step completes as soon as
    # the JSON block appears — no sentinel gymnastics needed.
    steps.append({
        "name": "decompose-task",
        "type": "agent",
        "agent": "merge-agent",    # reuse merge-agent for decomposition (it's just an analyst here)
        "dependsOn": ["setup-worktrees"],
        "task": textwrap.dedent(f"""\
            You are a task decomposition specialist. Split the following task into
            exactly {num_workers} subtasks, one per parallel worker. Workers operate
            in isolated git worktrees and cannot communicate — each subtask must be
            independently completable without relying on another worker's output.

            TASK:
            {task}

            CODEBASE CONTEXT:
            {{{{steps.read-context.output}}}}

            Respond with ONLY a JSON array of exactly {num_workers} strings, each
            being a complete, self-contained subtask description. No markdown fences,
            no explanation — just the raw JSON array.

            Example response format:
            ["Subtask 1 description", "Subtask 2 description"]
        """),
        "verification": {
            "type": "output_contains",
            "value": "[",   # JSON array start
        },
    })

    # ── Phase 1: parallel workers ────────────────────────────────────────────
    worker_step_names = []
    for i in range(1, num_workers + 1):
        wt_path = f"/tmp/wt-worker-{i}-{run_id[:8]}"
        step_name = f"worker-{i}-impl"
        worker_step_names.append(step_name)
        steps.append({
            "name": step_name,
            "type": "agent",
            "agent": f"worker-{i}",
            "dependsOn": ["decompose-task"],
            "task": textwrap.dedent(f"""\
                You are Worker {i} of {num_workers}. You have an isolated git worktree at:
                  {wt_path}

                ALL file edits MUST be made inside {wt_path}/, not in the current directory.
                cd to {wt_path} first.

                The overall task being parallelised:
                {task}

                Your specific subtask (Worker {i}):
                See the decompose-task output for the full list. Focus on subtask index {i-1}
                (0-based). The decomposed tasks were:
                {{{{steps.decompose-task.output}}}}

                Steps:
                1. cd {wt_path}
                2. Implement your subtask — edit files as needed
                3. Stage your changes: git add -A
                4. Commit with a descriptive message: git commit -m "worker-{i}: <description>"

                IMPORTANT:
                - Do NOT run git push
                - Do NOT modify files outside {wt_path}/
                - Write files to disk — do NOT just output code to stdout
                - Your commit is how your work gets merged; stage everything before committing
            """),
            "verification": {
                "type": "exit_code",
            },
        })

    # ── Phase 2: collect diffs ───────────────────────────────────────────────
    diff_cmds = []
    for i in range(1, num_workers + 1):
        wt_path = f"/tmp/wt-worker-{i}-{run_id[:8]}"
        diff_file = f"/tmp/worker-{i}-{run_id[:8]}.patch"
        diff_cmds += [
            f"echo '=== Worker {i} diff ==='",
            f"cd {wt_path} && git diff HEAD~1 HEAD > {diff_file} 2>&1",
            f"wc -l {diff_file} && head -5 {diff_file}",
            f"if [ ! -s {diff_file} ]; then echo 'WARNING: worker-{i} produced empty diff'; fi",
        ]

    steps.append({
        "name": "collect-diffs",
        "type": "deterministic",
        "dependsOn": worker_step_names,
        "command": "\n".join(diff_cmds),
        "captureOutput": True,
        "failOnError": False,   # non-fatal: empty diff = worker did nothing, merge agent will note it
    })

    # Also read patch files for injection into merge step
    read_patches_cmd_parts = []
    for i in range(1, num_workers + 1):
        diff_file = f"/tmp/worker-{i}-{run_id[:8]}.patch"
        read_patches_cmd_parts += [
            f"echo '\\n\\n=== PATCH worker-{i} ==='",
            f"cat {diff_file} 2>/dev/null || echo '(empty)'",
        ]

    steps.append({
        "name": "read-patches",
        "type": "deterministic",
        "dependsOn": ["collect-diffs"],
        "command": "\n".join(read_patches_cmd_parts),
        "captureOutput": True,
    })

    # ── Phase 3: merge ───────────────────────────────────────────────────────
    patch_apply_cmds = []
    for i in range(1, num_workers + 1):
        diff_file = f"/tmp/worker-{i}-{run_id[:8]}.patch"
        patch_apply_cmds += [
            f"echo '--- Applying worker-{i} patch ---'",
            f"if [ -s {diff_file} ]; then",
            f"  git apply --whitespace=fix {diff_file} 2>&1 || \\",
            f"  git apply --reject {diff_file} 2>&1 || \\",
            f"  echo 'CONFLICT: worker-{i} patch could not apply cleanly — see *.rej files'",
            f"else",
            f"  echo 'SKIP: worker-{i} produced empty patch'",
            f"fi",
        ]

    # Deterministic patch-apply first (fast path — works if no conflicts)
    steps.append({
        "name": "apply-patches-deterministic",
        "type": "deterministic",
        "dependsOn": ["read-patches"],
        "command": "\n".join(patch_apply_cmds),
        "captureOutput": True,
        "failOnError": False,
    })

    # AI merge agent to resolve any conflicts flagged above
    steps.append({
        "name": "merge-conflicts",
        "type": "agent",
        "agent": "merge-agent",
        "dependsOn": ["apply-patches-deterministic"],
        "task": textwrap.dedent(f"""\
            You are the merge agent. Parallel workers implemented parts of this task:
            {task}

            The patches they produced:
            {{{{steps.read-patches.output}}}}

            Patch application results (conflicts are flagged here):
            {{{{steps.apply-patches-deterministic.output}}}}

            Your job:
            1. Check for any *.rej files: find . -name '*.rej' 2>/dev/null
            2. For each conflict (.rej file), manually apply the rejected hunk to the
               target file using your best judgment about how to merge the changes
            3. Remove all *.rej files after resolving them
            4. Check for any merge markers (<<<<<<<, =======, >>>>>>>) in source files
               and resolve them
            5. Ensure barrel exports (index.ts files) include all new exports from
               all workers
            6. Stage all changes: git add -A
            7. Commit: git commit -m "merge: apply parallel worker patches"

            IMPORTANT:
            - Prioritize keeping all workers' intent intact
            - If two workers modified the same function, merge the changes additively
            - Write all edits to disk; do NOT just output code to stdout
        """),
        "verification": {
            "type": "exit_code",
        },
    })

    # ── Phase 4: validation gate ─────────────────────────────────────────────
    steps.append({
        "name": "validate-merged",
        "type": "deterministic",
        "dependsOn": ["merge-conflicts"],
        "command": textwrap.dedent("""\
            echo "=== TypeScript compile check ==="
            if [ -f packages/core/tsconfig.build.json ]; then
              cd packages/core && npx tsc -p tsconfig.build.json --noEmit 2>&1 | head -30
              cd ../..
            fi
            if [ -f packages/web/tsconfig.json ]; then
              cd packages/web && npx tsc -p tsconfig.json --noEmit 2>&1 | head -30
              cd ../..
            fi
            echo "=== No remaining conflict markers ==="
            if grep -rn '<<<<<<\\|=======\\|>>>>>>' --include='*.ts' --include='*.tsx' .; then
              echo "CONFLICT MARKERS FOUND — merge is incomplete"
              exit 1
            fi
            echo "=== No remaining .rej files ==="
            if find . -name '*.rej' | grep -q .; then
              echo "REJECTED HUNKS FOUND"
              find . -name '*.rej'
              exit 1
            fi
            echo "VALIDATION_PASSED"
        """),
        "captureOutput": True,
        "failOnError": True,
    })

    # ── Phase 5: reviewer ────────────────────────────────────────────────────
    steps.append({
        "name": "final-review",
        "type": "agent",
        "agent": "reviewer",
        "dependsOn": ["validate-merged"],
        "task": textwrap.dedent(f"""\
            Review the final merged result of the parallel implementation.

            Original task:
            {task}

            Validation output:
            {{{{steps.validate-merged.output}}}}

            Check:
            1. The merged code compiles (TypeScript errors would appear above)
            2. No conflict markers or .rej files remain
            3. The implementation addresses the full original task
            4. No worker's changes were accidentally dropped
            5. Barrel exports are complete and consistent

            If satisfactory: REVIEW_APPROVED
            If issues: REVIEW_ISSUES: <description>
        """),
        "verification": {
            "type": "output_contains",
            "value": "REVIEW_",
        },
    })

    # ── Phase 6: cleanup worktrees ───────────────────────────────────────────
    cleanup_cmds = []
    for i in range(1, num_workers + 1):
        wt_branch = f"snapshot-worker-{i}-{run_id[:8]}"
        wt_path = f"/tmp/wt-worker-{i}-{run_id[:8]}"
        cleanup_cmds += [
            f"git worktree remove --force {wt_path} 2>&1 || echo 'worktree {i} already gone'",
            f"git branch -D {wt_branch} 2>&1 || echo 'branch worker-{i} already deleted'",
        ]

    steps.append({
        "name": "cleanup",
        "type": "deterministic",
        "dependsOn": ["final-review"],
        "command": "\n".join(cleanup_cmds),
        "captureOutput": False,
        "failOnError": False,
    })

    # ------------------------------------------------------------------ assemble

    workflow = {
        "version": "1.0",
        "name": f"volume-snapshot-parallel-{run_id[:8]}",
        "description": (
            f"Volume snapshot parallel pattern: {num_workers} isolated workers, "
            f"patch collect, AI merge, validate. Task: {task[:80]}"
        ),
        "swarm": {
            "pattern": "dag",
            "maxConcurrency": min(num_workers + 2, 6),
            "timeoutMs": 1_800_000,
            "channel": channel,
        },
        "agents": agents,
        "workflows": [
            {
                "name": "snapshot-flow",
                "steps": steps,
            }
        ],
        "errorHandling": {
            "strategy": "fail-fast",
        },
    }

    return workflow


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def run_snapshot_workflow(
    task: str,
    workers: int = 3,
    channel: str | None = None,
    dry_run: bool = False,
) -> int:
    """
    Generate a snapshot-parallel YAML workflow and run it via `agent-relay run`.

    Returns the exit code of the `agent-relay run` process.
    """
    run_id = str(uuid.uuid4())
    if channel is None:
        channel = f"wf-snapshot-{run_id[:8]}"

    wf = build_workflow(task=task, num_workers=workers, channel=channel, run_id=run_id)

    # Write to a temp YAML file
    with tempfile.NamedTemporaryFile(
        mode="w",
        suffix=".yaml",
        prefix=f"snapshot-parallel-{run_id[:8]}-",
        delete=False,
    ) as f:
        yaml.dump(wf, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
        tmp_path = f.name

    print(f"[snapshot-parallel] Generated workflow: {tmp_path}", flush=True)
    print(f"[snapshot-parallel] run_id={run_id}  workers={workers}  channel={channel}", flush=True)
    print(f"[snapshot-parallel] task: {task[:120]}", flush=True)

    if dry_run:
        print("[snapshot-parallel] DRY RUN — workflow written but not executed")
        print(f"[snapshot-parallel] To run manually: agent-relay run {tmp_path}")
        with open(tmp_path) as f:
            print(f.read())
        return 0

    # Delegate to agent-relay run
    try:
        result = subprocess.run(
            ["agent-relay", "run", tmp_path],
            check=False,
        )
        return result.returncode
    finally:
        # Best-effort cleanup of the temp file
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--task",
        required=True,
        help="The overall task to distribute across parallel workers",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=3,
        help="Number of parallel worker agents (default: 3, max recommended: 5)",
    )
    parser.add_argument(
        "--channel",
        default=None,
        help="Relay channel name (auto-generated if omitted)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the generated YAML but do not run it",
    )

    args = parser.parse_args()

    if args.workers < 1 or args.workers > 8:
        print(f"ERROR: --workers must be between 1 and 8 (got {args.workers})", file=sys.stderr)
        sys.exit(1)

    exit_code = run_snapshot_workflow(
        task=args.task,
        workers=args.workers,
        channel=args.channel,
        dry_run=args.dry_run,
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
