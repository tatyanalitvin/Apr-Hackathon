# Multi-stage build for Next.js + custom Socket.IO server
FROM node:20-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile
RUN pnpm prisma generate

FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm prisma generate
RUN pnpm build

FROM node:20-alpine AS runner
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 app
COPY --from=builder /app/public ./public
COPY --from=builder --chown=app:nodejs /app/.next ./.next
COPY --from=builder --chown=app:nodejs /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
# Create uploads dir with correct owner
RUN mkdir -p /data/uploads && chown -R app:nodejs /data
USER app
EXPOSE 3000
CMD ["sh", "-c", "pnpm prisma migrate deploy && node dist/server.js"]
