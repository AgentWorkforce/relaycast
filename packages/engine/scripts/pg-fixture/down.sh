#!/usr/bin/env bash
# Stop the PostgreSQL fixture started by up.sh and remove its certificates.
#
#   down.sh [cert-dir] [env-file]
#
# Without cert-dir, the directory recorded in env-file (default
# ./pg-fixture.env) is used. The env file itself is removed as well.
set -euo pipefail

cert_dir="${1:-}"
env_file="${2:-./pg-fixture.env}"
container="${PG_FIXTURE_CONTAINER:-relaycast-pg-fixture}"

if [[ -z "$cert_dir" && -f "$env_file" ]]; then
  cert_dir="$(
    # shellcheck disable=SC1090
    source "$env_file" && printf '%s' "${PG_FIXTURE_CERT_DIR:-}"
  )"
fi

if command -v docker >/dev/null 2>&1; then
  docker rm --force --volumes "$container" >/dev/null 2>&1 || true
fi

# Remove only the files up.sh writes, then the directory if it is empty.
if [[ -n "$cert_dir" && -d "$cert_dir" ]]; then
  rm -f "$cert_dir"/ca.crt "$cert_dir"/ca.key "$cert_dir"/ca.srl \
    "$cert_dir"/server.crt "$cert_dir"/server.key "$cert_dir"/server.csr \
    "$cert_dir"/san.ext
  rmdir "$cert_dir" 2>/dev/null || true
fi
rm -f "$env_file"
echo "PostgreSQL fixture stopped"
