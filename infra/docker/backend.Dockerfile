# MD AI backend — multi-stage, arm64-targeted build.
# docs/architecture/08-deployment-architecture.md §1: every image this
# project ships targets linux/arm64 (Oracle Ampere A1), built here via
# `docker buildx build --platform linux/arm64`.

FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY services/backend/package.json services/backend/package.json
RUN pnpm install --frozen-lockfile --filter "@mdai/backend..." || pnpm install --filter "@mdai/backend..."

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
