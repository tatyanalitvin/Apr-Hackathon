# apps/web/Dockerfile — Next.js 15 production build.
# Build context is repo root (see docker-compose.yml).

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/backend/package.json apps/backend/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --prod=false --no-frozen-lockfile

FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm --filter @ai-herders/web build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder --chown=app:nodejs /app/apps/web ./apps/web
USER app
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["pnpm", "start"]
