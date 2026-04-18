# apps/web/Dockerfile — Next.js 15 production build.
# Build context is repo root (see docker-compose.yml).
#
# Notes:
# - `pnpm install` runs inside the builder stage (not only in deps) because
#   pnpm's workspace-local node_modules (apps/web/node_modules/.bin/next, etc.)
#   are lost when we `COPY . .` over the deps layer. Installing in-place after
#   the source is present keeps the hoisting and `.bin` symlinks consistent.
# - Runner copies the whole /app tree from builder so Next.js' runtime module
#   resolution (which follows pnpm's symlink graph) stays intact. No `output:
#   standalone` yet — we can slim this later once the build is stable.

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm install --prod=false --no-frozen-lockfile
RUN pnpm --filter @ai-herders/web build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 app
COPY --from=builder --chown=app:nodejs /app ./
USER app
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["pnpm", "start"]
