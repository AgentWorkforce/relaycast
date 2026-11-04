# syntax=docker/dockerfile:1.7

# The relaycast gateway in front of `Workspace` actors on durable-actors.
# Build from the repository root:
#   docker build -f docker/actors-gateway.Dockerfile -t relaycast-actors-gateway .
#
# Node 22.23.2, pinned to the same multi-platform bookworm-slim index as the
# self-host engine image (Dockerfile at the repository root).
FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build

WORKDIR /workspace
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/a2a/package.json packages/a2a/tsconfig.json ./packages/a2a/
COPY packages/a2a/src ./packages/a2a/src
COPY packages/types/package.json packages/types/tsconfig.json ./packages/types/
COPY packages/types/src ./packages/types/src
COPY packages/engine/package.json packages/engine/tsconfig.json ./packages/engine/
COPY packages/engine/src ./packages/engine/src
COPY packages/actors-gateway/package.json packages/actors-gateway/tsconfig.json ./packages/actors-gateway/
COPY packages/actors-gateway/src ./packages/actors-gateway/src
# --ignore-scripts: the engine's better-sqlite3 addon is never built or loaded
# by the gateway, which opens no database.
RUN npm ci --ignore-scripts --no-audit --no-fund \
  && npm run --workspace @relaycast/a2a build \
  && npm run --workspace @relaycast/types build \
  && npm run --workspace @relaycast/engine build \
  && npm run --workspace @relaycast/actors-gateway build

# A production-only install of the gateway and its workspace dependencies:
# the built packages are copied in as plain directories (no symlinks), so the
# runtime image carries one pruned node_modules under /opt/relaycast.
FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS install

WORKDIR /workspace
COPY --from=build /workspace/package.json /workspace/package-lock.json ./
COPY --from=build /workspace/packages/a2a/package.json ./packages/a2a/
COPY --from=build /workspace/packages/a2a/dist ./packages/a2a/dist
COPY --from=build /workspace/packages/types/package.json ./packages/types/
COPY --from=build /workspace/packages/types/dist ./packages/types/dist
COPY --from=build /workspace/packages/engine/package.json ./packages/engine/
COPY --from=build /workspace/packages/engine/dist ./packages/engine/dist
COPY --from=build /workspace/packages/actors-gateway/package.json ./packages/actors-gateway/
COPY --from=build /workspace/packages/actors-gateway/dist ./packages/actors-gateway/dist
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
      --workspace @relaycast/actors-gateway --include-workspace-root=false \
  && mkdir -p /opt/relaycast/node_modules/@relaycast \
  && cp -R node_modules/. /opt/relaycast/node_modules/ \
  && for pkg in a2a types engine actors-gateway; do \
       rm -rf "/opt/relaycast/node_modules/@relaycast/$pkg" \
       && cp -R "packages/$pkg" "/opt/relaycast/node_modules/@relaycast/$pkg"; \
     done \
  && printf '%s\n' "import '@relaycast/actors-gateway/bin';" > /opt/relaycast/gateway.mjs \
  && npm cache clean --force

FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

LABEL org.opencontainers.image.title="Relaycast actors gateway" \
      org.opencontainers.image.description="Stateless gateway in front of relaycast Workspace actors on durable-actors" \
      org.opencontainers.image.source="https://github.com/AgentWorkforce/relaycast"

ENV NODE_ENV=production \
    PORT=8787 \
    RELAYCAST_FILE_DIR=/data/files \
    RELAYCAST_FILE_STORE=local

COPY --from=install /opt/relaycast /opt/relaycast

RUN install -d -o node -g node /data /data/files

WORKDIR /data
VOLUME ["/data"]
EXPOSE 8787
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 8787}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["node", "/opt/relaycast/gateway.mjs"]
