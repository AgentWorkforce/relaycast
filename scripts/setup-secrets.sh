#!/bin/bash

set -euo pipefail

# Required secrets for relay services
echo "Setting up relay secrets..."

# Shared JWT secret (used by both relayauth and relayfile)
# Generate a strong random secret
SECRET=$(openssl rand -base64 32)
sst secret set RelayJwtSecret "$SECRET"
echo "RelayJwtSecret configured."

echo "Set RELAYFILE_URL and RELAYAUTH_URL in .env if you need non-default service endpoints."
echo "Deploy with: sst deploy"
