# Drawer API. Build from the repo root:
#   docker build -f services/api/Dockerfile .
#
# No build step: Node 24 runs the .ts sources directly via type stripping, so the
# image is the workspace layout itself. That layout is load-bearing —
# src/migrate.ts resolves infra/db/migrations relative to its own path, and
# @drawer/shared must stay a symlink to packages/shared (Node refuses to strip
# types from files that resolve inside node_modules).
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Manifests first so the dependency layer caches across source edits. npm ci
# validates the lockfile against every workspace, so the mobile manifest comes
# along even though none of its dependencies are installed.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/api/package.json services/api/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --omit=dev --workspace @drawer/api --workspace @drawer/shared \
 && npm cache clean --force

COPY packages/shared/src packages/shared/src
COPY services/api/src services/api/src
COPY infra/db/migrations infra/db/migrations

USER node
WORKDIR /app/services/api
EXPOSE 8080
CMD ["node", "src/index.ts"]
