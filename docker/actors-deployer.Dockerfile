# syntax=docker/dockerfile:1.7

# The relaycast Workspace actor deployer for a self-hosted durable-actors
# control plane: compiles the actor with the SDK compiler, uploads the bundle
# to the artifact bucket and registers it (packages/actors-workspace/README.md).
# Build from the repository root:
#   docker build -f docker/actors-deployer.Dockerfile -t relaycast-actors-deployer .
#
# Node 22.23.2, pinned to the same multi-platform bookworm-slim index as the
# self-host engine image (Dockerfile at the repository root): npm owns the
# workspace install (the root package-lock.json is npm's), Bun only runs the
# deployer, because the durable-actors SDK compiler targets Bun.
FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build

WORKDIR /workspace
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/a2a/package.json packages/a2a/tsconfig.json ./packages/a2a/
COPY packages/a2a/src ./packages/a2a/src
COPY packages/types/package.json packages/types/tsconfig.json ./packages/types/
COPY packages/types/src ./packages/types/src
COPY packages/engine/package.json packages/engine/tsconfig.json ./packages/engine/
COPY packages/engine/src ./packages/engine/src
COPY packages/actors-workspace/package.json packages/actors-workspace/tsconfig.json ./packages/actors-workspace/
# --ignore-scripts: the engine's better-sqlite3 addon is never built or
# loaded; the compiler only reads the engine's sources and types. The engine
# is built because the actor imports `@relaycast/engine/adapters/actor`,
# whose `exports` point at dist/.
RUN npm ci --ignore-scripts --no-audit --no-fund \
  && npm run --workspace @relaycast/a2a build \
  && npm run --workspace @relaycast/types build \
  && npm run --workspace @relaycast/engine build

# A production-only install of the actor package and its workspace
# dependencies (durable-actors brings its own typescript and esbuild), kept in
# npm's workspace layout so `durable-actors/host` and `@relaycast/engine`
# resolve from /opt/relaycast/node_modules exactly as in the checkout.
FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS install

WORKDIR /opt/relaycast
COPY --from=build /workspace/package.json /workspace/package-lock.json ./
COPY --from=build /workspace/packages/a2a/package.json ./packages/a2a/
COPY --from=build /workspace/packages/a2a/dist ./packages/a2a/dist
COPY --from=build /workspace/packages/types/package.json ./packages/types/
COPY --from=build /workspace/packages/types/dist ./packages/types/dist
COPY --from=build /workspace/packages/engine/package.json ./packages/engine/
COPY --from=build /workspace/packages/engine/dist ./packages/engine/dist
COPY --from=build /workspace/packages/actors-workspace/package.json /workspace/packages/actors-workspace/tsconfig.json ./packages/actors-workspace/
COPY packages/actors-workspace/src ./packages/actors-workspace/src
COPY packages/actors-workspace/deploy ./packages/actors-workspace/deploy
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
      --workspace @relaycast/actors-workspace --include-workspace-root=false \
  && rm -rf packages/actors-workspace/deploy/__tests__ \
  && npm cache clean --force

# Bun 1.4 (the SDK pins bun@1.4.2 as its package manager), pinned to the
# multi-platform index digest of `oven/bun:1.4` (`docker buildx imagetools
# inspect oven/bun:1.4`); bump the digest together with the tag.
FROM oven/bun:1.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d

LABEL org.opencontainers.image.title="Relaycast actors deployer" \
      org.opencontainers.image.description="Compiles the relaycast Workspace actor and registers it with a self-hosted durable-actors control plane" \
      org.opencontainers.image.source="https://github.com/AgentWorkforce/relaycast"

ENV NODE_ENV=production

COPY --from=install --chown=bun:bun /opt/relaycast /opt/relaycast

# The compiler writes its temporary build under $TMPDIR; nothing else is written.
WORKDIR /opt/relaycast/packages/actors-workspace
USER bun

ENTRYPOINT ["bun", "/opt/relaycast/packages/actors-workspace/deploy/deploy.ts"]
