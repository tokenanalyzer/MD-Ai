# MD AI backend — multi-stage build.
#
# Architecture-neutral by construction: every base image below
# (`node:24-bookworm-slim`) is an official multi-arch manifest, and no
# stage pins a specific platform, so the target architecture is decided
# entirely by the `--platform` flag passed to the build — this file itself
# does not hardcode one.
#
#   Oracle Ampere A1 (arm64), per docs/architecture/08-deployment-architecture.md §1:
#     docker buildx build --platform linux/arm64 -f infra/docker/backend.Dockerfile .
#
#   Google Cloud Run (amd64 required):
#     docker buildx build --platform linux/amd64 -f infra/docker/backend.Dockerfile .
#
# Either way, build from the repository root (this Dockerfile's COPY paths
# are relative to the monorepo root, since it needs pnpm-workspace.yaml and
# packages/shared-types alongside services/backend).

FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY services/backend/package.json services/backend/package.json
RUN pnpm install --frozen-lockfile --filter "@mdai/backend..."

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared-types packages/shared-types
COPY services/backend services/backend
RUN pnpm --filter @mdai/backend run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/services/backend/dist services/backend/dist
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/services/backend/node_modules services/backend/node_modules
COPY --from=deps /app/packages/shared-types packages/shared-types
WORKDIR /app/services/backend
EXPOSE 8080
CMD ["node", "dist/index.js"]
