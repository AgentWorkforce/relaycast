#!/bin/sh
# Size the V8 heap from the container's memory limit, then exec the entrypoint.
#
# Node's default old-space limit is about half the container limit (~512 MB in
# a 1 Gi pod), so the process died of heap exhaustion with half its memory
# unused (relaycast#659). Use 75 % of the cgroup limit instead, leaving the
# rest for buffers, native memory and the code. An operator-supplied
# --max-old-space-size in NODE_OPTIONS wins; no limit (or none readable)
# leaves Node's default.
set -eu

cgroup_root="${RELAYCAST_CGROUP_ROOT:-/sys/fs/cgroup}"

limit=""
if [ -r "$cgroup_root/memory.max" ]; then
  limit="$(cat "$cgroup_root/memory.max")"
elif [ -r "$cgroup_root/memory/memory.limit_in_bytes" ]; then
  limit="$(cat "$cgroup_root/memory/memory.limit_in_bytes")"
fi

case "${NODE_OPTIONS:-}" in
  *--max-old-space-size*) ;;
  *)
    case "$limit" in
      ''|max|*[!0-9]*) ;;
      *)
        heap_mb=$((limit / 1048576 * 3 / 4))
        # cgroup v1 reports "unlimited" as a huge number; ignore anything
        # above 1 TiB, and never go below Node's own floor.
        if [ "$heap_mb" -ge 64 ] && [ "$heap_mb" -le 1048576 ]; then
          NODE_OPTIONS="--max-old-space-size=$heap_mb${NODE_OPTIONS:+ $NODE_OPTIONS}"
          export NODE_OPTIONS
        fi
        ;;
    esac
    ;;
esac

exec node /opt/relaycast/entrypoint.mjs "$@"
