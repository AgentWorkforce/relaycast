# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json* ./
COPY packages/types/package.json packages/types/
COPY packages/server/package.json packages/server/

# Install all dependencies (including devDependencies for building)
RUN npm install

# Copy source files
COPY tsconfig.base.json turbo.json ./
COPY packages/types/ packages/types/
COPY packages/server/ packages/server/

# Build the server and its dependencies
RUN npx turbo build --filter=@relaycast/server...

# Stage 2: Production
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Add a non-root user (Alpine BusyBox adduser/addgroup syntax)
RUN addgroup -S -g 1001 relay && \
    adduser -S -u 1001 -G relay relay

# Copy built output
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/
COPY --from=builder /app/packages/server/src/db/migrations ./packages/server/src/db/migrations
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/packages/types/package.json ./packages/types/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Set ownership
RUN chown -R relay:relay /app

USER relay

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "packages/server/dist/index.js"]
