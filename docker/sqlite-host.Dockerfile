# syntax=docker/dockerfile:1.7

# Prototype: relaycast workspaces as single-writer SQLite files with a
# synchronous S3 (Express) commit log, and the router in front of them
# (packages/sqlite-host). One image; the first argument picks the mode:
#   docker build -f docker/sqlite-host.Dockerfile -t relaycast-sqlite-host .
#   docker run relaycast-sqlite-host host | router
FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/a2a/package.json packages/a2a/tsconfig.json ./packages/a2a/
COPY packages/a2a/src ./packages/a2a/src
COPY packages/types/package.json packages/types/tsconfig.json ./packages/types/
COPY packages/types/src ./packages/types/src
COPY packages/engine/package.json packages/engine/tsconfig.json ./packages/engine/
COPY packages/engine/src ./packages/engine/src
COPY packages/sqlite-host/package.json packages/sqlite-host/tsconfig.json ./packages/sqlite-host/
COPY packages/sqlite-host/src ./packages/sqlite-host/src
RUN npm ci --ignore-scripts --no-audit --no-fund \
  && npm run --workspace @relaycast/a2a build \
  && npm run --workspace @relaycast/types build \
  && npm run --workspace @relaycast/engine build \
  && npm run --workspace @relaycast/sqlite-host build

FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS install

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY --from=build /workspace/package.json /workspace/package-lock.json ./
COPY --from=build /workspace/packages/a2a/package.json ./packages/a2a/
COPY --from=build /workspace/packages/a2a/dist ./packages/a2a/dist
COPY --from=build /workspace/packages/types/package.json ./packages/types/
COPY --from=build /workspace/packages/types/dist ./packages/types/dist
COPY --from=build /workspace/packages/engine/package.json ./packages/engine/
COPY --from=build /workspace/packages/engine/dist ./packages/engine/dist
COPY --from=build /workspace/packages/sqlite-host/package.json ./packages/sqlite-host/
COPY --from=build /workspace/packages/sqlite-host/dist ./packages/sqlite-host/dist
# Only better-sqlite3 runs its install script (the native addon the host opens).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
      --workspace @relaycast/sqlite-host --include-workspace-root=false \
  && npm rebuild better-sqlite3 --ignore-scripts=false \
  && node -e "const D=require('better-sqlite3'); new D(':memory:').prepare('select 1').get()" \
  && mkdir -p /opt/relaycast/node_modules/@relaycast \
  && cp -R node_modules/. /opt/relaycast/node_modules/ \
  && for pkg in a2a types engine sqlite-host; do \
       rm -rf "/opt/relaycast/node_modules/@relaycast/$pkg" \
       && cp -R "packages/$pkg" "/opt/relaycast/node_modules/@relaycast/$pkg"; \
     done \
  && npm cache clean --force

FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

LABEL org.opencontainers.image.title="Relaycast SQLite workspace host (prototype)" \
      org.opencontainers.image.description="Single-writer SQLite per workspace with a synchronous S3 Express commit log, and its router" \
      org.opencontainers.image.source="https://github.com/AgentWorkforce/relaycast"

ENV NODE_ENV=production \
    PORT=8080 \
    SQLITE_HOST_DATA_DIR=/data

COPY --from=install /opt/relaycast /opt/relaycast
RUN install -d -o node -g node /data

WORKDIR /data
EXPOSE 8080
USER node

ENTRYPOINT ["node", "/opt/relaycast/node_modules/@relaycast/sqlite-host/dist/bin.js"]
CMD ["host"]
