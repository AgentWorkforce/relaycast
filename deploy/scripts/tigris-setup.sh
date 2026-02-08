#!/bin/bash
set -euo pipefail

echo "=== Tigris Object Storage Setup ==="

BUCKET_NAME="${TIGRIS_BUCKET:-relay-files}"

if [ -z "${TIGRIS_ACCESS_KEY:-}" ] || [ -z "${TIGRIS_SECRET_KEY:-}" ]; then
  echo "ERROR: TIGRIS_ACCESS_KEY and TIGRIS_SECRET_KEY must be set"
  exit 1
fi

ENDPOINT="${TIGRIS_ENDPOINT:-https://fly.storage.tigris.dev}"

echo "Setting up bucket: $BUCKET_NAME"
echo "Endpoint: $ENDPOINT"

# Use AWS CLI or mc (MinIO client) to create bucket
if command -v aws &> /dev/null; then
  aws s3 mb "s3://$BUCKET_NAME" \
    --endpoint-url "$ENDPOINT" \
    2>/dev/null || echo "Bucket may already exist"
  echo "Bucket setup complete."
elif command -v mc &> /dev/null; then
  mc alias set tigris "$ENDPOINT" "$TIGRIS_ACCESS_KEY" "$TIGRIS_SECRET_KEY"
  mc mb "tigris/$BUCKET_NAME" --ignore-existing
  echo "Bucket setup complete."
else
  echo "WARNING: Neither aws CLI nor mc (MinIO client) found."
  echo "Please install one and re-run, or create the bucket manually."
  exit 1
fi

echo "=== Tigris setup complete ==="
