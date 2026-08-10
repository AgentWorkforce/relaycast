# syntax=docker/dockerfile:1.7

ARG RELAYCAST_ENGINE_VERSION=8.0.0

# Node 22.23.2, pinned to the multi-platform bookworm-slim index so the same
# Dockerfile resolves native linux/amd64 and linux/arm64 images.
FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS engine-install
ARG RELAYCAST_ENGINE_VERSION

# Build-only packages follow the pinned Bookworm base's security repository.
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/relaycast
COPY docker/package.json docker/package-lock.json ./

# The lockfile pins @relaycast/engine to 8.0.0 and the source-build setting
# exercises the C/C++ toolchain for better-sqlite3 on every target architecture.
ENV npm_config_build_from_source=true
RUN test "$(node -p "require('./package.json').dependencies['@relaycast/engine']")" = "$RELAYCAST_ENGINE_VERSION" \
  && npm ci --omit=dev --no-audit --no-fund \
  && node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.prepare('select 1').get(); db.close()" \
  && npm cache clean --force

FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
ARG RELAYCAST_ENGINE_VERSION

LABEL org.opencontainers.image.title="Relaycast self-host engine" \
      org.opencontainers.image.description="Single-process Relaycast engine with SQLite persistence" \
      org.opencontainers.image.source="https://github.com/AgentWorkforce/relaycast" \
      org.opencontainers.image.version="${RELAYCAST_ENGINE_VERSION}" \
      io.relaycast.engine.version="${RELAYCAST_ENGINE_VERSION}"

ENV NODE_ENV=production \
    PORT=8787 \
    RELAYCAST_DB_PATH=/data/relaycast.db \
    RELAYCAST_ENGINE_VERSION=${RELAYCAST_ENGINE_VERSION} \
    PATH=/opt/relaycast/node_modules/.bin:$PATH

COPY --from=engine-install /opt/relaycast /opt/relaycast
COPY --chmod=0555 docker/entrypoint.mjs docker/entrypoint-core.mjs /opt/relaycast/

RUN install -d -o node -g node /data /data/relaycast-files

WORKDIR /data
VOLUME ["/data"]
EXPOSE 8787
USER node

ENTRYPOINT ["node", "/opt/relaycast/entrypoint.mjs"]
