# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app

# Copy package files first for better layer caching
# All workspace package.json files are needed for npm install to resolve the
# full workspace dependency graph, even if only server is built/deployed.
COPY package.json package-lock.json* ./
COPY packages/types/package.json packages/types/
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp/package.json packages/mcp/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/openclaw/package.json packages/openclaw/
COPY packages/react/package.json packages/react/
COPY packages/python-sdk/package.json packages/python-sdk/

# Install all dependencies (including devDependencies for building)
RUN npm install

# Copy source files
COPY tsconfig.base.json turbo.json ./
COPY packages/types/ packages/types/
COPY packages/sdk/ packages/sdk/
COPY packages/mcp/ packages/mcp/
COPY packages/server/ packages/server/

# Build the server and its dependencies
RUN npx turbo build --filter=@relaycast/server...

# Stage 2: Production
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Add a non-root user (Alpine BusyBox adduser/addgroup syntax)
RUN addgroup -S -g 1001 relay && \
    adduser -S -u 1001 -G relay relay

# Copy all workspace package.json files for production dependency install.
# npm ci validates the lockfile against the full workspace graph, so all
# packages referenced by "workspaces": ["packages/*"] must be present.
COPY package.json package-lock.json* ./
COPY packages/types/package.json packages/types/
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp/package.json packages/mcp/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/openclaw/package.json packages/openclaw/
COPY packages/react/package.json packages/react/
COPY packages/python-sdk/package.json packages/python-sdk/

# Install only production dependencies for the server and its workspace deps.
# This is more robust than copying node_modules from the builder, because npm
# resolves the full dependency tree correctly regardless of hoisting decisions.
RUN npm ci --omit=dev \
    --workspace=@relaycast/server \
    --workspace=@relaycast/types \
    --workspace=@relaycast/sdk \
    --workspace=@relaycast/mcp

# Copy built output
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/src/db/migrations ./packages/server/src/db/migrations
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=builder /app/packages/mcp/dist ./packages/mcp/dist

# Set ownership
RUN chown -R relay:relay /app

USER relay

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "packages/server/dist/index.js"]
