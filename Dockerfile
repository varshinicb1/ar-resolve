# AR Resolve production image (ADR 0090). Multi-stage: the UI is built with dev dependencies in the
# first stage; the runtime stage has no node_modules at all (the server uses only Node built-ins and
# runs TypeScript directly through Node's type stripping, Node >= 22.18).
#
# Pin NODE_IMAGE to a digest for reproducible builds, e.g.
#   docker build --build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:<digest> .
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
# Optional extra CA for builds behind a TLS-inspecting proxy (never copied into the image):
#   docker build --secret id=extra_ca,src=/path/to/ca.pem .
RUN --mount=type=secret,id=extra_ca \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
# Fail closed by default: the image runs as production and refuses to start until configured.
# Set AR_ENV=synthetic explicitly for a demo container.
ENV NODE_ENV=production \
    AR_ENV=production \
    PORT=8080 \
    AR_DB=/data/ar-resolve.db \
    AR_BACKUP_DIR=/backups \
    SQLITE_TMPDIR=/tmp
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY knowledge ./knowledge
COPY evaluation ./evaluation
COPY fixtures ./fixtures
COPY scripts/backup.ts scripts/restore.ts scripts/admin.ts ./scripts/
COPY --from=build /src/web/dist ./web/dist
# Application files stay root-owned and read-only to the runtime user; only the volumes are writable.
RUN mkdir -p /data /backups && chown node:node /data /backups && chmod 0700 /data /backups
USER node
EXPOSE 8080
VOLUME ["/data", "/backups"]
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.ts"]
