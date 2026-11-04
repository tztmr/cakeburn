FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json .npmrc ./
RUN npm ci --include=dev

FROM dependencies AS builder
ARG SITE_URL=""
ENV CAKEBURN_SERVER=1 SITE_URL=${SITE_URL}
COPY . .
RUN npm run build:server

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 CAKEBURN_SERVER=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=builder --chown=node:node /app/.next/standalone ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health', {signal: AbortSignal.timeout(4000)}).then(async r => { if (!r.ok || (await r.json()).service !== 'cakeburn') process.exit(1); }).catch(() => process.exit(1))"
CMD ["node", "server.js"]
