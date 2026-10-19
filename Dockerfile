# syntax=docker/dockerfile:1
# pve-panel: customer panel (3000) + admin interface (3001) in one small image.
# Pure JavaScript (no native modules), so it builds the same for amd64 and arm64.

FROM node:22-bookworm-slim

# Links the image on ghcr.io to its repository (also set by the CI workflow)
LABEL org.opencontainers.image.source="https://github.com/hawaianblue21/pve-panel" \
      org.opencontainers.image.description="Self-service control panel for Proxmox VE" \
      org.opencontainers.image.licenses="UNLICENSED"

ENV NODE_ENV=production \
    PANEL_IN_CONTAINER=1 \
    HOST=0.0.0.0 \
    ADMIN_HOST=0.0.0.0 \
    DB_PATH=/app/data/panel.db

WORKDIR /app

# Dependencies first (cached as long as package*.json don't change)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY docs ./docs

# Runs as the unprivileged "node" user; the database lives in a volume
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Version stamps last, so a new commit doesn't invalidate the cached layers above
# (set by .github/workflows/docker-publish.yml; "dev" when built by hand)
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ARG BUILD_DATE=
ENV PANEL_VERSION=$APP_VERSION \
    PANEL_COMMIT=$GIT_SHA \
    PANEL_BUILD_DATE=$BUILD_DATE

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
