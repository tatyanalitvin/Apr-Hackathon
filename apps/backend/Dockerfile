# apps/backend/Dockerfile — Fastify backend (runs via tsx for the hackathon).
# Build context is repo root (see docker-compose.yml).

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --prod=false --no-frozen-lockfile

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY . .
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 app \
  && mkdir -p /data/uploads && chown -R app:nodejs /data /app
USER app
WORKDIR /app/apps/backend
EXPOSE 4000
CMD ["pnpm", "start"]
