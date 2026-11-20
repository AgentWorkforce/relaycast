#!/usr/bin/env bash
# Start a disposable PostgreSQL 16 fixture in Docker for the engine's
# PostgreSQL integration tests and the conformance suite in PostgreSQL mode.
#
#   up.sh [cert-dir] [env-file]
#
# cert-dir  where the throwaway CA and server certificate go (default: mktemp)
# env-file  where the test environment is written (default: ./pg-fixture.env)
#
# The port is published on 127.0.0.1 and on PG_FIXTURE_ALT_HOST (default
# 127.0.0.2): the integration tests connect to 127.0.0.2 to prove that a host
# outside the certificate's SAN is refused. Set PG_FIXTURE_ALT_HOST= (empty)
# where 127.0.0.2 is not a local address (e.g. macOS); that one test then fails.
#
# Then: source the env file and run the tests from packages/engine. Stop the
# fixture with down.sh. Dev-only: the role passwords come from bootstrap.sql
# and are not secrets. The URLs are written only to the env file.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
container="${PG_FIXTURE_CONTAINER:-relaycast-pg-fixture}"
port="${PG_FIXTURE_PORT:-55432}"
image="${PG_FIXTURE_IMAGE:-postgres:16}"
alt_host="${PG_FIXTURE_ALT_HOST-127.0.0.2}"
cert_dir="${1:-}"
env_file="${2:-./pg-fixture.env}"

# Dev fixture values (see bootstrap.sql); not secrets.
superuser_password="platform-fixture-password"
owner_password="owner-fixture-password"
runtime_password="runtime-fixture-password"

if [[ -z "$cert_dir" ]]; then
  cert_dir="$(mktemp -d "${TMPDIR:-/tmp}/relaycast-pg-certs.XXXXXX")"
fi
mkdir -p "$cert_dir"
cert_dir="$(cd "$cert_dir" && pwd)"

echo "Generating a throwaway CA and server certificate in $cert_dir"
(
  umask 077
  cd "$cert_dir"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -subj "/CN=relaycast-pg-fixture-ca" \
    -keyout ca.key -out ca.crt 2>/dev/null
  openssl req -newkey rsa:2048 -nodes \
    -subj "/CN=localhost" \
    -keyout server.key -out server.csr 2>/dev/null
  printf '%s\n' \
    "basicConstraints=CA:FALSE" \
    "keyUsage=digitalSignature,keyEncipherment" \
    "extendedKeyUsage=serverAuth" \
    "subjectAltName=DNS:localhost,IP:127.0.0.1" >san.ext
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -days 1 -extfile san.ext -out server.crt 2>/dev/null
  rm -f server.csr ca.srl
)

if docker container inspect "$container" >/dev/null 2>&1; then
  echo "Removing existing container $container"
  docker rm --force --volumes "$container" >/dev/null
fi

# The mounted files belong to the host user. As root inside the container,
# copy them to /certs owned by postgres (uid 999) with the key at mode 600,
# then hand over to the stock entrypoint, which drops to postgres.
publish=(-p "127.0.0.1:${port}:5432")
if [[ -n "$alt_host" ]]; then
  publish+=(-p "${alt_host}:${port}:5432")
fi
echo "Starting $container ($image) on 127.0.0.1:$port"
docker run -d --name "$container" \
  "${publish[@]}" \
  -e POSTGRES_USER=platform \
  -e POSTGRES_PASSWORD="$superuser_password" \
  -e POSTGRES_DB=app \
  -v "$cert_dir/ca.crt:/tls/ca.crt:ro" \
  -v "$cert_dir/server.crt:/tls/server.crt:ro" \
  -v "$cert_dir/server.key:/tls/server.key:ro" \
  -v "$script_dir/bootstrap.sql:/docker-entrypoint-initdb.d/00-bootstrap.sql:ro" \
  --entrypoint sh \
  "$image" -c '
    set -e
    mkdir -p /certs
    cp /tls/ca.crt /tls/server.crt /tls/server.key /certs/
    chown 999:999 /certs/ca.crt /certs/server.crt /certs/server.key
    chmod 600 /certs/server.key
    exec docker-entrypoint.sh postgres \
      -c ssl=on \
      -c ssl_cert_file=/certs/server.crt \
      -c ssl_key_file=/certs/server.key \
      -c ssl_ca_file=/certs/ca.crt \
      -c max_connections=200
  ' >/dev/null

# The entrypoint runs the bootstrap on a socket-only server and then restarts,
# so wait for a verify-full TLS login as relaycast_owner over TCP.
echo "Waiting for PostgreSQL (TLS login as relaycast_owner)"
deadline=$((SECONDS + 90))
until docker exec -e PGPASSWORD="$owner_password" "$container" \
  psql "host=localhost port=5432 dbname=app user=relaycast_owner sslmode=verify-full sslrootcert=/certs/ca.crt" \
  -tAc 'SELECT 1' >/dev/null 2>&1; do
  if ! docker container inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true; then
    echo "Container $container is not running" >&2
    docker logs "$container" >&2 || true
    exit 1
  fi
  if ((SECONDS >= deadline)); then
    echo "PostgreSQL did not accept a TLS login within 90 seconds" >&2
    docker logs "$container" >&2 || true
    exit 1
  fi
  sleep 1
done

base="localhost:${port}/app?sslmode=verify-full"
owner_url="postgres://relaycast_owner:${owner_password}@${base}"
runtime_url="postgres://relaycast_runtime:${runtime_password}@${base}"
ca_file="$cert_dir/ca.crt"

mkdir -p "$(dirname "$env_file")"
(
  umask 077
  {
    echo "# relaycast PostgreSQL test fixture (dev-only values); written by up.sh"
    printf 'export %s=%q\n' \
      RELAYCAST_PG_TEST_URL_OWNER "$owner_url" \
      RELAYCAST_PG_TEST_URL_RUNTIME "$runtime_url" \
      RELAYCAST_PG_TEST_CA_FILE "$ca_file" \
      RELAYCAST_TEST_DATABASE_URL "$runtime_url" \
      RELAYCAST_TEST_DATABASE_OWNER_URL "$owner_url" \
      RELAYCAST_TEST_DATABASE_CA_FILE "$ca_file" \
      PG_FIXTURE_CERT_DIR "$cert_dir" \
      PG_FIXTURE_CONTAINER "$container"
  } >"$env_file"
)
echo "PostgreSQL fixture is ready; environment written to $env_file"
